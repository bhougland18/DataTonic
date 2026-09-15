// Turning a filter TREE into a predicate.
//
// Split out of `builder-sql` so `transform-ops` can reach it: a CASE branch is
// a `FilterNode`, and the operation catalog has to render one. Left where it
// was, transform-ops would import builder-sql while builder-sql imports
// transform-ops - and a cycle between the generator and the catalog is the
// kind of thing that works until the day it does not.
//
// Nothing here knows about SELECT lists or clauses. It answers one question:
// what does this condition say in SQL.

import { quoteIdent } from '../erd/model';
import {
    filterIsComplete,
    isNumericAggregate,
    type FilterNode,
    type FilterRule,
} from './builder-types';
export const escape = (s: string) => s.replace(/'/g, "''");

/**
 * `Table.Column`, both quoted only where they need it.
 *
 * The alias IS the table name (plan §3), so this doubles as the reference and
 * the thing the ER model's join keys are already written in.
 */
export function ref(table: string, column: string): string {
    return `${quoteIdent(table)}.${quoteIdent(column)}`;
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
    // Nothing to compare: a rule naming a computed column that has since been
    // deleted — or dropped for being incomplete — and carrying no column to
    // fall back on. `filterIsComplete` cannot catch this, because it is handed
    // one rule and the answer depends on the transformation list. Without the
    // guard the generator emits `"".""`, which is a syntax error rather than a
    // wrong answer, but an avoidable one.
    if (!left && (!f.table || !f.column)) return null;
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
    /**
     * Left-hand side per rule.
     *
     * Supplied for HAVING, and for WHERE once a rule can name a computed
     * column. Returning `undefined` for a given rule means 'use the ordinary
     * column reference', which is how one resolver can serve a tree holding
     * both kinds of rule.
     */
    leftOf?: (rule: FilterRule) => string | undefined,
): string | null {
    if (node.kind === 'rule') return filterSql(node, leftOf?.(node));
    const parts = node.children
        .map(c => filterNodeSql(c, leftOf))
        .filter((s): s is string => s !== null);
    if (parts.length === 0) return null;
    if (parts.length === 1) return parts[0];
    return `(${parts.join(node.conj === 'or' ? ' OR ' : ' AND ')})`;
}
