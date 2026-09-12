// Checking a generated query against the schema it was given.
//
// The failure this exists for: asked to filter by `VendorName`, a small model
// wrote `VendorItem.VendorName` — a column that lives on `Vendor`, one join
// away. The names look related, so the guess is a reasonable one to make and a
// fatal one to run.
//
// Checked rather than executed, and that is the whole design choice. Running
// the draft would also catch it, but it costs a DuckDB spawn, it may be an
// expensive query, and what comes back is `Binder Error: Cannot extract field
// 'VendorName' from expression 'VendorItem' because it is not a struct` — which
// does not say where VendorName actually is. We hold the full column list, so
// we can say exactly that, and hand the model a correction it can act on.
//
// Useful on BOTH paths. Nothing here needs an address, so a node's SQL Studio
// gets the same check over its working-DB catalog.

import { joinSql, quoteIdent, type ErdRelationship } from '../erd/model';
import { scannable, splitLiterals } from './qualify';
import type { SqlStudioTable } from './types';

/** Words that end the table expression after FROM/JOIN. */
const CLAUSE = new Set([
    'on', 'using', 'where', 'group', 'order', 'having', 'limit', 'offset', 'join', 'inner',
    'left', 'right', 'full', 'cross', 'outer', 'natural', 'union', 'except', 'intersect',
    'qualify', 'window', 'select', 'asof', 'anti', 'semi', 'lateral',
]);

export interface ColumnProblem {
    /** As written, e.g. `VendorItem.VendorName`. */
    ref: string;
    /** The alias the column was hung off. */
    alias: string;
    /** The table that alias resolves to. */
    table: string;
    column: string;
    /** Tables that DO have a column of this name. Empty when nothing does. */
    foundOn: string[];
}

const bare = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const unquote = (s: string) => (s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s);


/**
 * Which table each alias in the query refers to.
 *
 * Resolved by finding the longest known table NAME mentioned in the table
 * expression, which works across all the forms in play: `Item`,
 * `duckle_src."Item"`, and `read_parquet('…/item_norm.parquet')`. Longest-first
 * so `Item` cannot claim `VendorItem`.
 */
export function aliasMap(sql: string, tables: SqlStudioTable[]): Map<string, SqlStudioTable> {
    const byLength = [...tables].sort((a, b) => b.name.length - a.name.length);
    const out = new Map<string, SqlStudioTable>();

    {
        const text = scannable(sql);
        const re = /\b(from|join)\s+([\s\S]*?)(?=$|\b(?:on|where|group|order|having|limit|offset|join|inner|left|right|full|cross|outer|natural|union|except|intersect|qualify|window)\b)/gi;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text))) {
            const chunk = m[2].trim().replace(/[,;]+$/, '');
            if (!chunk) continue;
            // The table this expression reads. A literal path counts: the
            // parquet reader names the file, and the file names the dataset.
            const hit = byLength.find(t => chunk.toLowerCase().includes(t.name.toLowerCase()));
            if (!hit) continue;
            // The alias, if one was given. `AS x` first; otherwise a trailing
            // bare word that is not part of the expression itself.
            const asMatch = /\bAS\s+("[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)\s*$/i.exec(chunk);
            let alias = asMatch ? unquote(asMatch[1]) : hit.name;
            if (!asMatch) {
                const tail = /(?:^|[\s)"'])([A-Za-z_][A-Za-z0-9_$]*)\s*$/.exec(chunk);
                const word = tail?.[1];
                if (
                    word &&
                    word.toLowerCase() !== hit.name.toLowerCase() &&
                    !CLAUSE.has(word.toLowerCase()) &&
                    !chunk.toLowerCase().endsWith(`"${word.toLowerCase()}"`)
                ) {
                    alias = word;
                }
            }
            out.set(alias.toLowerCase(), hit);
        }
    }
    return out;
}

/**
 * Words that are never a column reference, so a bare one can be ignored.
 *
 * Deliberately generous. A word wrongly left OUT of this list costs nothing —
 * the check below only acts on words it independently recognises as column
 * names — whereas a word wrongly left IN could mask a real problem.
 */
