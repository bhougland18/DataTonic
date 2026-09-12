// Putting the joins in an order SQL will accept.
//
// The failure: a model that has been told exactly which joins to add appends
// them in the order it thought of them, so `JOIN Vendor ON Vendor.Vendor =
// VendorItem.Vendor` lands BEFORE VendorItem is introduced. SQL has no forward
// references, so DuckDB answers `Referenced table "VendorItem" not found!` —
// and the query is otherwise completely correct. Swapping two lines fixes it.
//
// Reordered here rather than asked for. It is a mechanical property of the
// text, the model has already demonstrated it does not track it, and a retry
// costs a turn to maybe arrive at what a topological sort gives us outright.
//
// Two rules keep this safe, because rewriting somebody's SQL structurally is a
// heavier thing than the token-level repairs elsewhere in this module:
//
//   * Only when the query is ALREADY BROKEN. A chain whose joins all resolve is
//     returned untouched, so a working query is never restructured — reordering
//     an outer join can change which rows survive, and that is not a thing to
//     do to a query that runs.
//   * Only the shape we understand. Anything with a comma join, a USING clause,
//     a subquery in the FROM chain or a join we cannot read an alias off is
//     returned unchanged rather than half-parsed.

import { scannable } from './qualify';

export interface ParsedJoin {
    /** `JOIN`, `LEFT JOIN`, … exactly as written. */
    keyword: string;
    /** The table expression, e.g. `duckle_src."Vendor" AS Vendor`. */
    table: string;
    /** The ON condition, without the keyword. */
    on: string;
    alias: string;
}

export interface FromChain {
    head: string;
    anchor: { text: string; alias: string };
    joins: ParsedJoin[];
    tail: string;
}

const JOIN_KW =
    /\b((?:natural\s+)?(?:left|right|full|inner|cross|outer|asof|semi|anti)?(?:\s+outer)?\s*join)\b/gi;
const TAIL_KW =
    /\b(where|group\s+by|order\s+by|having|limit|offset|qualify|window|union|except|intersect)\b/i;

/** Positions of `re` that are outside parentheses and outside string data. */
function topLevel(sql: string, re: RegExp): { index: number; text: string }[] {
    const text = scannable(sql);
    const depth: number[] = [];
    let d = 0;
    for (let i = 0; i < text.length; i += 1) {
        if (text[i] === '(') d += 1;
        else if (text[i] === ')') d -= 1;
        depth[i] = d;
    }
    const out: { index: number; text: string }[] = [];
    const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    let m: RegExpExecArray | null;
    while ((m = rx.exec(text))) {
        if ((depth[m.index] ?? 0) === 0) out.push({ index: m.index, text: m[0] });
    }
    return out;
}

