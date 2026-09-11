import { describe, expect, it } from 'vitest';
import { layoutErd } from './layout';
import type { ErdRelationship, ErdTable } from './model';

function table(name: string): ErdTable {
    return { name, columns: [{ name: 'k' }] };
}
function rel(a: string, b: string): ErdRelationship {
    return { id: `${a}->${b}`, fromTable: a, fromColumn: 'k', toTable: b, toColumn: 'k' };
}

describe('layoutErd', () => {
    it('places every table', () => {
        const tables = [table('A'), table('B'), table('C')];
        const out = layoutErd(tables, [rel('A', 'B')]);
        expect([...out.keys()].sort()).toEqual(['A', 'B', 'C']);
    });

    // The reason this is not canvas/layout.ts: an ER model is routinely cyclic,
    // and a dependency-ranked layout parks every cycle member in one column.
    it('lays out a cyclic model without piling it into one column', () => {
        const tables = [table('Item'), table('ItemLocation'), table('VendorItem'), table('Vendor')];
        const rels = [
            rel('Item', 'ItemLocation'),
            rel('Item', 'VendorItem'),
            rel('Vendor', 'VendorItem'),
            rel('ItemLocation', 'VendorItem'),
        ];
        const out = layoutErd(tables, rels);
        const xs = new Set([...out.values()].map(p => p.x));
        expect(xs.size).toBeGreaterThan(1);
    });

    // The hub is what everything hangs off; it belongs on the left rather than
    // wherever it happened to sit in the list.
    it('starts each component at its most-connected table', () => {
        const tables = [table('leaf1'), table('hub'), table('leaf2'), table('leaf3')];
        const rels = [rel('hub', 'leaf1'), rel('hub', 'leaf2'), rel('hub', 'leaf3')];
        const out = layoutErd(tables, rels);
        const hubX = out.get('hub')!.x;
        for (const leaf of ['leaf1', 'leaf2', 'leaf3']) {
            expect(out.get(leaf)!.x).toBeGreaterThan(hubX);
        }
    });

    // Disconnected tables are their own components, stacked below rather than
    // overlapping the connected graph.
    it('separates disconnected tables vertically', () => {
        const tables = [table('A'), table('B'), table('lonely')];
        const out = layoutErd(tables, [rel('A', 'B')]);
        const maxConnectedY = Math.max(out.get('A')!.y, out.get('B')!.y);
        expect(out.get('lonely')!.y).toBeGreaterThan(maxConnectedY);
    });

    it('does not overlap siblings sharing a column', () => {
        const tables = [table('hub'), table('a'), table('b')];
        const sizes = new Map([
            ['hub', { width: 200, height: 100 }],
            ['a', { width: 200, height: 100 }],
            ['b', { width: 200, height: 100 }],
        ]);
        const out = layoutErd(tables, [rel('hub', 'a'), rel('hub', 'b')], sizes);
        expect(Math.abs(out.get('a')!.y - out.get('b')!.y)).toBeGreaterThanOrEqual(100);
    });

    // A tall table must not be laid out as if it were short, or the node below
    // it overlaps — the reason sizes are measured rather than assumed.
    it('respects measured heights when stacking', () => {
        const tables = [table('hub'), table('tall'), table('short')];
        const sizes = new Map([
            ['hub', { width: 200, height: 100 }],
            ['tall', { width: 200, height: 400 }],
            ['short', { width: 200, height: 80 }],
        ]);
        const out = layoutErd(tables, [rel('hub', 'tall'), rel('hub', 'short')], sizes);
        const gap = Math.abs(out.get('short')!.y - out.get('tall')!.y);
        expect(gap).toBeGreaterThanOrEqual(400);
    });

    // Pressing arrange twice must not shuffle the diagram.
    it('is deterministic', () => {
        const tables = [table('A'), table('B'), table('C')];
        const rels = [rel('A', 'B'), rel('B', 'C')];
        expect(layoutErd(tables, rels)).toEqual(layoutErd(tables, rels));
    });

    it('ignores self-joins and relationships naming unknown tables', () => {
        const tables = [table('A'), table('B')];
        const rels = [rel('A', 'A'), rel('A', 'ghost')];
        const out = layoutErd(tables, rels);
        expect(out.size).toBe(2);
    });

    it('handles an empty model', () => {
        expect(layoutErd([], []).size).toBe(0);
    });
});