const SQL_WORDS = new Set([
    'select', 'from', 'where', 'join', 'inner', 'left', 'right', 'full', 'cross', 'outer',
    'natural', 'on', 'using', 'group', 'by', 'order', 'having', 'limit', 'offset', 'as', 'and',
    'or', 'not', 'in', 'is', 'null', 'like', 'ilike', 'between', 'case', 'when', 'then', 'else',
    'end', 'distinct', 'all', 'union', 'except', 'intersect', 'with', 'asc', 'desc', 'nulls',
    'first', 'last', 'true', 'false', 'exists', 'any', 'some', 'cast', 'over', 'partition',
    'window', 'qualify', 'lateral', 'asof', 'semi', 'anti', 'positional', 'tablesample', 'values',
    'interval', 'date', 'time', 'timestamp', 'filter', 'within', 'rows', 'range', 'preceding',
    'following', 'unbounded', 'current', 'row', 'exclude', 'replace', 'similar', 'escape',
]);

/**
 * Bare columns that nothing in the query can supply.
 *
 * The gap the qualified check leaves, and the one that let a broken draft
 * through: `WHERE VendorName = 'Medline'` names no table, so there is no alias
 * to judge it against — but `VendorName` is not on ANY table in the FROM chain,
 * which makes it exactly as wrong as `VendorItem.VendorName` was, and DuckDB
 * says so in the same breath: `Referenced column "VendorName" not found in
 * FROM clause!`
 *
 * Safe because it only speaks up about words it can positively identify as
 * column names SOMEWHERE in the catalog. An unrecognised word is left alone —
 * it may be a function, a keyword this list does not know, or an alias the
 * query defined — so the failure mode is missing a problem, never inventing
 * one.
 */
function unqualifiedProblems(
    sql: string,
    tables: SqlStudioTable[],
    aliases: Map<string, SqlStudioTable>,
): ColumnProblem[] {
    const reachable = new Set<string>();
    for (const t of aliases.values()) {
        for (const c of t.columns) reachable.add(c.name.toLowerCase());
    }
    const out: ColumnProblem[] = [];
    const seen = new Set<string>();
    for (const seg of splitLiterals(sql)) {
        // Code only — a quoted identifier is handled by the qualified pass, and
        // a string is data.
        if (!seg.code) continue;
        const re = /[A-Za-z_][A-Za-z0-9_$]*/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(seg.text))) {
            const word = m[0];
            const lower = word.toLowerCase();
            if (SQL_WORDS.has(lower) || seen.has(lower) || aliases.has(lower)) continue;
            const before = seg.text.slice(Math.max(0, m.index - 8), m.index);
            const after = seg.text.slice(m.index + word.length, m.index + word.length + 2);
            if (/\.\s*$/.test(before)) continue; // already qualified
            if (/\bas\s+$/i.test(before)) continue; // an alias being defined
            if (/^\s*[.(]/.test(after)) continue; // a qualifier, or a function call
            if (reachable.has(lower)) continue; // a table in the query has it
            const foundOn = tables
                .filter(t => t.columns.some(c => c.name.toLowerCase() === lower))
                .map(t => t.name);
            if (foundOn.length === 0) continue; // not a column we recognise
            seen.add(lower);
            out.push({ ref: word, alias: '', table: '', column: word, foundOn });
        }
    }
    return out;
}

/**
 * Column references that the schema says cannot exist.
 *
 * Only qualified references (`alias.column`) are checked, and only against
 * tables whose columns we actually read. An unqualified column could belong to
 * any table in scope, and a table whose probe failed has an empty column list —
 * reporting either as an error would be inventing a problem out of our own
 * missing information, which is worse than missing a real one.
 */
export function validateColumns(sql: string, tables: SqlStudioTable[]): ColumnProblem[] {
    const aliases = aliasMap(sql, tables);
    if (aliases.size === 0) return [];
    const problems: ColumnProblem[] = [];
    const seen = new Set<string>();

    {
        const text = scannable(sql);
        const re = /\b([A-Za-z_][A-Za-z0-9_$]*)\s*\.\s*([A-Za-z_][A-Za-z0-9_$]*)\b/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text))) {
            const [ref, alias, column] = m;
            const table = aliases.get(alias.toLowerCase());
            // Not an alias (a schema qualifier like `duckle_src.Item`), or a
            // table we could not read — either way, not ours to judge.
            if (!table || table.columns.length === 0) continue;
            if (table.columns.some(c => c.name.toLowerCase() === column.toLowerCase())) continue;
            if (seen.has(ref.toLowerCase())) continue;
            seen.add(ref.toLowerCase());
            problems.push({
                ref,
                alias,
                table: table.name,
                column,
                foundOn: tables
                    .filter(t => t.columns.some(c => c.name.toLowerCase() === column.toLowerCase()))
                    .map(t => t.name),
            });
        }
    }
    return [...problems, ...unqualifiedProblems(sql, tables, aliases)];
}

