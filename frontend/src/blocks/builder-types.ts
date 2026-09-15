// What the query builder holds.
//
// The builder state is the document and SQL is a projection of it (plan §3),
// so this shape is what gets saved, and every question the generator has to
// answer must be answerable from here alone. Nothing in this file imports a
// framework or reads the catalog: it is the record of what somebody chose.
//
// Columns and filters name their table by NAME, not by index into some list.
// The catalog is re-read on every load and a rescan can reorder it; a saved
// query that meant "the third table" would drift into meaning something else
// without anybody touching it.

/** How a selected column is summarised. `none` is a plain column. */
export type Aggregate = 'none' | 'count' | 'count distinct' | 'sum' | 'avg' | 'min' | 'max';

/** Works on anything: counting rows and picking extremes need no arithmetic. */
const ANY_TYPE: Aggregate[] = ['none', 'count', 'count distinct', 'min', 'max'];
const NUMERIC: Aggregate[] = ['none', 'count', 'count distinct', 'sum', 'avg', 'min', 'max'];

// Both vocabularies, because both arrive. A DESCRIBE gives SQL spellings
// (`BIGINT`, `DECIMAL(18,3)`); a run's preview gives Duckle's own names, which
// `crates/metadata` serializes as `int64`, `float64` — so the digits are part of
// the token and `\bfloat\b` does not match `float64`.
//
// `float\d*` rather than `float`: without the digits, every DOUBLE column in a
// run result read as non-numeric. That cost `sum`/`avg` in the aggregate picker
// and, once `vlTypeOf` started sharing this list, typed the column `nominal` —
// so a result with a perfectly good measure in it was told it needed a number.
const NUMERIC_TYPES =
    /\b(tinyint|smallint|integer|bigint|hugeint|int\d*|decimal|numeric|double|float\d*|real)\b/i;

/**
 * Does this DuckDB type hold a number?
 *
 * Exported so the chart-shape matcher asks the same question this file already
 * answers for aggregates. Two copies of this list would drift, and they would
 * drift silently — the failure is a column that can be summed but cannot be
 * plotted, or the reverse, with nothing to say which list was wrong.
 */
export function isNumericType(type?: string): boolean {
    return !!type && NUMERIC_TYPES.test(type);
}

/**
 * The aggregates that make sense for a column's type.
 *
 * `sum` over a VARCHAR is not a query that returns something odd — it does not
 * run at all (`No function matches sum(VARCHAR)`), and everything in this
 * workspace arrives from the API as text. Offering it was offering a dead end,
 * so the picker stops listing what the column cannot do.
 *
 * An UNKNOWN type gets the full list. Missing information is not the same as a
 * text column: a probe that failed should not quietly remove `sum` from a
 * numeric column, and the failure if it is wrong is an immediate, legible error
 * rather than a wrong number.
 */
export function aggregatesFor(type?: string): Aggregate[] {
    if (!type) return NUMERIC;
    return NUMERIC_TYPES.test(type) ? NUMERIC : ANY_TYPE;
}

/**
 * Which rows a join keeps — the arrow in the Joins list.
 *
 * `inner` keeps matches only. `keep-from` and `keep-to` keep every row of the
 * named side, named for the relationship's own `fromTable` / `toTable` rather
 * than left/right — the ER model speaks that way, and "left" next to LEFT JOIN
 * reads as a claim about the SQL keyword rather than about the data.
 *
 * The kept side is the one that lands in FROM, because there is no RIGHT JOIN
 * here: a right join is a left join with the tables swapped, and reading one is
 * a well-known way to misjudge which rows survive.
 */
export type JoinMode = 'inner' | 'keep-from' | 'keep-to';

export interface SelectedColumn {
    table: string;
    column: string;
    /** `*` for a whole table, selected by the "All fields" checkbox. */
    aggregate?: Aggregate;
    /** Output name. Set by the generator on collision (plan §4), or by hand. */
    alias?: string;
}

/** An explicit join. Derived ones are computed; this records the CHOICES. */
export interface BuilderJoin {
    /** The relationship this came from, so the ON clause is re-read from the
     *  ER model rather than frozen at the time of the click — an edited
     *  qualifier should reach queries that already use the join. */
    relationshipId: string;
    mode: JoinMode;
}

