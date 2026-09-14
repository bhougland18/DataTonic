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

/**
 * A constant predicate that qualifies a join, e.g. `MMDIST.source = 'RQ'`.
 *
 * Deliberately NOT modelled as "a side of the join may be a literal instead of
 * a column". That framing permits nonsense (literal = literal) and invites
 * arbitrary filters to be smuggled into the model. A relationship here is
 * always column-to-column; a qualifier is an ADDITIONAL predicate scoped to one
 * of the two tables — the discriminator on a polymorphic association, which is
 * exactly what an ERP's `source = 'RQ'` is.
 *
 * It belongs on the join rather than in a WHERE clause for two reasons. With an
 * outer join the two are NOT equivalent: in the ON clause unmatched rows
 * survive with NULLs, in a WHERE they are silently discarded, turning the outer
 * join into an inner one. And it is knowledge about the source system, worth
 * recording once next to the join it qualifies rather than remembered by
 * whoever writes each query.
 */
export interface ErdQualifier {
    /** Which side of the join this constrains. One of the join's two tables. */
    table: string;
    column: string;
    op: '=' | '<>';
    /** Always stored as text. Quoting is decided at render time by `numeric`. */
    value: string;
    /** Emit the value unquoted. Off by default because ERP codes that look
     *  numeric usually are not — `00123` is a string, and unquoting it would
     *  silently match `123` instead. */
    numeric?: boolean;
}

/**
 * Quote an identifier, but only when it is not already a plain one.
 *
 * Table names here are not always SQL-shaped: a file-derived dataset is called
 * `item_norm.parquet`, and unquoted that parses as schema `item_norm`, table
 * `parquet` — so `item_norm.parquet.Item` is not a mis-rendering, it is a
 * three-part name pointing at something that does not exist. Spaces, hyphens
 * and leading digits fail the same way.
 *
 * Quoting only when needed matters: DuckDB folds unquoted identifiers but
 * treats quoted ones as exact, so blanket-quoting would make every name
 * case-sensitive and break the ordinary ones.
 */