/**
 * Tables the query READS FROM but never joined.
 *
 * The second half of the same mistake, and the one a column check alone misses.
 * Told that VendorName lives on Vendor, a model will happily write
 * `WHERE Vendor.VendorName = 'Medline'` and stop — it took the correction
 * literally and never added Vendor to the FROM chain. Every column reference is
 * then valid against the table it names, so nothing above complains, and DuckDB
 * fails with the same unhelpful "not a struct".
 *
 * Only KNOWN table names count. An unrecognised qualifier is somebody's own
 * alias for something we cannot see, and guessing at it would report a problem
 * that is not there.
 */
export function missingTables(sql: string, tables: SqlStudioTable[]): string[] {
    const aliases = aliasMap(sql, tables);
    const known = new Map(tables.map(t => [t.name.toLowerCase(), t.name]));
    const out: string[] = [];
    const text = scannable(sql);
    const re = /\b([A-Za-z_][A-Za-z0-9_$]*)\s*\.\s*([A-Za-z_][A-Za-z0-9_$]*)\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
        const q = m[1].toLowerCase();
        const name = known.get(q);
        if (!name || aliases.has(q) || out.includes(name)) continue;
        out.push(name);
    }
    return out;
}

/**
 * Every JOIN needed to reach `target` from the tables already in the query.
 *
 * A path, not a hop. `Vendor` may be two joins from `Item` — through
 * `VendorItem` — and offering only the last one is an instruction that cannot
 * be followed, which is how the model ended up cycling: told to join Vendor, it
 * had nothing to join Vendor ON.
 *
 * Breadth-first, so the answer is the FEWEST joins. A longer path through more
 * tables is not merely slower — every extra join is another chance to multiply
 * rows, and a row count nobody expected is the kind of wrong that gets reported.
 *
 * Returns `[]` when the target is already there, and null when the ER model
 * does not connect it at all — which is a real answer, not a failure: without a
 * relationship there is no join we could honestly propose.
 */
export function joinPath(
    target: string,
    present: Iterable<string>,
    tables: SqlStudioTable[],
    relationships: ErdRelationship[],
): string[] | null {
    const goal = target.toLowerCase();
    const have = new Set([...present].map(s => s.toLowerCase()));
    if (have.has(goal)) return [];

    const adj = new Map<string, { other: string; rel: ErdRelationship }[]>();
    const link = (a: string, b: string, rel: ErdRelationship) => {
        const k = a.toLowerCase();
        adj.set(k, [...(adj.get(k) ?? []), { other: b, rel }]);
    };
    // Undirected: a relationship is readable from either end.
    for (const r of relationships) {
        link(r.fromTable, r.toTable, r);
        link(r.toTable, r.fromTable, r);
    }

    const prev = new Map<string, { from: string; rel: ErdRelationship }>();
    const seen = new Set(have);
    const queue = [...have];
    while (queue.length) {
        const cur = queue.shift() as string;
        if (cur === goal) break;
        for (const e of adj.get(cur) ?? []) {
            const k = e.other.toLowerCase();
            if (seen.has(k)) continue;
            seen.add(k);
            prev.set(k, { from: cur, rel: e.rel });
            queue.push(k);
        }
    }
    if (!prev.has(goal)) return null;

    const chain: { table: string; rel: ErdRelationship }[] = [];
    for (let cur = goal; prev.has(cur); ) {
        const step = prev.get(cur) as { from: string; rel: ErdRelationship };
        chain.unshift({ table: cur, rel: step.rel });
        cur = step.from;
    }
    return chain.map(step => {
        const t = tables.find(x => x.name.toLowerCase() === step.table);
        const name = t?.name ?? step.table;
        return `JOIN ${t?.from ?? quoteIdent(name)} AS ${quoteIdent(name)} ON ${joinSql(step.rel)}`;
    });
}

/** The first join of the path — kept for callers that want one line. */
export function joinSuggestion(
    missing: string,
    present: Iterable<string>,
    tables: SqlStudioTable[],
    relationships: ErdRelationship[],
): string | null {
    const path = joinPath(missing, present, tables, relationships);
    return path && path.length ? path[path.length - 1] : null;
}

