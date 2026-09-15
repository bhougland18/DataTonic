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

/** How a temporal column is rounded before it is grouped. `none` is raw. */
export type DateBucket = 'none' | 'day' | 'week' | 'month' | 'quarter' | 'year';

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

// `timestamptz` and `datetime` are aliases DuckDB accepts and echoes back in
// some paths; `\b` rather than an anchor because a column can arrive as
// `TIMESTAMP WITH TIME ZONE` or `TIMESTAMP_NS`.
const TEMPORAL_TYPES = /\b(date|time|timestamp|timestamptz|datetime)\b/i;

/**
 * Does this DuckDB type hold a point in time?
 *
 * Lives here, beside `isNumericType`, for the reason that one does: the chart
 * matcher and the bucket picker must agree on what a date IS. Two regexes would
 * drift into a column that can be bucketed but plots as a category.
 */
export function isTemporalType(type?: string): boolean {
    return !!type && TEMPORAL_TYPES.test(type);
}

/** Every bucket, in the order the picker lists them — coarsest last. */
export const DATE_BUCKETS: DateBucket[] = ['none', 'day', 'week', 'month', 'quarter', 'year'];

/**
 * The date buckets a column's type allows — none at all, unless it is temporal.
 *
 * Measured, not assumed: `date_trunc('month', <varchar>)` is `No function
 * matches the given name and argument types`, the same dead end `sum` over a
 * VARCHAR is. So the control is absent rather than present-and-broken.
 *
 * **An UNKNOWN type gets NOTHING, which is the opposite of `aggregatesFor`.**
 * The asymmetry is deliberate. There, being permissive costs one legible error
 * on a column somebody actively chose to sum. Here, being permissive puts a
 * date dropdown on EVERY column of a workspace whose columns were all text
 * until `2af12706` typed them — hundreds of controls that cannot work, to avoid
 * missing the handful that can. A date column that failed to probe is much
 * rarer than a text column that did.
 */
