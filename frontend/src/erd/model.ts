// ERD model (DataTonic, SE-11).
//
// The entity-relationship model is authored on the Working DB node (`erdModel`
// prop) and inherited read-only by downstream SQL Studio nodes. This module is
// the single, framework-free definition of the model plus the auto-inference
// heuristic — no React / xyflow / app imports, so both the Working DB authoring
// UI and the Studio can depend on it.

export interface ErdColumn {
    name: string;
    type?: string;
    nullable?: boolean;
    primaryKey?: boolean;
}

export interface ErdTable {
    name: string;
    columns: ErdColumn[];
}

export interface ErdRelationship {
    id: string;
    fromTable: string;
    fromColumn: string;
    toTable: string;
    toColumn: string;
    // Coarse cardinality hint for the diagram/AI; refined on the Working DB.
    cardinality?: '1-1' | '1-n' | 'n-1' | 'n-n';
    // True while the relationship is only a name/type guess (not yet confirmed
    // by the user on the Working DB node). The AI + diagram still use it.
    inferred?: boolean;
}

export interface ErdModel {
    tables: ErdTable[];
    relationships: ErdRelationship[];
}

// A minimal table shape the inference accepts (SqlStudioTable satisfies it too).
type TableLike = { name: string; columns: { name: string; type?: string }[] };

const norm = (s: string) => s.trim().toLowerCase();

// Auto-infer candidate relationships by the classic foreign-key-by-name rule:
// a column whose name matches another table's name references that table (e.g.
// VendorItem.Item -> table Item). The referenced side is that table's
// same-named key column when present, else its first column. Every result is
// marked `inferred` for the user to confirm/prune on the Working DB. Conservative
// on purpose — it favours precision (few, sensible joins) over recall.
export function inferRelationships(tables: TableLike[]): ErdRelationship[] {
    const byName = new Map(tables.map(t => [norm(t.name), t]));
    const rels: ErdRelationship[] = [];
    const seen = new Set<string>();

    for (const t of tables) {
        for (const col of t.columns) {
            const target = byName.get(norm(col.name));
            if (!target || norm(target.name) === norm(t.name)) continue;
            // The key column on the referenced table: prefer a same-named column,
            // else the first column (best-effort — refined by the user later).
            const keyCol =
                target.columns.find(c => norm(c.name) === norm(col.name)) ?? target.columns[0];
            if (!keyCol) continue;
            // Dedupe unordered table pairs on the same column.
            const pair = [norm(t.name), norm(target.name)].sort().join('|') + '#' + norm(col.name);
            if (seen.has(pair)) continue;
            seen.add(pair);
            rels.push({
                id: `${target.name}.${keyCol.name}->${t.name}.${col.name}`,
                fromTable: target.name,
                fromColumn: keyCol.name,
                toTable: t.name,
                toColumn: col.name,
                cardinality: '1-n',
                inferred: true,
            });
        }
    }
    return rels;
}

// Infer the join(s) between exactly two tables — used when the user draws an
// edge table-to-table, so the correct key columns are chosen for them instead
// of whatever columns the drag happened to land on.
export function inferBetween(tables: TableLike[], a: string, b: string): ErdRelationship[] {
    const pair = tables.filter(t => t.name === a || t.name === b);
    return inferRelationships(pair);
}

// Build a model from tables, using a persisted model's relationships when
// present (so user edits on the Working DB survive) and inferring otherwise.
export function buildErdModel(tables: ErdTable[], persisted?: ErdModel | null): ErdModel {
    if (persisted && persisted.relationships && persisted.relationships.length > 0) {
        return { tables, relationships: persisted.relationships };
    }
    return { tables, relationships: inferRelationships(tables) };
}