/** The alias a table expression introduces, or null when we cannot tell. */
export function aliasOf(tableExpr: string): string | null {
    const trimmed = tableExpr.trim().replace(/,$/, '');
    const as = /\bAS\s+("[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)\s*$/i.exec(trimmed);
    if (as) return as[1].replace(/^"|"$/g, '');
    // `FROM x y` — a trailing bare word after something else.
    const bare = /(?:^|[\s)"'])([A-Za-z_][A-Za-z0-9_$]*)\s*$/.exec(trimmed);
    if (bare && bare.index + bare[0].length === trimmed.length && /\s/.test(trimmed)) {
        return bare[1];
    }
    // `FROM duckle_src."Item"` — the last identifier names the relation.
    const last = /("[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)\s*$/.exec(trimmed);
    return last ? last[1].replace(/^"|"$/g, '') : null;
}

/** Split a SELECT into its FROM chain, or null for a shape we do not handle. */
export function parseFromChain(sql: string): FromChain | null {
    const fromAt = topLevel(sql, /\bfrom\b/i)[0];
    if (!fromAt) return null;
    const afterFrom = fromAt.index + fromAt.text.length;

    const joinAts = topLevel(sql, JOIN_KW).filter(j => j.index >= afterFrom);
    const scan = scannable(sql);
    const tailMatch = TAIL_KW.exec(scan.slice(afterFrom));
    const tailAt = tailMatch ? afterFrom + tailMatch.index : sql.length;
    // A tail that starts before the last join means the chain is interleaved
    // with something we are not modelling.
    if (joinAts.some(j => j.index > tailAt)) return null;

    const bounds = [...joinAts.map(j => j.index), tailAt];
    const anchorText = sql.slice(afterFrom, bounds[0]).trim();
    if (!anchorText || anchorText.includes(',')) return null; // comma join: not ours
    const anchorAlias = aliasOf(anchorText);
    if (!anchorAlias) return null;

    const joins: ParsedJoin[] = [];
    for (let i = 0; i < joinAts.length; i += 1) {
        const start = joinAts[i].index;
        const end = bounds[i + 1];
        const body = sql.slice(start + joinAts[i].text.length, end);
        const onAt = topLevel(body, /\bon\b/i)[0];
        if (!onAt) return null; // USING, or a cross join with no condition
        const table = body.slice(0, onAt.index).trim();
        const alias = aliasOf(table);
        if (!alias || table.includes(',')) return null;
        joins.push({
            keyword: joinAts[i].text.trim(),
            table,
            on: body.slice(onAt.index + onAt.text.length).trim(),
            alias,
        });
    }

    return {
        head: sql.slice(0, fromAt.index),
        anchor: { text: anchorText, alias: anchorAlias },
        joins,
        tail: sql.slice(tailAt),
    };
}

/** Aliases an ON condition depends on, other than the join's own. */
export function onDependencies(on: string, self: string): string[] {
    const out = new Set<string>();
    const re = /\b([A-Za-z_][A-Za-z0-9_$]*)\s*\.\s*[A-Za-z_][A-Za-z0-9_$]*\b/g;
    let m: RegExpExecArray | null;
    const text = scannable(on);
    while ((m = re.exec(text))) {
        if (m[1].toLowerCase() !== self.toLowerCase()) out.add(m[1]);
    }
    return [...out];
}

/** Joins whose ON names a table that is not in scope yet. */
export function forwardReferences(sql: string): string[] {
    const chain = parseFromChain(sql);
    if (!chain) return [];
    const scope = new Set([chain.anchor.alias.toLowerCase()]);
    const bad: string[] = [];
    for (const j of chain.joins) {
        scope.add(j.alias.toLowerCase());
        for (const dep of onDependencies(j.on, j.alias)) {
            if (!scope.has(dep.toLowerCase())) bad.push(dep);
        }
    }
    return [...new Set(bad)];
}

/**
 * Reorder the join chain so every ON only names tables already introduced.
 *
 * A STABLE topological sort: at each step it takes the first remaining join
 * whose dependencies are met, so a chain keeps the author's order wherever that
 * order was already fine and only what must move, moves. Returns `moved: false`
 * and the original text when nothing needs doing or the chain cannot be
 * satisfied — an unorderable chain means a reference to something that is not
 * in the query at all, which is a different problem and not one to paper over.
 */
export function reorderJoins(sql: string): { sql: string; moved: boolean } {
    if (forwardReferences(sql).length === 0) return { sql, moved: false };
    const chain = parseFromChain(sql);
    if (!chain) return { sql, moved: false };

    const scope = new Set([chain.anchor.alias.toLowerCase()]);
    const remaining = [...chain.joins];
    const ordered: ParsedJoin[] = [];
    while (remaining.length) {
        const i = remaining.findIndex(j =>
            onDependencies(j.on, j.alias).every(d => scope.has(d.toLowerCase())),
        );
        if (i < 0) return { sql, moved: false };
        const [j] = remaining.splice(i, 1);
        scope.add(j.alias.toLowerCase());
        ordered.push(j);
    }
    if (ordered.every((j, i) => j === chain.joins[i])) return { sql, moved: false };

    const body = ordered.map(j => `${j.keyword} ${j.table}\n  ON ${j.on}`).join('\n');
    const tail = chain.tail.trim();
    return {
        sql: `${chain.head}FROM ${chain.anchor.text}\n${body}${tail ? `\n${tail}` : ''}`,
        moved: true,
    };
}