export function quoteIdent(name: string): string {
    return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

/** One qualifier as a SQL predicate, with the value safely quoted. */
export function qualifierSql(q: ErdQualifier): string {
    const n = Number(q.value);
    const lit =
        q.numeric && q.value.trim() !== '' && Number.isFinite(n)
            ? String(n)
            : `'${q.value.replace(/'/g, "''")}'`;
    return `${quoteIdent(q.table)}.${quoteIdent(q.column)} ${q.op} ${lit}`;
}

/** The full ON clause for a relationship: the key, plus any qualifiers. */
export function joinSql(r: ErdRelationship): string {
    const parts = [
        `${quoteIdent(r.fromTable)}.${quoteIdent(r.fromColumn)} = ` +
            `${quoteIdent(r.toTable)}.${quoteIdent(r.toColumn)}`,
    ];
    for (const q of r.qualifiers ?? []) parts.push(qualifierSql(q));
    return parts.join(' AND ');
}

export interface ErdRelationship {
    id: string;
    fromTable: string;
    fromColumn: string;
    toTable: string;
    toColumn: string;
    /** Constant predicates that qualify this join. See `ErdQualifier`. */
    qualifiers?: ErdQualifier[];
    // Coarse cardinality hint for the diagram/AI; refined on the Working DB.
    cardinality?: '1-1' | '1-n' | 'n-1' | 'n-n';
    // True while the relationship is only a name/type guess (not yet confirmed
    // by the user on the Working DB node). The AI + diagram still use it.
    inferred?: boolean;
}

export interface ErdModel {
    tables: ErdTable[];
    relationships: ErdRelationship[];
    /** Tables whose edges are not drawn. View state, but AUTHORED view state:
     *  deciding a derived table's joins are noise is a judgement worth keeping.
     *  Optional so older persisted models load unchanged. */
    hiddenRelations?: string[];
}

/** One step of a route through the model: a relationship, and the table it adds. */
export interface JoinHop {
    rel: ErdRelationship;
    /** The table this hop brings into scope. */
    joined: string;
}

/**
 * The shortest route from the tables already in hand to `target`.
 *
 * Breadth-first, so the answer uses the FEWEST joins. That is not only about
 * speed: every extra join is another chance to multiply rows, and a row count
 * nobody expected is the kind of wrong that reaches a client report.
 *
 * `[]` means the target is already there. `null` means the model does not
 * connect it — a real answer, not a failure, because without a relationship
 * there is no join anyone could honestly propose.
 *
 * Lives here rather than beside either caller: it is a walk over the ER graph
 * with no SQL in it, and both the builder (which wants relationship ids) and
 * the AI repair path (which wants JOIN clauses) need the same route.
 *
 * **Where two routes tie on length, this picks whichever the relationship list
 * reaches first, and that is not a judgement about the data.** Ben hit the case
 * live: `Item` to `Vendor` is two hops through `VendorItem` or through
 * `item_norm.parquet`, and the parquet won only because its relationship was
 * declared earlier — inflating a join from 370 rows to 518, because the derived
 * extract carries duplicate pairs.
 *
 * No tiebreak rule is applied here, deliberately. "Prefer database tables over
 * file extracts" is right in that case and wrong the moment somebody's
 * authoritative bridge IS a parquet. Instead `exclude` lets the CALLER rule a
 * route out, and the builder surfaces the choice rather than guessing it.
 */
export function relationshipPath(
    target: string,
    present: Iterable<string>,
    relationships: ErdRelationship[],
    /** Relationship ids the route may not pass through. */
    exclude?: Iterable<string>,
): JoinHop[] | null {
    const goal = target.toLowerCase();
    const have = new Set([...present].map(s => s.toLowerCase()));
    if (have.has(goal)) return [];

    const barred = new Set(exclude ?? []);
    const adj = new Map<string, { other: string; rel: ErdRelationship }[]>();
    const link = (a: string, b: string, rel: ErdRelationship) => {
        const k = a.toLowerCase();
        adj.set(k, [...(adj.get(k) ?? []), { other: b, rel }]);
    };
    // Undirected: a relationship is readable from either end.
    for (const r of relationships) {
        if (barred.has(r.id)) continue;
        link(r.fromTable, r.toTable, r);
        link(r.toTable, r.fromTable, r);
    }

    const prev = new Map<string, { from: string; rel: ErdRelationship; name: string }>();
    const seen = new Set(have);
    const queue = [...have];
    while (queue.length) {
        const cur = queue.shift() as string;
        if (cur === goal) break;
        for (const e of adj.get(cur) ?? []) {
            const k = e.other.toLowerCase();
            if (seen.has(k)) continue;
            seen.add(k);
            prev.set(k, { from: cur, rel: e.rel, name: e.other });
            queue.push(k);
        }
    }
    if (!prev.has(goal)) return null;

    const hops: JoinHop[] = [];
    for (let cur = goal; prev.has(cur); ) {
        const step = prev.get(cur) as { from: string; rel: ErdRelationship; name: string };
        hops.unshift({ rel: step.rel, joined: step.name });
        cur = step.from;
    }
    return hops;
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
/**
 * Reconcile a saved model with the tables actually present.
 *
 * Three tiers, and the order is the whole design: what was SAVED wins, then the
 * LIBRARY (knowledge carried in deliberately), then INFERENCE (a guess from
 * column names).
 *
 * Saved relationships are filtered to tables that still exist. Without that, a
 * model outlives its sources — a Working DB node whose upstream changes, or a
 * pipeline that stops writing a table, leaves edges pointing at nothing.
 *
 * The saved tier is all-or-nothing on purpose: if anything was authored, that
 * IS the model. Topping it up with inference would resurrect relationships the
 * user deleted, which makes deletion impossible — the edit silently undoes
 * itself on the next load.
 *
 * Library joins are listed before inferred ones and inference only adds what
 * the library did not already cover, so a curated join is never displaced by a
 * name-matching guess between the same two columns.
 */
export function mergeRelationships(
    saved: ErdRelationship[],
    inferred: ErdRelationship[],
    tables: ErdTable[],
    library: ErdRelationship[] = [],
): ErdRelationship[] {
    const known = new Set(tables.map(t => t.name));
    const keep = saved.filter(r => known.has(r.fromTable) && known.has(r.toTable));
    if (keep.length > 0) return keep;

    if (library.length > 0) {
        const have = new Set(library.map(r => r.id));
        return [...library, ...inferred.filter(r => !have.has(r.id))];
    }
    return inferred;
}

/**
 * The model for a set of tables, reconciled against what was persisted.
 *
 * Delegates to `mergeRelationships` rather than carrying its own rule. It used
 * to keep every persisted relationship unconditionally, which meant a Working
 * DB node whose upstream sources changed held on to edges naming tables that
 * were no longer there.
 */
export function buildErdModel(tables: ErdTable[], persisted?: ErdModel | null): ErdModel {
    return {
        tables,
        relationships: mergeRelationships(
            persisted?.relationships ?? [],
            inferRelationships(tables),
            tables,
        ),
    };
}