/** Columns that exist on more than one table — the ones only a person can settle. */
export function ambiguousColumns(problems: ColumnProblem[]): ColumnProblem[] {
    return problems.filter(p => p.foundOn.length > 1);
}

/**
 * The correction sent back to the model.
 *
 * Says where the column IS and what join to add, not merely that something is
 * wrong — a model told only "that is wrong" tends to move the column somewhere
 * equally invented, or to drop the filter and answer a different question.
 */
export function repairPrompt(
    problems: ColumnProblem[],
    missing: string[] = [],
    tables: SqlStudioTable[] = [],
    relationships: ErdRelationship[] = [],
    present: Iterable<string> = [],
): string {
    const lines = ['That query will not run. Fix these and return the corrected SQL only:'];

    /** The joins to reach `table`, spelled out, or a plain instruction. */
    const reach = (table: string): string => {
        const path = joinPath(table, present, tables, relationships);
        if (path === null) {
            return `Add ${table} to the FROM chain (the schema lists no relationship reaching it, so choose the join yourself).`;
        }
        if (path.length === 0) return `${table} is already in the FROM chain — read the column off it.`;
        // Every hop, in order. One hop is useless when the table is two away:
        // told only the last join, the model has nothing to join it ON.
        return `Add these joins, in this order:\n    ${path.join('\n    ')}`;
    };

    for (const p of problems) {
        if (p.foundOn.length === 0) {
            lines.push(
                `- ${p.ref} does not exist, and no table in the schema has a column named ${p.column}. Use a column that is listed.`,
            );
            continue;
        }
        // One table by here: an ambiguous column was settled with the person
        // before this prompt was built. Naming two would be the riddle again.
        const target = p.foundOn[0];
        lines.push(
            p.alias
                ? `- ${p.ref} does not exist. ${p.column} is on ${target}. ${reach(target)}`
                : `- ${p.ref} is not on any table in the query. It is on ${target}. ${reach(target)}`,
        );
        lines.push(`  Then write ${target}.${p.column} instead of ${p.ref}.`);
    }
    for (const t of missing) {
        lines.push(`- ${t} is used but never joined. ${reach(t)}`);
    }
    return lines.join('\n');
}

/** The same problems, said to a person. */
export function problemSummary(problems: ColumnProblem[], missing: string[] = []): string {
    const parts = problems.map(p => {
        if (!p.foundOn.length) return `${p.ref} does not exist.`;
        const where = p.foundOn.join(', ');
        return p.alias
            ? `${p.ref} does not exist — ${p.column} is on ${where}.`
            : `${p.ref} is not on any table in the query — it is on ${where}.`;
    });
    for (const t of missing) parts.push(`${t} is referenced but never joined.`);
    return parts.join(' ');
}

/**
 * The `table.column` pairs the ER model uses as join keys.
 *
 * Worth naming in the prompt because nothing else in the schema distinguishes
 * them. Everything arrives from the API as text, so DuckDB reports `Vendor` and
 * `VendorName` as the same type — one holds a code, the other holds something a
 * person would recognise, and only the ER model knows which is which. Without
 * that, `VendorItem.Vendor = 'Medline'` is a perfectly type-correct guess, and
 * it returns zero rows rather than an error.
 */
export function joinKeyColumns(relationships: ErdRelationship[]): string[] {
    const out = new Set<string>();
    for (const r of relationships) {
        out.add(`${r.fromTable}.${r.fromColumn}`);
        out.add(`${r.toTable}.${r.toColumn}`);
    }
    return [...out];
}

/** A column → tables index, for the prompt. */
export function columnIndex(tables: SqlStudioTable[]): string {
    const byColumn = new Map<string, string[]>();
    for (const t of tables) {
        for (const c of t.columns) {
            const list = byColumn.get(c.name) ?? [];
            if (!list.includes(t.name)) list.push(t.name);
            byColumn.set(c.name, list);
        }
    }
    if (byColumn.size === 0) return '';
    // Inverted on purpose. The schema above answers "what is on this table",
    // which is the wrong direction for the question a request actually asks —
    // "where does VendorName live" — and making the model invert it itself is
    // exactly the step it got wrong.
    const lines = ['Where each column lives (a column exists ONLY on the tables listed):'];
    for (const [col, ts] of [...byColumn].sort((a, b) => a[0].localeCompare(b[0]))) {
        lines.push(`  ${col}: ${ts.join(', ')}`);
    }
    return lines.join('\n');
}

export { bare as isBareIdentifier };
