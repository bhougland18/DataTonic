// Turning builder state into SQL somebody would be happy to inherit.
//
// This is the whole correctness surface of the builder (plan §12 phase 1): if
// the generator is right, no downstream check is needed, because a query built
// from a list of real columns and real relationships cannot name something that
// does not exist. That is the point of the redesign — the eight failures in
// plan §1 stop being possible rather than being caught.
//
// The output format is specified, not incidental (plan §3). Switching the
// builder off hands this text to a person, so it has to read like something a
// person wrote: leading commas, one clause per line, table names as aliases.

import { joinSql, parallelJoins, quoteIdent, type ErdRelationship } from '../erd/model';
import { addressOf } from './join-insert';
import type { SqlStudioTable } from '../sqleditor/types';
import { filterNodeSql, ref } from './filter-sql';
// Re-exported: these were part of this module's surface before the split, and
// callers should not have to know it moved.
export { filterSql, filterNodeSql } from './filter-sql';
import { transformExpression, transformIsComplete } from './transform-ops';
import {
    activeTransforms,
    mapRules,
    type Aggregate,
    type DateBucket,
    type BuilderState,
    type ColumnTransform,
    type FilterRule,
    type SelectedColumn,
    type SortColumn,
} from './builder-types';

/** `SELECT ` is seven characters, so a leading comma at six sits under its T. */
const COMMA_INDENT = '     , ';

/**
 * The expression a column contributes, without its output name.
 *
 * Bucket first, aggregate outermost: `count(date_trunc('month', x))` counts the
 * months, whereas `date_trunc('month', count(x))` is not a thing. The two are
 * orthogonal controls and this is the only order that composes.
 */
export function columnExpression(c: SelectedColumn): string {
    let base = ref(c.table, c.column);
    const bucket: DateBucket = c.bucket ?? 'none';
    if (bucket !== 'none') base = `date_trunc('${bucket}', ${base})`;
    const agg: Aggregate = c.aggregate ?? 'none';
    if (agg === 'none') return base;
    return agg === 'count distinct' ? `count(DISTINCT ${base})` : `${agg}(${base})`;
}

/**
 * The output name a transformed column gets by default.
 *
 * `count Item.Item`, not `Item.Item`. Without the prefix a summarised column
 * comes back headed the same as the raw one, so a grid of counts reads as a
 * grid of values — and the two are the kind of thing that get copied into a
 * report side by side.
 *
 * A bucket earns a name for a blunter reason: left alone, DuckDB heads the
 * column `date_trunc('month', AddedDate)`, which is the expression rather than
 * a heading. Both parts appear when both apply — `count month PO.Date` — read
 * outside-in, the same order the expression nests.
 */
export function transformAlias(c: SelectedColumn): string {
    const parts: string[] = [];
    if ((c.aggregate ?? 'none') !== 'none') parts.push(c.aggregate as string);
    if ((c.bucket ?? 'none') !== 'none') parts.push(c.bucket as string);
    return `${parts.join(' ')} ${c.table}.${c.column}`;
}

/** True when the column's heading would otherwise be an expression or a clash. */
export function isTransformed(c: SelectedColumn): boolean {
    return (c.aggregate ?? 'none') !== 'none' || (c.bucket ?? 'none') !== 'none';
}

/** One entry in the SELECT list, aggregate and alias applied. */
export function selectExpression(c: SelectedColumn): string {
    const expr = columnExpression(c);
    return c.alias ? `${expr} AS ${quoteIdent(c.alias)}` : expr;
}

/**
 * Output names that would collide, so the caller can alias them apart.
 *
 * `Item.Item` and `VendorItem.Item` both produce a column called `Item`; DuckDB
 * allows it and the grid then shows two columns with one heading.
 */
export function collidingNames(columns: SelectedColumn[]): Set<string> {
    const seen = new Map<string, number>();
    for (const c of columns) {
        if (c.alias) continue; // named by hand: the author owns it
        const k = c.column.toLowerCase();
        seen.set(k, (seen.get(k) ?? 0) + 1);
    }
    return new Set([...seen].filter(([, n]) => n > 1).map(([n]) => n));
}

