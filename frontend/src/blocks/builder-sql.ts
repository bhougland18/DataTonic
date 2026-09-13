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

import { joinSql, quoteIdent, type ErdRelationship } from '../erd/model';
import type { SqlStudioTable } from '../sqleditor/types';
import {
    filterIsComplete,
    isNumericAggregate,
    mapRules,
    type Aggregate,
    type BuilderState,
    type FilterNode,
    type FilterRule,
    type SelectedColumn,
} from './builder-types';

/** `SELECT ` is seven characters, so a leading comma at six sits under its T. */
const COMMA_INDENT = '     , ';

const escape = (s: string) => s.replace(/'/g, "''");

/**
 * `Table.Column`, both quoted only where they need it.
 *
 * The alias IS the table name (plan §3), so this doubles as the reference and
 * the thing the ER model's join keys are already written in.
 */
function ref(table: string, column: string): string {
    return `${quoteIdent(table)}.${quoteIdent(column)}`;
}

/** The expression a column contributes, without its output name. */
export function columnExpression(c: SelectedColumn): string {
    const base = ref(c.table, c.column);
    const agg: Aggregate = c.aggregate ?? 'none';
    if (agg === 'none') return base;
    return agg === 'count distinct' ? `count(DISTINCT ${base})` : `${agg}(${base})`;
}

/**
 * The output name an aggregated column gets by default.
 *
 * `count Item.Item`, not `Item.Item`. Without the prefix a summarised column
 * comes back headed the same as the raw one, so a grid of counts reads as a
 * grid of values — and the two are the kind of thing that get copied into a
 * report side by side.
 */
export function aggregateAlias(c: SelectedColumn): string {
    return `${c.aggregate} ${c.table}.${c.column}`;
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
 * Fill in the output names: aggregates first, then whatever still collides.
 *
 * Aggregates are named unconditionally — `count Item.Item` says what it is —
 * and that also settles most collisions before the collision rule runs, since
 * a count and a raw column no longer share a heading.
 */
export function withCollisionAliases(columns: SelectedColumn[]): SelectedColumn[] {
    const named = columns.map(c =>
        !c.alias && (c.aggregate ?? 'none') !== 'none'
            ? { ...c, alias: aggregateAlias(c) }
            : c,
    );
    const clash = collidingNames(named);
    return named.map(c =>
        !c.alias && clash.has(c.column.toLowerCase())
            ? { ...c, alias: `${c.table}.${c.column}` }
            : c,
    );
}

/**
 * One rule as a predicate, or null when it is incomplete or switched off.
 *
 * `left` overrides the column reference, which is what makes HAVING work: the
 * same rule shape reads `count(Item.Item) > 5` there and `Item.Item = 'x'` in
 * WHERE, so the tree, the editor and the operators are shared rather than
 * duplicated for a clause that differs only in what it compares.
 */
export function filterSql(f: FilterRule, left?: string): string | null {
    if (f.enabled === false || !filterIsComplete(f)) return null;
    const col = left ?? ref(f.table, f.column);
    const v = f.values.map(x => x.trim()).filter(x => x !== '');
    // Quoted, EXCEPT against a count/sum/avg, where the comparison is arithmetic
    // and the literal is written bare. `count(x) > '5'` does run — DuckDB casts
    // an untyped literal — but the generated SQL is meant to be read, and a
    // quoted number next to a count reads as a string comparison.
    const numeric = isNumericAggregate(f.aggregate);
    const lit = (s: string) =>
        numeric && /^-?\d+(\.\d+)?$/.test(s) ? s : `'${escape(s)}'`;
    switch (f.op) {
        case 'is null':
            return `${col} IS NULL`;
        case 'is not null':
            return `${col} IS NOT NULL`;
        case 'contains':
            return `${col} LIKE '%${escape(v[0])}%'`;
        case 'starts with':
            return `${col} LIKE '${escape(v[0])}%'`;
        case 'ends with':
            return `${col} LIKE '%${escape(v[0])}'`;
        case 'in':
            return `${col} IN (${v.map(lit).join(', ')})`;
        case 'between':
            return `${col} BETWEEN ${lit(v[0])} AND ${lit(v[1])}`;
        case '<>':
        case '>':
        case '>=':
        case '<':
        case '<=':
            return `${col} ${f.op} ${lit(v[0])}`;
        default:
            return `${col} = ${lit(v[0])}`;
    }
}

/**
 * A filter node as a predicate, parenthesised only where it has to be.
 *
 * A group with one surviving child emits that child bare: wrapping every group
 * would litter the output with `((x))` for conditions somebody never grouped,
 * and the generated SQL is meant to be read.
 */
export function filterNodeSql(
    node: FilterNode,
    /** Left-hand side per rule — supplied for HAVING, omitted for WHERE. */
    leftOf?: (rule: FilterRule) => string,
): string | null {
    if (node.kind === 'rule') return filterSql(node, leftOf?.(node));
    const parts = node.children
        .map(c => filterNodeSql(c, leftOf))
        .filter((s): s is string => s !== null);
    if (parts.length === 0) return null;
    if (parts.length === 1) return parts[0];
    return `(${parts.join(node.conj === 'or' ? ' OR ' : ' AND ')})`;
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
    rel: ErdRelationship,
    joined: string,
    keyword: string,
    tables: SqlStudioTable[],
): string {
    const t = tables.find(x => x.name.toLowerCase() === joined.toLowerCase());
    const addr = t?.from ?? quoteIdent(joined);
    return `${keyword} ${addr} AS ${quoteIdent(joined)}\n  ON ${joinSql(rel)}`;
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
export function generateSql(state: BuilderState, opts: GenerateOptions): string {
    const { tables, relationships } = opts;
    if (state.columns.length === 0 || !state.anchor) return '';

    const columns = withCollisionAliases(state.columns);
    const lines: string[] = [];

    if (opts.title?.trim()) {
        lines.push(`-- name: ${opts.title.replace(/\s+/g, ' ').trim()}`);
        if (opts.description?.trim()) {
            lines.push(`-- description: ${opts.description.replace(/\s+/g, ' ').trim()}`);
        }
        lines.push('');
    }

    // SELECT — leading commas so the list scans down the left edge.
    columns.forEach((c, i) => {
        lines.push(`${i === 0 ? 'SELECT ' : COMMA_INDENT}${selectExpression(c)}`);
    });

    // FROM, then the joins in the order they were added. Order is already
    // dependable: a join is only ever added onto a table that is present, so
    // nothing can reference a table introduced later (the failure
    // `join-order.ts` exists to repair in AI drafts cannot arise here).
    const anchorTable = tables.find(t => t.name.toLowerCase() === state.anchor?.toLowerCase());
    lines.push(
        `FROM ${anchorTable?.from ?? quoteIdent(state.anchor)} AS ${quoteIdent(state.anchor)}`,
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
        lines.push(joinClause(rel, joined, keyword, tables));
        inScope.add(joined.toLowerCase());
    }

    // WHERE — the ROOT group's children get a line each, with the conjunction
    // leading, so any one condition can be commented out on its own. Nested
    // groups stay inline in their parentheses: breaking those across lines too
    // would need indent tracking for a shape the builder rarely produces.
    const conj = state.filters.conj === 'or' ? 'OR' : 'AND';
    // Not point-free: `map` would hand the index in as `leftOf`.
    const predicates = state.filters.children
        .map(c => filterNodeSql(c))
        .filter((s): s is string => s !== null);
    predicates.forEach((p, i) =>
        lines.push(i === 0 ? `WHERE ${p}` : `  ${conj} ${p}`),
    );

    // GROUP BY is a consequence, never a separate choice (plan §6): the moment
    // anything is aggregated, everything that is not gets grouped. Nothing for
    // the user to keep consistent, and "must appear in GROUP BY" cannot happen.
    const aggregated = columns.some(c => (c.aggregate ?? 'none') !== 'none');
    if (aggregated) {
        const grouped = columns.filter(c => (c.aggregate ?? 'none') === 'none');
        grouped.forEach((c, i) => {
            lines.push(`${i === 0 ? 'GROUP BY ' : '       , '}${ref(c.table, c.column)}`);
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
        const resolved = (rule: FilterRule): FilterRule => ({
            ...rule,
            aggregate: selectedFor(rule)?.aggregate ?? rule.aggregate,
        });
        const leftOf = (rule: FilterRule) => {
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

    state.sort.forEach((s, i) => {
        const dir = s.dir === 'desc' ? ' DESC' : '';
        lines.push(`${i === 0 ? 'ORDER BY ' : '       , '}${ref(s.table, s.column)}${dir}`);
    });

    // No terminator: the engine wraps the body in `({sql})`, where a trailing
    // semicolon is a syntax error (`stripTerminator`).
    if (state.limit != null && state.limit > 0) lines.push(`LIMIT ${Math.floor(state.limit)}`);

    return lines.join('\n');
}