export type FilterOperator =
    | '='
    | '<>'
    | '>'
    | '>='
    | '<'
    | '<='
    | 'contains'
    | 'starts with'
    | 'ends with'
    | 'in'
    | 'is null'
    | 'is not null'
    | 'between';

/** Every operator, in the order the picker lists them. */
export const ALL_OPERATORS: FilterOperator[] = [
    '=',
    '<>',
    '>',
    '>=',
    '<',
    '<=',
    'contains',
    'starts with',
    'ends with',
    'in',
    'between',
    'is null',
    'is not null',
];

/** Aggregates whose result is a number whatever the column's own type is. */
const NUMERIC_AGGREGATES: Aggregate[] = ['count', 'count distinct', 'sum', 'avg'];

export function isNumericAggregate(agg?: Aggregate): boolean {
    return !!agg && NUMERIC_AGGREGATES.includes(agg);
}

/**
 * The operators worth offering for a rule's left-hand side.
 *
 * `count(Item.Item) starts with 'A'` is not a question anybody has — a count is
 * a number, and LIKE against it only ever runs by accident. Same reasoning as
 * `aggregatesFor`: a control that cannot produce a sensible query should not
 * list the option. `min`/`max` keep the full set, because they return the
 * column's own type and that may well be text.
 */
export function operatorsFor(agg?: Aggregate): FilterOperator[] {
    if (!isNumericAggregate(agg)) return ALL_OPERATORS;
    return ['=', '<>', '>', '>=', '<', '<=', 'between', 'is null', 'is not null'];
}

/**
 * A WHERE clause is a TREE, not a list.
 *
 * "Medline items that are either discontinued or out of stock" is one AND and
 * one OR, and a flat list cannot say it — every condition would be ANDed and
 * the question would have to be split into two queries. Same shape as the Infor
 * source node's filter model (`playground/providers/infor/filterModel.ts`),
 * which solved this already: rules, groups, a conjunction per group.
 */
export interface FilterRule {
    id: string;
    kind: 'rule';
    table: string;
    column: string;
    /**
     * Set only in HAVING: WHICH summarised column this compares.
     *
     * A group filter is about `count(Item.Item)`, not about `Item.Item` — once
     * the rows are grouped the raw column has no single value, so comparing it
     * is either an error or a question about the grouping key rather than about
     * the count. Recording the aggregate on the rule is also what lets the
     * generator find the right SELECT entry when one column is summarised twice:
     * a `count` and a `max` of `Item.Item` are two different left-hand sides and
     * table+column alone cannot tell them apart.
     */
    aggregate?: Aggregate;
    op: FilterOperator;
    /** Empty for `is null` / `is not null`; two entries for `between`; any
     *  number for `in`. Always text — everything arrives from the API as text
     *  and DuckDB is told nothing else (plan §7). */
    values: string[];
    /** Off skips the rule without deleting it, so a condition can be tried
     *  without and put back. */
    enabled?: boolean;
}

export interface FilterGroup {
    id: string;
    kind: 'group';
    conj: 'and' | 'or';
    children: FilterNode[];
}

export type FilterNode = FilterRule | FilterGroup;

let filterIds = 0;
function filterId(): string {
    try {
        return crypto.randomUUID();
    } catch {
        filterIds += 1;
        return `f${filterIds}`;
    }
}

export function newRule(table = '', column = '', aggregate?: Aggregate): FilterRule {
    return { id: filterId(), kind: 'rule', table, column, aggregate, op: '=', values: [''] };
}

export function newGroup(conj: 'and' | 'or' = 'and', children: FilterNode[] = []): FilterGroup {
    return { id: filterId(), kind: 'group', conj, children };
}

export function emptyFilterGroup(): FilterGroup {
    return newGroup('and', []);
}

/** Every table any rule in the tree names. */
export function filterTables(node: FilterNode): string[] {
    if (node.kind === 'rule') return node.table ? [node.table] : [];
    return node.children.flatMap(filterTables);
}

/** Every rule in the tree, rewritten by `fn`. Groups keep their shape. */
export function mapRules(node: FilterNode, fn: (rule: FilterRule) => FilterRule): FilterNode {
    if (node.kind === 'rule') return fn(node);
    // Not point-free: `map` would hand the index in as `fn`.
    return { ...node, children: node.children.map(c => mapRules(c, fn)) };
}