/**
 * Fill in the output names: transforms first, then whatever still collides.
 *
 * Aggregates and buckets are named unconditionally — `count Item.Item` says
 * what it is — and that also settles most collisions before the collision rule
 * runs, since a count and a raw column no longer share a heading.
 */
export function withCollisionAliases(
    columns: SelectedColumn[],
    /** Transformation output names, which occupy the same heading space. A
     *  transformation called "Vendor" beside the Vendor column produces two
     *  columns under one heading exactly as two Vendor columns would, and the
     *  person NAMED that one - so the plain column is the one that gets
     *  qualified. */
    transforms: ColumnTransform[] = [],
): SelectedColumn[] {
    const named = columns.map(c =>
        !c.alias && isTransformed(c) ? { ...c, alias: transformAlias(c) } : c,
    );
    const taken = new Set(transforms.map(t => t.alias.toLowerCase()));
    const clash = new Set([
        ...collidingNames(named),
        ...named.filter(c => !c.alias && taken.has(c.column.toLowerCase())).map(c => c.column.toLowerCase()),
    ]);
    return named.map(c =>
        !c.alias && clash.has(c.column.toLowerCase())
            ? { ...c, alias: `${c.table}.${c.column}` }
            : c,
    );
}
/**
 * The join clause for one relationship, with the table it introduces.
 *
 * `joinSql` supplies the ON, so a qualifier edited on the Schema step reaches
 * every query using that join — and lands in ON rather than WHERE, which is
 * the difference between an outer join keeping its unmatched rows and quietly
 * becoming an inner one.
 */
function joinClause(
    rels: ErdRelationship[],
    joined: string,
    keyword: string,
    tables: SqlStudioTable[],
): string {
    const addr = addressOf(joined, tables);
    // EVERY relationship between these two tables, ANDed — a composite key is
    // one join with several conditions. Joining on part of one does not fail,
    // it multiplies rows, and the result is a total that is quietly too large.
    // Each condition gets its own line: a composite key is exactly the join
    // somebody needs to be able to read back.
    const on = rels.map(r => joinSql(r)).join('\n AND ');
    return `${keyword} ${addr} AS ${quoteIdent(joined)}\n  ON ${on}`;
}

export interface GenerateOptions {
    tables: SqlStudioTable[];
    relationships: ErdRelationship[];
    /** Written as a `-- name:` / `-- description:` header (plan §3). */
    title?: string;
    description?: string;
}

/**
 * Builder state → SQL.
 *
 * Returns an empty string when nothing is selected: a query with no columns is
 * not a query, and emitting `SELECT FROM` would put a syntax error in front of
 * somebody who has simply not started yet.
 */
/**
 * Transformations that will actually reach the SQL.
 *
 * Incomplete ones are DROPPED rather than emitted broken, the same way an
 * unfinished filter rule is. The modal will not let anybody create one, so a
 * transformation failing this is either older than a parameter the operation
 * has since gained, or one whose column has been removed from the catalog —
 * both cases where emitting half an expression is worse than emitting nothing.
 */
export function emittableTransforms(state: BuilderState): ColumnTransform[] {
    return activeTransforms(state.transforms).filter(transformIsComplete);
}

/**
 * A transformation as a SELECT entry.
 *
 * Its alias is always quoted, unlike a column's. A transformation's name is
 * something a person typed — "Total Qty", "% of Group" — and the ordinary path
 * through `quoteIdent` would leave a bare `Total Qty` in the SQL.
 */
export function transformSelect(t: ColumnTransform): string | null {
    const expr = transformExpression(t);
    return expr === null ? null : `${expr} AS ${quoteIdent(t.alias)}`;
}

/**
 * Does this transformation become a GROUP BY key when the query is grouped?
 *
 * `aggregate` is what CAUSES the grouping, so no. `window` is computed AFTER
 * grouping and DuckDB rejects it in GROUP BY. `literal` is a constant, which
 * DuckDB folds — measured: `SELECT 'Q1' AS period, Vendor, count(*) … GROUP BY
 * Vendor` runs and returns `Q1` on every row, so listing it would be noise in
 * the generated SQL for no behaviour.
 *
 * That leaves the scalar column transforms, which genuinely must appear.
 */
export function isGroupingTransform(t: ColumnTransform): boolean {
    return t.kind === 'function' || t.kind === 'regex' || t.kind === 'case';
}