export function bucketsFor(type?: string): DateBucket[] {
    return isTemporalType(type) ? DATE_BUCKETS : [];
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
    /**
     * Round a temporal column before grouping it — `date_trunc(bucket, col)`.
     *
     * Separate from `aggregate` rather than sharing its dropdown, because the
     * two are orthogonal: a date can be bucketed to a month AND be the thing
     * counted. The generator composes them, aggregate outermost.
     */
    bucket?: DateBucket;
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
    /**
     * The computed column this compares, when it is one.
     *
     * Set INSTEAD of `table`/`column`, which stay empty — a transformation is
     * not a column of any table and pretending otherwise would put a name in
     * `requiredTables` that no catalog can resolve. The generator compares its
     * ALIAS, which DuckDB allows in every clause the builder emits.
     *
     * Which clause the rule lands in follows from the transformation's KIND,
     * not from which section it was authored in — see `clauseFor`.
     */
    transformId?: string;
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

let seq = 0;
// Shared by filter nodes, transformations and case branches - all of them
// just need an id that is unique within one document.
function freshId(): string {
    try {
        return crypto.randomUUID();
    } catch {
        seq += 1;
        return `f${seq}`;
    }
}

export function newRule(table = '', column = '', aggregate?: Aggregate): FilterRule {
    return { id: freshId(), kind: 'rule', table, column, aggregate, op: '=', values: [''] };
}

export function newGroup(conj: 'and' | 'or' = 'and', children: FilterNode[] = []): FilterGroup {
    return { id: freshId(), kind: 'group', conj, children };
}

export function emptyFilterGroup(): FilterGroup {
    return newGroup('and', []);
}

/** Every table any rule in the tree names. */
export function filterTables(node: FilterNode): string[] {
    // A rule on a computed column names none. Its table comes from the
    // TRANSFORMATION, which `requiredTables` reads separately — counting it
    // here would be counting the same table twice, and counting an empty
    // string when the transformation is a literal.
    if (node.kind === 'rule') return node.transformId || !node.table ? [] : [node.table];
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

/** What a sort key POINTS AT, without saying which way. */
export type SortKey = Pick<SortColumn, 'table' | 'column' | 'transformId'>;

/**
 * Two sort keys naming the same thing.
 *
 * Computed columns compare by ID, not by source column: two transformations can
 * read `PurchaseOrderDate` — rounded to a month and to a year — and they are
 * different sort keys despite agreeing on table and column.
 */
export function sameSortKey(a: SortKey, b: SortKey): boolean {
    if (a.transformId || b.transformId) return a.transformId === b.transformId;
    return (
        a.table.toLowerCase() === b.table.toLowerCase() &&
        a.column.toLowerCase() === b.column.toLowerCase()
    );
}

export interface SortColumn {
    /** The computed column this sorts by, when it is one. Set INSTEAD of
     *  `table`/`column`, for the reason given on `FilterRule.transformId`. */
    transformId?: string;
    table: string;
    column: string;
    dir: 'asc' | 'desc';
}

// ---------------------------------------------------------------------------
// Column transformations
// ---------------------------------------------------------------------------
//
// Every COMPUTED column, in one place. A ticked column in the catalog says
// "include this"; a transformation says "and here is something new, built from
// it, called this". They were the same control for a while — an aggregate
// dropdown on each catalog row — and the catalog is a list that scrolls past
// several hundred entries, so the second question was being asked in a bad
// place (`column-transformations.md` §1).
//
// The builder does NOT generate subqueries or CTEs, deliberately and
// permanently (§2). Everything here has to fit in one flat SELECT. That is
// affordable because DuckDB allows a SELECT alias to be named in WHERE, GROUP
// BY, HAVING, QUALIFY and ORDER BY — so a transformation is defined once and
// referenced by name everywhere else.

/** What kind of thing a transformation computes. */
export type TransformKind =
    | 'aggregate'
    | 'function'
    | 'window'
    | 'regex'
    | 'case'
    | 'literal';

/**
 * One branch of a CASE.
 *
 * `when` is a `FilterNode` rather than a bespoke condition type: a WHEN is a
 * predicate, the builder already has a good predicate editor, and a second one
 * would drift from the first. Operators, the distinct-value picker and
 * `filterIsComplete` all come along for free.
 */
export interface CaseBranch {
    id: string;
    when: FilterNode;
    /** The value when it matches. */
    then: string;
    /** `then` names a COLUMN rather than being a literal. Without this the
     *  generator cannot tell `'Vendor'` the string from `Vendor` the column,
     *  and quoting the wrong one is silent: you get the word, on every row. */
    thenIsColumn?: boolean;
}

/**
 * A parameter value.
 *
 * Most are scalar. Windows take column LISTS (partition by, order by) and a
 * case takes branches, so this is a union rather than a string.
 */
export type TransformArg = string | string[] | CaseBranch[];

export interface ColumnTransform {
    id: string;
    kind: TransformKind;
    /**
     * The SOURCE column it reads.
     *
     * By NAME, never by index into the catalog — same reason `SelectedColumn`
     * is (see this file's header): a rescan reorders the catalog and "the third
     * column" would come to mean something else with nobody touching it.
     *
     * OPTIONAL, and genuinely so. A `literal` reads nothing at all, and a
     * `case` names its columns inside its branches. Code that assumes every
     * transformation has a source column breaks on two of the six kinds.
     */
    table?: string;
    column?: string;
    /** The operation: `sum`, `date_trunc`, `running_total`, `regexp_extract`. */
    op: string;
    /**
     * Everything else the operation needs, by parameter name.
     *
     * Loose on purpose. `transform-ops.ts` defines each operation's parameter
     * shape and the modal validates against it before letting anybody out, so
     * a typed union here would buy nothing and would need editing every time a
     * function is added.
     */
    args: Record<string, TransformArg>;
    /**
     * The output name. ALWAYS set.
     *
     * Everywhere else in the builder an alias is a fallback the generator fills
     * in on collision. Here somebody is naming a thing that did not exist
     * before, and an unnamed one comes back headed
     * `regexp_extract(VendorName, ...)` — the expression, not a heading. The
     * modal pre-fills a generated default, and editing it is a choice.
     */
    alias: string;
    /** Off skips it without deleting it, like a filter rule. */
    enabled?: boolean;
}

export function newTransform(kind: TransformKind, op = ''): ColumnTransform {
    return { id: freshId(), kind, op, args: {}, alias: '' };
}

export function newCaseBranch(): CaseBranch {
    return { id: freshId(), when: emptyFilterGroup(), then: '' };
}

/** Transformations that will actually appear in the SQL. */
export function activeTransforms(transforms?: ColumnTransform[]): ColumnTransform[] {
    return (transforms ?? []).filter(t => t.enabled !== false);
}

/**
 * Which clause a filter on this transformation belongs in.
 *
 * Derived from the KIND, never chosen. DuckDB enforces all three and says so:
 * `WHERE clause cannot contain aggregates` and `WHERE clause cannot contain
 * window functions` are both real errors from the engine, measured. So there is
 * nothing here for anybody to get right — the same reason GROUP BY is a
 * consequence rather than a choice (query-builder plan §6).
 */
export function clauseFor(kind: TransformKind): 'where' | 'having' | 'qualify' {
    if (kind === 'aggregate') return 'having';
    if (kind === 'window') return 'qualify';
    return 'where';
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
    /**
     * Computed columns, in the order they were created.
     *
     * Order here is NOT output order - Column Ordering owns that. It can be
     * any order at all, because a transformation may only read SOURCE columns
     * and never another transformation (`column-transformations.md` §2), so
     * there is no dependency between two of these to violate. That restriction
     * is what buys the freedom to drag output columns anywhere.
     *
     * OPTIONAL because saved queries predate it. `query-io` casts stored JSON
     * straight back to `BuilderState` with no normalising layer, so a required
     * field here would be a lie the type system cannot catch: every query saved
     * before today would arrive with `transforms` undefined and the first
     * `.filter()` on it would throw. Same reason `extraTables` and
     * `excludedJoins` are optional. Read it as `state.transforms ?? []`.
     */
    transforms?: ColumnTransform[];
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
        transforms: [],
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
    // A rule on a computed column names no table, and requiring one here is
    // what would silently drop every filter on a transformation from the SQL.
    if (!f.transformId && (!f.table || !f.column)) return false;
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