/** Replace one node by id, anywhere in the tree. */
export function replaceNode(root: FilterGroup, node: FilterNode): FilterGroup {
    return {
        ...root,
        children: root.children.map(c =>
            c.id === node.id ? node : c.kind === 'group' ? replaceNode(c, node) : c,
        ),
    };
}

/** Drop one node by id, anywhere in the tree. */
export function removeNode(root: FilterGroup, id: string): FilterGroup {
    return {
        ...root,
        children: root.children
            .filter(c => c.id !== id)
            .map(c => (c.kind === 'group' ? removeNode(c, id) : c)),
    };
}

/** Append a child to the group with this id. */
export function addToGroup(root: FilterGroup, groupId: string, child: FilterNode): FilterGroup {
    if (root.id === groupId) return { ...root, children: [...root.children, child] };
    return {
        ...root,
        children: root.children.map(c =>
            c.kind === 'group' ? addToGroup(c, groupId, child) : c,
        ),
    };
}

export interface SortColumn {
    table: string;
    column: string;
    dir: 'asc' | 'desc';
}

export interface BuilderState {
    schemaVersion: 1;
    /**
     * The database this query was built against, workspace-relative.
     *
     * Recorded because `duckle_src."Item"` resolves against whatever happens to
     * be attached: without this, opening the query in a workspace with two
     * databases can silently read a same-named table out of the wrong one
     * (plan §10).
     */
    database?: string;
    /** The table in FROM. Everything else joins onto it. Derived — set by
     *  `rebuildJoins` from whatever is needed first. */
    anchor?: string;
    /** Tables brought in on purpose without selecting from them — the Joins
     *  list's remaining job (plan §11). Without this they would be pruned the
     *  instant they were added, since nothing else references them yet. */
    extraTables?: string[];
    columns: SelectedColumn[];
    joins: BuilderJoin[];
    /**
     * Relationships the router may NOT route through.
     *
     * Recorded because a tie between two equal-length routes is not something
     * the model can settle. `Item` reaches `Vendor` through `VendorItem` or
     * through `item_norm.parquet`; both are two hops, and the second inflates
     * the join from 370 rows to 518 because the derived extract carries
     * duplicate pairs. Picking one by a rule ("prefer database tables") is right
     * there and wrong wherever somebody's real bridge table is a parquet.
     *
     * So the person decides, once, and it is kept — an exclusion is a statement
     * about THIS query's shape, not about the schema, which is why it lives here
     * and not on the ER model.
     *
     * An INPUT to `rebuildJoins`, never a patch applied after it. The joins list
     * is recomputed from scratch on every edit (see `rebuildJoins`), so an
     * exclusion that were merely subtracted afterwards would reappear the next
     * time anything was ticked.
     */
    excludedJoins?: string[];
    /** The root group. Always present, usually `and` with a flat child list. */
    filters: FilterGroup;
    /**
     * HAVING — filters on the aggregates, not on the rows.
     *
     * Kept separate from `filters` rather than flagged inside it, because the
     * two run at different times: WHERE decides which rows are counted, HAVING
     * decides which groups survive. Conflating them is how "why did my total
     * change when I filtered" happens.
     */
    having: FilterGroup;
    sort: SortColumn[];
    limit?: number;
}

export function emptyBuilder(): BuilderState {
    return {
        schemaVersion: 1,
        columns: [],
        joins: [],
        filters: emptyFilterGroup(),
        having: emptyFilterGroup(),
        sort: [],
    };
}

/** How many value boxes an operator needs. */
export function arity(op: FilterOperator): 0 | 1 | 2 | 'many' {
    if (op === 'is null' || op === 'is not null') return 0;
    if (op === 'between') return 2;
    if (op === 'in') return 'many';
    return 1;
}

/** Whether a rule has everything it needs to become SQL. */
export function filterIsComplete(f: FilterRule): boolean {
    if (!f.table || !f.column) return false;
    const n = arity(f.op);
    const given = f.values.filter(v => v.trim() !== '').length;
    if (n === 0) return true;
    if (n === 'many') return given > 0;
    return given === n;
}

/** Rules that will actually appear in the SQL. */
export function countRules(node: FilterNode): number {
    if (node.kind === 'rule') {
        return node.enabled !== false && filterIsComplete(node) ? 1 : 0;
    }
    return node.children.reduce((n, c) => n + countRules(c), 0);
}