export function generateSql(state: BuilderState, opts: GenerateOptions): string {
    const { tables, relationships } = opts;
    const transforms = emittableTransforms(state);
    // A query can be nothing BUT transformations — "how many purchase orders
    // are there" ticks no column at all. So the emptiness test counts both.
    if ((state.columns.length === 0 && transforms.length === 0) || !state.anchor) return '';

    const columns = withCollisionAliases(state.columns, transforms);
    const lines: string[] = [];

    if (opts.title?.trim()) {
        lines.push(`-- name: ${opts.title.replace(/\s+/g, ' ').trim()}`);
        if (opts.description?.trim()) {
            lines.push(`-- description: ${opts.description.replace(/\s+/g, ' ').trim()}`);
        }
        lines.push('');
    }

    // SELECT — leading commas so the list scans down the left edge.
    //
    // Ticked columns first, then computed ones. Output ORDER is Column
    // Ordering's to own; this is only the order they are emitted in before
    // anybody has said otherwise, and putting the source columns first is how
    // a person reading the query back finds their bearings.
    const selectParts = [
        ...columns.map(selectExpression),
        ...transforms.map(transformSelect).filter((s): s is string => s !== null),
    ];
    selectParts.forEach((part, i) => {
        lines.push(`${i === 0 ? 'SELECT ' : COMMA_INDENT}${part}`);
    });

    // FROM, then the joins in the order they were added. Order is already
    // dependable: a join is only ever added onto a table that is present, so
    // nothing can reference a table introduced later (the failure
    // `join-order.ts` exists to repair in AI drafts cannot arise here).
    lines.push(
        `FROM ${addressOf(state.anchor, tables)} AS ${quoteIdent(state.anchor)}`,
    );

    const inScope = new Set([state.anchor.toLowerCase()]);
    for (const j of state.joins) {
        const rel = relationships.find(r => r.id === j.relationshipId);
        if (!rel) continue; // the relationship was deleted on the Schema step
        const fromIn = inScope.has(rel.fromTable.toLowerCase());
        const toIn = inScope.has(rel.toTable.toLowerCase());
        if (fromIn === toIn) continue; // both already in, or neither reachable
        const joined = fromIn ? rel.toTable : rel.fromTable;
        // `keep-left`/`keep-right` name the side whose rows all survive. A LEFT
        // JOIN keeps the rows of what is already in FROM, so it expresses the
        // mode only when the kept side is the one already there.
        const keptSide = j.mode === 'keep-to' ? rel.toTable : rel.fromTable;
        const keyword =
            j.mode !== 'inner' && keptSide.toLowerCase() !== joined.toLowerCase()
                ? 'LEFT JOIN'
                : 'JOIN';
        // Read from the FULL relationship list, not from `state.joins`: a
        // composite key is a fact about the schema rather than something the
        // person ticked, so the second arm must come along even though nothing
        // selected it. Exclusions still apply — ruling a route out can mean
        // ruling out one arm.
        const all = parallelJoins(joined, inScope, relationships, state.excludedJoins);
        // `rel` leads: it is the one the route chose, and the rest qualify it.
        const ordered = [rel, ...all.filter(r => r.id !== rel.id)];
        lines.push(joinClause(ordered, joined, keyword, tables));
        inScope.add(joined.toLowerCase());
    }

    // WHERE — the ROOT group's children get a line each, with the conjunction
    // leading, so any one condition can be commented out on its own. Nested
    // groups stay inline in their parentheses: breaking those across lines too
    // would need indent tracking for a shape the builder rarely produces.
    const conj = state.filters.conj === 'or' ? 'OR' : 'AND';
    // Not point-free: `map` would hand the index in as `leftOf`.
    /**
     * The left-hand side for a rule that names a computed column.
     *
     * Its ALIAS, quoted. DuckDB supports lateral column aliases — a SELECT
     * alias can be named in WHERE, GROUP BY, HAVING, QUALIFY and ORDER BY —
     * which is precisely what lets the builder do this without a subquery
     * (`column-transformations.md` §2, §4).
     *
     * Falls through to the ordinary column reference for rules that do not name
     * one, and for a rule whose transformation has since been deleted: the rule
     * is stale either way and the SQL should say so rather than vanish.
     */
    const leftOfRule = (rule: FilterRule): string | undefined => {
        if (!rule.transformId) return undefined;
        const t = transforms.find(x => x.id === rule.transformId);
        return t ? quoteIdent(t.alias) : undefined;
    };

    /**
     * Fill in a rule's aggregate from the transformation it names.
     *
     * Only so the literal comes out right. `filterSql` writes a number bare
     * against a count/sum/avg and quoted otherwise, and the rule itself no
     * longer carries the aggregate once it points at a transformation — so
     * without this, `HAVING Orders > '5'` is generated. It runs, because DuckDB
     * casts an untyped literal, but the output is meant to be READ and a quoted
     * number beside a count reads as a string comparison.
     *
     * Scalar transformations are deliberately left alone: a `date_trunc` column
     * compared against `'2024-01-01'` wants its quotes exactly as a plain
     * column would.
     */
    const withTransformAggregate = (rule: FilterRule): FilterRule => {
        if (!rule.transformId || rule.aggregate) return rule;
        const t = transforms.find(x => x.id === rule.transformId);
        if (!t || t.kind !== 'aggregate') return rule;
        return { ...rule, aggregate: t.op as Aggregate };
    };

    const predicates = state.filters.children
        .map(c => filterNodeSql(mapRules(c, withTransformAggregate), leftOfRule))
        .filter((s): s is string => s !== null);
    predicates.forEach((p, i) =>
        lines.push(i === 0 ? `WHERE ${p}` : `  ${conj} ${p}`),
    );

    // GROUP BY is a consequence, never a separate choice (plan §6): the moment
    // anything is aggregated, everything that is not gets grouped. Nothing for
    // the user to keep consistent, and "must appear in GROUP BY" cannot happen.
    // Grouping is still a CONSEQUENCE, never a choice (plan §6) — it is just
    // that an aggregate can now arrive from either place while the old field
    // is still being read.
    const aggregated =
        columns.some(c => (c.aggregate ?? 'none') !== 'none') ||
        transforms.some(x => x.kind === 'aggregate');
    if (aggregated) {
        const grouped: string[] = [
            ...columns.filter(c => (c.aggregate ?? 'none') === 'none').map(columnExpression),
            // A scalar transformation is a grouping key like any other computed
            // column, and has to be REPEATED here rather than named by alias -
            // see the note on the columns above.
            ...transforms
                .filter(isGroupingTransform)
                .map(transformExpression)
                .filter((s): s is string => s !== null),
        ];
        grouped.forEach((expr, i) => {
            // `columnExpression`, NOT the bare column: a bucketed key is
            // `date_trunc('month', x)` in SELECT, and GROUP BY has to say the
            // same thing character for character. Writing the bucket in one and
            // the raw column in the other is the mistake this control exists to
            // stop people making by hand — and it does not error, it groups by
            // the day and labels it the month.
            lines.push(`${i === 0 ? 'GROUP BY ' : '       , '}${expr}`);
        });
    }

    // HAVING filters the GROUPS, so it only means anything once something is
    // aggregated — and DuckDB rejects it outright otherwise.
    if (aggregated) {
        /**
         * The SELECT entry a grouping-filter rule is about.
         *
         * The rule names its aggregate, so one column summarised twice —
         * `count(Item.Item)` and `max(Item.Item)` — resolves to the one it
         * actually means rather than to whichever was ticked first. A rule
         * WITHOUT an aggregate is one saved before they were recorded: any
         * summarised entry beats the raw column, because HAVING is about groups
         * and the raw column has no value once they are formed.
         */
        const selectedFor = (rule: FilterRule): SelectedColumn | undefined => {
            const same = columns.filter(
                x =>
                    x.table.toLowerCase() === rule.table.toLowerCase() &&
                    x.column.toLowerCase() === rule.column.toLowerCase(),
            );
            const summarised = same.filter(x => (x.aggregate ?? 'none') !== 'none');
            const exact = rule.aggregate
                ? summarised.find(x => x.aggregate === rule.aggregate)
                : undefined;
            return exact ?? summarised[0] ?? same[0];
        };
        // Settle each rule's aggregate from the SELECT list before generating,
        // so whether `> 5` is written bare follows from the left-hand side that
        // actually gets emitted rather than from what the panel recorded. A
        // query saved before rules carried an aggregate still comes out right.
        const resolved = (rule: FilterRule): FilterRule =>
            // A rule naming a transformation says outright which one, so there
            // is nothing to resolve against the SELECT list — only the literal
            // formatting to settle.
            rule.transformId
                ? withTransformAggregate(rule)
                : { ...rule, aggregate: selectedFor(rule)?.aggregate ?? rule.aggregate };
        const leftOf = (rule: FilterRule) => {
            // A rule naming a computed column wins outright: it says exactly
            // which one, so there is nothing to resolve against the SELECT list.
            const byId = leftOfRule(rule);
            if (byId) return byId;
            const c = selectedFor(rule);
            // Falls back to the bare column for a rule whose column has since
            // been unticked; the rule is stale either way and the SQL says so.
            return c ? columnExpression(c) : ref(rule.table, rule.column);
        };
        const conjH = state.having.conj === 'or' ? 'OR' : 'AND';
        const groupPredicates = state.having.children
            .map(c => filterNodeSql(mapRules(c, resolved), leftOf))
            .filter((s): s is string => s !== null);
        groupPredicates.forEach((p, i) =>
            lines.push(i === 0 ? `HAVING ${p}` : `   ${conjH} ${p}`),
        );
    }

    /**
     * What to ORDER BY for a sort key — which is not always the column.
     *
     * Once anything is aggregated the raw column is gone: DuckDB answers
     * `column "Quantity" must appear in the GROUP BY clause or be part of an
     * aggregate`. A sort on a summarised column has to name the SUMMARY, and the
     * output alias is the readable way to say it — `ORDER BY "count …" DESC` is
     * the same thing somebody would have written by hand.
     *
     * A GROUP BY key still sorts by the column itself; only the summarised ones
     * change. Same resolution HAVING does, and the same reason.
     */
    const sortExpression = (s: SortColumn): string => {
        // A computed column sorts by its ALIAS. It has to: the expression may
        // be an aggregate, which ORDER BY accepts, or a window, which it does
        // not — and the alias is right for both. It is also what somebody would
        // have written by hand.
        if (s.transformId) {
            const t = transforms.find(x => x.id === s.transformId);
            // Deleted since: fall through to the column reference, which is
            // wrong in a legible way rather than silently dropping the sort.
            if (t) return quoteIdent(t.alias);
        }
        const matches = columns.filter(
            c =>
                c.table.toLowerCase() === s.table.toLowerCase() &&
                c.column.toLowerCase() === s.column.toLowerCase(),
        );
        // A grouping key wins over a summary of the same column: it is the one
        // that still exists under its own name.
        const key = matches.find(c => (c.aggregate ?? 'none') === 'none');
        // Unless it is BUCKETED, in which case it does not exist under its own
        // name either: the query says `date_trunc('month', x)` in SELECT and in
        // GROUP BY, so the raw column is in neither and DuckDB rejects it. Same
        // failure a summarised column has, and the alias is the same answer.
        // Applied even ungrouped, where the raw column would still be legal —
        // one rule to read beats two that agree.
        if (key && (key.bucket ?? 'none') !== 'none') {
            return key.alias ? quoteIdent(key.alias) : columnExpression(key);
        }
        if (!aggregated || key) return ref(s.table, s.column);
        const agg = matches.find(c => (c.aggregate ?? 'none') !== 'none');
        // `withCollisionAliases` names every aggregate, so the alias is always
        // there; the expression is a fallback that should not be reachable.
        if (agg) return agg.alias ? quoteIdent(agg.alias) : columnExpression(agg);
        // Sorting by something the query does not select, in a grouped query.
        // Left as-is so the engine says so, rather than being dropped silently.
        return ref(s.table, s.column);
    };

    state.sort.forEach((s, i) => {
        const dir = s.dir === 'desc' ? ' DESC' : '';
        lines.push(`${i === 0 ? 'ORDER BY ' : '       , '}${sortExpression(s)}${dir}`);
    });

    // No terminator: the engine wraps the body in `({sql})`, where a trailing
    // semicolon is a syntax error (`stripTerminator`).
    if (state.limit != null && state.limit > 0) lines.push(`LIMIT ${Math.floor(state.limit)}`);

    return lines.join('\n');
}
