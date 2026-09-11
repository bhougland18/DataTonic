// Auto-arrange for the ER diagram.
//
// Deliberately NOT `canvas/layout.ts`. That one is a layered DAG layout: it
// ranks nodes by dependency depth with Kahn's algorithm and parks anything it
// cannot rank — i.e. anything in a cycle — in a single extra column. A pipeline
// is a DAG so that is exactly right there. An ER model is neither directed nor
// acyclic: Item–ItemLocation, Item–VendorItem and Vendor–VendorItem form a
// cycle in a perfectly ordinary four-table schema, and layering it by
// dependency would pile most of the tables into the parking column.
//
// So relationships are treated as UNDIRECTED here, and the graph is laid out by
// connection distance from each component's most-connected table: the hub on
// the left, its neighbours in the next column, and so on. Disconnected tables
// fall out as their own single-node components rather than needing a special
// case.
//
// Sizes are measured rather than assumed, the same way the canvas layout uses
// rendered widths — an ER node's height varies with its column count (capped at
// eight rows), so a fixed row pitch would either overlap tall nodes or waste
// space between short ones.

import type { ErdRelationship, ErdTable } from './model';

export interface NodeSize {
    width: number;
    height: number;
}
export interface Point {
    x: number;
    y: number;
}

const COL_GAP = 140; // empty space between columns
const ROW_GAP = 40; // empty space between stacked siblings
const COMPONENT_GAP = 80; // empty space between disconnected sub-graphs
const ORIGIN_X = 40;
const ORIGIN_Y = 40;
const DEFAULT_W = 230;
const DEFAULT_H = 180;

/** Undirected adjacency, ignoring self-joins and unknown tables. */
function adjacency(tables: ErdTable[], rels: ErdRelationship[]): Map<string, Set<string>> {
    const adj = new Map<string, Set<string>>();
    for (const t of tables) adj.set(t.name, new Set());
    for (const r of rels) {
        if (r.fromTable === r.toTable) continue;
        const a = adj.get(r.fromTable);
        const b = adj.get(r.toTable);
        if (!a || !b) continue;
        a.add(r.toTable);
        b.add(r.fromTable);
    }
    return adj;
}

/**
 * Position every table.
 *
 * Deterministic: the same model always lays out the same way, so pressing
 * arrange twice does not shuffle the diagram. Ties are broken by the table
 * order given, which is itself sorted upstream.
 */
export function layoutErd(
    tables: ErdTable[],
    relationships: ErdRelationship[],
    sizes?: Map<string, NodeSize>,
): Map<string, Point> {
    const out = new Map<string, Point>();
    if (tables.length === 0) return out;

    const adj = adjacency(tables, relationships);
    const sizeOf = (name: string): NodeSize => {
        const s = sizes?.get(name);
        return {
            width: s?.width && s.width > 0 ? s.width : DEFAULT_W,
            height: s?.height && s.height > 0 ? s.height : DEFAULT_H,
        };
    };

    const unplaced = new Set(tables.map(t => t.name));
    let componentTop = ORIGIN_Y;

    while (unplaced.size > 0) {
        // Start each component at its most-connected member, so the table
        // everything hangs off sits on the left rather than wherever it
        // happened to appear in the list.
        let root = '';
        let best = -1;
        for (const name of tables.map(t => t.name)) {
            if (!unplaced.has(name)) continue;
            const deg = adj.get(name)?.size ?? 0;
            if (deg > best) {
                best = deg;
                root = name;
            }
        }

        // Breadth-first, so a node's column is its distance from the hub.
        const columns: string[][] = [];
        let frontier = [root];
        const seen = new Set([root]);
        unplaced.delete(root);
        while (frontier.length > 0) {
            columns.push(frontier);
            const next: string[] = [];
            for (const name of frontier) {
                for (const n of adj.get(name) ?? []) {
                    if (seen.has(n)) continue;
                    seen.add(n);
                    unplaced.delete(n);
                    next.push(n);
                }
            }
            frontier = next;
        }

        // Place: each column's x is the previous column's x plus that column's
        // widest node, so a wide table pushes later columns right instead of
        // overlapping them. Columns are centred against the tallest one.
        const colHeights = columns.map(col =>
            col.reduce((h, n) => h + sizeOf(n).height, 0) + ROW_GAP * Math.max(0, col.length - 1),
        );
        const tallest = Math.max(...colHeights, 0);

        let x = ORIGIN_X;
        columns.forEach((col, i) => {
            const colWidth = col.reduce((w, n) => Math.max(w, sizeOf(n).width), DEFAULT_W);
            let y = componentTop + (tallest - colHeights[i]) / 2;
            for (const name of col) {
                out.set(name, { x, y });
                y += sizeOf(name).height + ROW_GAP;
            }
            x += colWidth + COL_GAP;
        });

        componentTop += tallest + COMPONENT_GAP;
    }

    return out;
}
