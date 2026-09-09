// Fork-owned unit tests for the RE2 wrapper (DataTonic). Pure in/out — no DOM,
// no Tauri. re2.ts is the only module that touches `re2js`, so these pin the
// DuckDB-facing behavior (RE2 rejects lookahead; `\N` backrefs in replace()).
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { compile, findMatches, matches, extract, replace } from './re2';

describe('compile', () => {
    it('reports capture-group count for a valid pattern', () => {
        expect(compile('(\\d+)-(\\d+)')).toEqual({ ok: true, groupCount: 2 });
    });
    it('rejects a syntactically invalid pattern', () => {
        expect(compile('(').ok).toBe(false);
    });
    it('rejects lookahead (RE2 has no support) — the DuckDB-wont-accept signal', () => {
        expect(compile('foo(?=bar)').ok).toBe(false);
    });
});

describe('findMatches', () => {
    it('finds every non-overlapping literal occurrence with spans', () => {
        const ms = findMatches('a', 'banana');
        expect(ms.map((m) => m.start)).toEqual([1, 3, 5]);
    });
    it('exposes capture-group spans including group 0', () => {
        const [m] = findMatches('(\\d+)-(\\d+)', '12-34');
        expect(m.text).toBe('12-34');
        expect(m.groups.map((g) => g.text)).toEqual(['12-34', '12', '34']);
    });
    it('does not loop forever on an empty-match pattern', () => {
        const ms = findMatches('b*', 'abc');
        expect(ms.length).toBeGreaterThan(0);
        expect(ms.length).toBeLessThanOrEqual('abc'.length + 1);
    });
});

describe('matches', () => {
    it('is true when the pattern occurs, false otherwise', () => {
        expect(matches('^a', 'abc')).toBe(true);
        expect(matches('^a', 'xabc')).toBe(false);
    });
    it('honors the ignoreCase flag', () => {
        expect(matches('abc', 'ABC')).toBe(false);
        expect(matches('abc', 'ABC', { ignoreCase: true })).toBe(true);
    });
    it('honors the dotAll flag (. matches newline)', () => {
        expect(matches('a.c', 'a\nc')).toBe(false);
        expect(matches('a.c', 'a\nc', { dotAll: true })).toBe(true);
    });
    it('honors the multiline flag (^ at line starts)', () => {
        expect(matches('^b', 'a\nb', { multiline: true })).toBe(true);
        expect(matches('^b', 'a\nb')).toBe(false);
    });
});

describe('extract', () => {
    it('pulls a capture group; group 0 is the whole match', () => {
        expect(extract('(\\d+)', 'x42y', 1)).toBe('42');
        expect(extract('(\\d+)', 'x42y', 0)).toBe('42');
    });
    it('returns "" for no match or an out-of-range group (DuckDB behavior)', () => {
        expect(extract('(\\d+)', 'xyz', 1)).toBe('');
        expect(extract('(\\d+)', 'x42y', 5)).toBe('');
    });
});

describe('replace', () => {
    it('applies \\N backrefs globally', () => {
        expect(replace('(\\w)(\\w)', 'ab cd', '\\2\\1')).toBe('ba dc');
    });
    it('\\0 is the whole match and \\\\ is a literal backslash', () => {
        expect(replace('\\d+', 'a12b', '[\\0]')).toBe('a[12]b');
        expect(replace('x', 'x', '\\\\')).toBe('\\');
    });
    it('an unmatched group substitutes to ""', () => {
        expect(replace('(a)(b)?', 'a', '\\1\\2')).toBe('a');
    });
    it('returns the input unchanged when nothing matches', () => {
        expect(replace('z', 'abc', 'Q')).toBe('abc');
    });
});

describe('properties (fast-check)', () => {
    // Literal alphabet keeps generated patterns metachar-free, so we can compare
    // against plain JS string semantics.
    const literal = fc
        .array(fc.constantFrom('a', 'b', 'c', 'd'), { minLength: 1, maxLength: 6 })
        .map((a) => a.join(''));
    const text = fc
        .array(fc.constantFrom('a', 'b', 'c', 'd'), { maxLength: 20 })
        .map((a) => a.join(''));

    it('matches(p,s) agrees with String.includes for literal patterns', () => {
        fc.assert(fc.property(literal, text, (p, s) => matches(p, s) === s.includes(p)));
    });

    it('findMatches count equals the non-overlapping occurrence count', () => {
        fc.assert(
            fc.property(literal, text, (p, s) => findMatches(p, s).length === s.split(p).length - 1),
        );
    });
});
