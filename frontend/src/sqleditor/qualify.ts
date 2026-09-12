// Repairing a generated query so it addresses the tables it was given.
//
// The prompt tells the model to write the FROM/JOIN expression each table
// lists. A small local model does it most of the time, which is not the same as
// always — and the failure is total: `FROM Item` gets `Catalog Error: Table
// with name Item does not exist`, no rows, no partial answer.
//
// So the instruction stays (it is what makes the common case right) and this
// fixes up what comes back. Deterministic, no model involved: a bare table name
// in FROM/JOIN position that exactly matches one we handed over is rewritten to
// that table's address. Nothing else is touched.

import { quoteIdent } from '../erd/model';
import type { SqlStudioTable } from './types';

/**
 * Drop a trailing statement terminator.
 *
 * The engine wraps a custom query as `({sql})` (`build_duckdb_source`), so a
 * terminator that is correct everywhere else lands INSIDE the parentheses and
 * dies at the parser: `…'Medline';); DETACH duckle_src_block_sql;`.
 *
 * Stripped rather than asked for, because every writer hits it: Blocks' own
 * starter query ended `LIMIT 100;` and so could never have run, the AI adds one
 * because a terminator is correct in nearly every example it has seen, and a
 * person pasting from another SQL tool brings one along. A rule three
 * independent writers break is a rule the caller should stop having.
 *
 * Only the trailing one goes. An interior `;` means a second statement, which a
 * view body genuinely cannot hold, and silently discarding half of what was
 * typed is worse than the parser error that explains it.
 */
export function stripTerminator(sql: string): string {
    return sql.replace(/;\s*$/, '');
}

/**
 * Words that may follow a table name without being an alias.
 *
 * Needed because `FROM Item WHERE x` and `FROM Item i` are the same shape —
 * identifier, whitespace, identifier — and only the second one is an alias.
 * Getting this wrong turns a keyword into an alias and silently changes the
 * query, so the list is the conservative direction: anything NOT here is
 * treated as an alias and left alone.
 */
const KEYWORDS = new Set([
    'where', 'on', 'using', 'join', 'inner', 'left', 'right', 'full', 'cross',
    'outer', 'natural', 'group', 'order', 'limit', 'offset', 'having', 'union',
    'except', 'intersect', 'window', 'qualify', 'select', 'from', 'and', 'or',
    'as', 'with', 'lateral', 'tablesample', 'asof', 'positional', 'anti', 'semi',
]);

const IDENT = /[A-Za-z_][A-Za-z0-9_$]*/y;

export interface SqlSegment {
    /** True for ordinary SQL; false for a quoted run. */
    code: boolean;
    text: string;
    /** Which quote opened this run, for callers that treat the two
     *  differently. `'` is data and opaque; `"` is an identifier and so still
     *  names a table — a distinction "is it a table reference" needs and
     *  "should I rewrite this" does not. */
    quote?: "'" | '"';
}

/**
 * Split SQL into code and literal runs, so rewriting never reaches inside a
 * string or a quoted identifier. `WHERE note = 'see FROM Item'` is not a table
 * reference, and a rewrite that could not tell the difference would corrupt
 * data rather than fix a query.
 */
export function splitLiterals(sql: string): SqlSegment[] {
    const out: SqlSegment[] = [];
    let buf = '';
    let i = 0;
    while (i < sql.length) {
        const c = sql[i];
        if (c === "'" || c === '"') {
            if (buf) out.push({ code: true, text: buf });
            buf = '';
            const quote = c;
            let j = i + 1;
            while (j < sql.length) {
                if (sql[j] === quote) {
                    // A doubled quote is an escaped one, not the end.
                    if (sql[j + 1] === quote) j += 2;
                    else break;
                } else j += 1;
            }
            out.push({
                code: false,
                text: sql.slice(i, Math.min(j + 1, sql.length)),
                quote: quote as "'" | '"',
            });
            i = j + 1;
            continue;
        }
        buf += c;
        i += 1;
    }
    if (buf) out.push({ code: true, text: buf });
    return out;
}

