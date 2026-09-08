// Regex Studio — RE2 engine wrapper (DataTonic).
//
// DuckDB's regexp_* functions use Google RE2. `re2js` is a pure-JS port of the
// RE2/J algorithm, so evaluating patterns here matches exactly what DuckDB will
// accept/reject and how it captures — no WASM, no engine round-trip. This module
// is the ONLY place that touches `re2js`; the rest of the Studio speaks in the
// plain types below.
//
// Two DuckDB-specific choices to note:
//  - Replacement backrefs are `\0`..`\9` (RE2 / DuckDB syntax), NOT `$1`. re2js'
//    own replaceAll uses `$1`, so we substitute groups ourselves in `replace()`.
//  - `regexp_replace(..., 'g')` is global; `replace()` mirrors that (replace all).

import { RE2JS, RE2JSException } from 're2js';

export interface Re2Flags {
    ignoreCase?: boolean; // i
    multiline?: boolean; // m — ^/$ match line boundaries
    dotAll?: boolean; // s — . matches newline
}

export interface GroupSpan {
    index: number; // 0 = whole match, 1.. = capture groups
    start: number; // -1 when the group did not participate
    end: number;
    text: string | null;
}

export interface Re2Match {
    start: number;
    end: number;
    text: string;
    groups: GroupSpan[]; // includes group 0 (whole match) at index 0
}

export interface Re2Ok {
    ok: true;
    groupCount: number; // number of capture groups (excludes group 0)
}

export interface Re2Err {
    ok: false;
    message: string;
}

export type Re2Compile = Re2Ok | Re2Err;

function flagBits(f?: Re2Flags): number {
    let bits = 0;
    if (f?.ignoreCase) bits |= RE2JS.CASE_INSENSITIVE;
    if (f?.multiline) bits |= RE2JS.MULTILINE;
    if (f?.dotAll) bits |= RE2JS.DOTALL;
    return bits;
}

function humanize(e: unknown): string {
    if (e instanceof RE2JSException) return e.message;
    if (e instanceof Error) return e.message;
    return String(e);
}

/**
 * Compile a pattern and report validity. A failure here is the authoritative
 * "DuckDB won't accept this" signal — RE2 rejects lookahead/lookbehind and
 * backreferences, so those surface as errors, which is what we want to show.
 */
export function compile(pattern: string, flags?: Re2Flags): Re2Compile {
    try {
        const re = RE2JS.compile(pattern, flagBits(flags));
        const groupCount = re.matcher('').groupCount();
        return { ok: true, groupCount };
    } catch (e) {
        return { ok: false, message: humanize(e) };
    }
}

/**
 * All (non-overlapping, global) matches of `pattern` in `input`, each with its
 * capture-group spans. Throws only if the pattern is invalid — callers that
 * already linted with compile() can rely on it not throwing.
 */
export function findMatches(pattern: string, input: string, flags?: Re2Flags): Re2Match[] {
    const re = RE2JS.compile(pattern, flagBits(flags));
    const m = re.matcher(input);
    const count = m.groupCount();
    const out: Re2Match[] = [];
    let searchFrom = 0;
    while (m.find(searchFrom)) {
        const start = m.start();
        const end = m.end();
        const groups: GroupSpan[] = [];
        for (let g = 0; g <= count; g++) {
            const gs = m.start(g);
            const ge = m.end(g);
            groups.push({
                index: g,
                start: gs,
                end: ge,
                text: gs >= 0 ? m.group(g) : null,
            });
        }
        out.push({ start, end, text: m.group(0) ?? '', groups });
        // Advance past this match; step by one on an empty match to avoid a loop.
        searchFrom = end > start ? end : end + 1;
        if (searchFrom > input.length) break;
    }
    return out;
}

/** True if the pattern matches anywhere in the input (DuckDB regexp_matches). */
export function matches(pattern: string, input: string, flags?: Re2Flags): boolean {
    return RE2JS.compile(pattern, flagBits(flags)).test(input);
}

/**
 * Extract a single capture group (DuckDB regexp_extract). Group 0 = whole match.
 * Returns '' when there is no match or the group did not participate — matching
 * DuckDB, which yields an empty string rather than null.
 */
export function extract(pattern: string, input: string, group = 0, flags?: Re2Flags): string {
    const m = RE2JS.compile(pattern, flagBits(flags)).matcher(input);
    if (!m.find()) return '';
    if (group > m.groupCount()) return '';
    return m.group(group) ?? '';
}

/**
 * Global replace with DuckDB `\N` backref semantics (regexp_replace(..,'g')).
 * `\0` = whole match, `\1`..`\9` = groups, `\\` = literal backslash. An
 * unmatched group substitutes to ''. Non-backref text is copied verbatim.
 */
export function replace(
    pattern: string,
    input: string,
    replacement: string,
    flags?: Re2Flags,
): string {
    const matchesList = findMatches(pattern, input, flags);
    if (matchesList.length === 0) return input;
    let out = '';
    let cursor = 0;
    for (const match of matchesList) {
        out += input.slice(cursor, match.start);
        out += substitute(replacement, match);
        cursor = match.end;
    }
    out += input.slice(cursor);
    return out;
}

function substitute(replacement: string, match: Re2Match): string {
    let res = '';
    for (let i = 0; i < replacement.length; i++) {
        const ch = replacement[i];
        if (ch === '\\' && i + 1 < replacement.length) {
            const next = replacement[i + 1];
            if (next >= '0' && next <= '9') {
                const g = match.groups[Number(next)];
                res += g?.text ?? '';
                i++;
                continue;
            }
            if (next === '\\') {
                res += '\\';
                i++;
                continue;
            }
            // Unknown escape: keep the backslash literally (DuckDB is lenient).
            res += ch;
            continue;
        }
        res += ch;
    }
    return res;
}
