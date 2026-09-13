// Turning an ER relationship into SQL the editor can accept.
//
// The point is to take joins away from the AI rather than to coax the AI into
// getting them right. A join is the part of a query that is already written
// down — the ER model knows the two tables, the key columns and any qualifiers
// — so asking a small local model to reconstruct it from a schema dump is
// re-deriving something we hold exactly.
//
// It also closes the gap left when qualifiers were built: they were stored,
// saved, carried through the library and sent as AI context, but nothing ever
// emitted them as SQL. `joinSql` puts them in the ON clause, which is where an
// outer join needs them — in a WHERE they would discard the unmatched rows the
// outer join exists to keep.

import { joinSql, quoteIdent, type ErdRelationship } from '../erd/model';
import { splitLiterals } from '../sqleditor/qualify';
import type { SqlStudioTable } from '../sqleditor/types';

// One definition, in `builder-types`, so the Joins list can hand the same value
// to either path — inserting SQL text, or setting a mode on the builder.
export type { JoinMode } from './builder-types';
import type { JoinMode } from './builder-types';

export type JoinInsert =
    | { kind: 'seed' | 'append'; sql: string }
    | { kind: 'blocked'; reason: string };

/** Clause keywords that must stay AFTER the join chain. */
const TAIL =
    /\b(where|group\s+by|order\s+by|having|limit|offset|qualify|window|union|except|intersect)\b/i;

const addressOf = (name: string, tables: SqlStudioTable[]): string => {
    const t = tables.find(x => x.name.toLowerCase() === name.toLowerCase());
    return t?.from ?? quoteIdent(name);
};

/** `<address> AS <alias>` — what goes after FROM or JOIN. */
export function tableClause(name: string, tables: SqlStudioTable[]): string {
    return `${addressOf(name, tables)} AS ${quoteIdent(name)}`;
}

/**
 * Is this table already in the query?
 *
 * Scanned over code AND double-quoted runs, but never single-quoted ones: `"`
 * marks an identifier, which still names a table, while `'` marks data, where
 * the word `Item` is a coincidence. Boundaries matter as much — `Item` must not
 * be found inside `VendorItem` (preceded by an identifier char) or inside
 * `VendorItem.Item` (preceded by a dot, so it is a column).
 */
export function mentionsTable(sql: string, name: string): boolean {
    const needle = name.toLowerCase();
    for (const seg of splitLiterals(sql)) {
        if (seg.quote === "'") continue;
        if (seg.quote === '"') {
            if (seg.text.slice(1, -1).toLowerCase() === needle) return true;
            continue;
        }
        const hay = seg.text.toLowerCase();
        let from = 0;
        for (;;) {
            const at = hay.indexOf(needle, from);
            if (at < 0) break;
            const before = hay[at - 1];
            const after = hay[at + needle.length];
            const okBefore = !before || !/[a-z0-9_$.]/.test(before);
            const okAfter = !after || !/[a-z0-9_$]/.test(after);
            if (okBefore && okAfter) return true;
            from = at + 1;
        }
    }
    return false;
}

/**
 * Where the join chain ends — the offset the new JOIN should be spliced at.
 *
 * Depth-aware, so a WHERE inside a subquery does not pull the join in with it,
 * and literal-aware for the same reason `mentionsTable` is.
 */
export function joinInsertionPoint(sql: string): number {
    let depth = 0;
    let offset = 0;
    for (const seg of splitLiterals(sql)) {
        if (!seg.code) {
            offset += seg.text.length;
            continue;
        }
        for (let i = 0; i < seg.text.length; i += 1) {
            const c = seg.text[i];
            if (c === '(') depth += 1;
            else if (c === ')') depth -= 1;
            else if (depth === 0) {
                const m = TAIL.exec(seg.text.slice(i));
                if (m && m.index === 0) return offset + i;
            }
        }
        offset += seg.text.length;
    }
    return sql.length;
}

/**
 * Build the SQL to add this relationship to `sql`, or explain why it cannot be.
 *
 * The anchor — which table goes in FROM — is decided by what is ALREADY in the
 * editor, not by the arrow, because a query has only one FROM and it is already
 * written. The arrow then chooses INNER vs LEFT. When the arrow asks to keep
 * all of the table that is NOT yet in the query, the two cannot both be
 * honoured: that needs the absent table in the FROM, which means restructuring
 * a query the user wrote. Refused with a reason rather than silently emitting a
 * join that keeps the wrong side's rows — the failure would be invisible, just
 * a row count nobody questions.
 */
export function insertJoin(
    sql: string,
    r: ErdRelationship,
    mode: JoinMode,
    tables: SqlStudioTable[],
): JoinInsert {
    const on = joinSql(r);
    const keyword = mode === 'inner' ? 'JOIN' : 'LEFT JOIN';

    if (!sql.trim()) {
        // Nothing to anchor to, so the arrow picks: the side whose rows are all
        // kept is the side that goes in FROM.
        const anchor = mode === 'keep-to' ? r.toTable : r.fromTable;
        const joined = anchor === r.fromTable ? r.toTable : r.fromTable;
        return {
            kind: 'seed',
            sql:
                `SELECT *\nFROM ${tableClause(anchor, tables)}\n` +
                `${keyword} ${tableClause(joined, tables)}\n  ON ${on}\n`,
        };
    }

    const hasFrom = mentionsTable(sql, r.fromTable);
    const hasTo = mentionsTable(sql, r.toTable);
    if (hasFrom && hasTo) {
        return { kind: 'blocked', reason: 'both tables are already in the query' };
    }
    if (!hasFrom && !hasTo) {
        return {
            kind: 'blocked',
            reason: `neither ${r.fromTable} nor ${r.toTable} is in the query yet`,
        };
    }

    const present = hasFrom ? r.fromTable : r.toTable;
    const joined = hasFrom ? r.toTable : r.fromTable;
    const wantsKept = mode === 'keep-to' ? r.toTable : r.fromTable;
    if (mode !== 'inner' && wantsKept !== present) {
        return {
            kind: 'blocked',
            reason: `keeping every ${wantsKept} row needs ${wantsKept} in the FROM — flip the arrow, or start the query from ${wantsKept}`,
        };
    }

    const at = joinInsertionPoint(sql);
    const head = sql.slice(0, at).replace(/\s+$/, '');
    const tail = sql.slice(at);
    const clause = `\n${keyword} ${tableClause(joined, tables)}\n  ON ${on}`;
    return { kind: 'append', sql: `${head}${clause}${tail ? `\n${tail}` : '\n'}` };
}