/**
 * The SQL with string DATA blanked out but quoted IDENTIFIERS left in place.
 *
 * Only `'…'` is data. `"…"` is an identifier — the table in
 * `duckle_src."Item"` — so a scan that skipped it could not see any table at
 * all. Blanked to the same length rather than removed, so every offset in the
 * result still lines up with the original string.
 */
export function scannable(sql: string): string {
    return splitLiterals(sql)
        .map(seg => (seg.quote === "'" ? ' '.repeat(seg.text.length) : seg.text))
        .join('');
}

/** Read the identifier at `from`, or null. */
function identAt(s: string, from: number): { text: string; end: number } | null {
    IDENT.lastIndex = from;
    const m = IDENT.exec(s);
    return m ? { text: m[0], end: from + m[0].length } : null;
}

/**
 * Rewrite bare table names in FROM/JOIN position to the addresses they were
 * given. Returns the SQL unchanged when nothing needs an address.
 *
 * An alias the model chose for itself is KEPT: `FROM Item AS T1` becomes
 * `FROM duckle_src.Item AS T1`, not `AS Item`. A model that renames tables
 * renames them consistently, so its own `T1.Item` references still resolve —
 * whereas forcing our alias back on would break every one of them. Only when
 * there is no alias do we add one, and then it is the table's own name, which
 * is what the ER model's join keys are stated in.
 */
export function qualifyTables(sql: string, tables: SqlStudioTable[]): string {
    // Matched as whole NAMES, longest first, not as parsed identifiers. A
    // file-derived dataset is called `item_norm.parquet` — the dot is part of
    // its name — so reading one identifier and treating the dot as "already
    // qualified" would skip exactly the table that most needs rewriting.
    // Longest-first stops `Item` matching the front of `item_norm.parquet`.
    const addressed = tables
        .filter(t => t.from && t.from !== t.name)
        .sort((a, b) => b.name.length - a.name.length);
    if (addressed.length === 0) return sql;

    /** The table whose name starts at `pos`, if any, as a whole token. */
    const matchAt = (s: string, pos: number): SqlStudioTable | null => {
        for (const t of addressed) {
            if (s.slice(pos, pos + t.name.length).toLowerCase() !== t.name.toLowerCase()) continue;
            const after = s[pos + t.name.length];
            // A longer identifier, or a qualified reference to something else.
            if (after && (/[A-Za-z0-9_$]/.test(after) || after === '.')) continue;
            return t;
        }
        return null;
    };

    return splitLiterals(sql)
        .map(seg => {
            if (!seg.code) return seg.text;
            let out = '';
            let i = 0;
            const s = seg.text;
            while (i < s.length) {
                const kw = identAt(s, i);
                if (!kw || !['from', 'join'].includes(kw.text.toLowerCase())) {
                    // Skip a whole identifier at a time; stepping one char would
                    // let `xfrom` match `from` halfway through.
                    out += kw ? kw.text : s[i];
                    i = kw ? kw.end : i + 1;
                    continue;
                }
                out += kw.text;
                i = kw.end;
                // The gap, then what is being read from.
                const ws = /\s+/y;
                ws.lastIndex = i;
                const gap = ws.exec(s);
                if (!gap) continue;
                const at = i + gap[0].length;
                const hit = matchAt(s, at);
                if (!hit) continue;
                out += gap[0] + hit.from;
                i = at + hit.name.length;
                // Keep the model's alias if it gave one; otherwise supply the
                // table's own name so the join keys still match.
                const ws2 = /\s+/y;
                ws2.lastIndex = i;
                const gap2 = ws2.exec(s);
                const next = gap2 ? identAt(s, i + gap2[0].length) : null;
                // `AS` is in KEYWORDS (it is not itself an alias) but it
                // announces one, so it counts as already-aliased.
                const aliased =
                    !!next &&
                    (next.text.toLowerCase() === 'as' || !KEYWORDS.has(next.text.toLowerCase()));
                if (!aliased) out += ` AS ${quoteIdent(hit.name)}`;
            }
            return out;
        })
        .join('');
}
