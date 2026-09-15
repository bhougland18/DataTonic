import { describe, expect, it } from 'vitest';
import {
    parseQueryFile,
    queryHeader,
    queryId,
    removeQuery,
    stripQueryHeader,
    upsertQuery,
    withQueryHeader,
    type SavedQuery,
} from './query-io';

const q = (over: Partial<SavedQuery> & { id: string; title: string }): SavedQuery => ({
    query: { sql: 'SELECT 1' },
    ...over,
});

describe('queryId', () => {
    it('slugifies the title so the id reads as the thing it names', () => {
        expect(queryId('Items by vendor')).toMatch(/^items-by-vendor-[a-z0-9]{5}$/);
    });

    it('falls back rather than producing a bare suffix', () => {
        expect(queryId('!!!')).toMatch(/^query-[a-z0-9]{5}$/);
    });

    it('does not collide for the same title twice', () => {
        expect(queryId('Items')).not.toBe(queryId('Items'));
    });
});

describe('upsertQuery', () => {
    it('adds a new query at the top', () => {
        const list = upsertQuery([q({ id: 'a', title: 'A' })], q({ id: 'b', title: 'B' }));
        expect(list.map(x => x.id)).toEqual(['b', 'a']);
    });

    it('replaces in place when the id already exists', () => {
        const list = upsertQuery(
            [q({ id: 'a', title: 'A' }), q({ id: 'b', title: 'B' })],
            q({ id: 'a', title: 'A', query: { sql: 'SELECT 2' } }),
        );
        expect(list).toHaveLength(2);
        expect(list[0].query.sql).toBe('SELECT 2');
    });

    // Saving twice under the same name is a revision, not a second query — a
    // list that grows a near-duplicate on every save stops being useful.
    it('merges onto an existing entry with the same title', () => {
        const list = upsertQuery(
            [q({ id: 'old', title: 'Items by vendor' })],
            q({ id: 'new', title: 'Items by vendor', query: { sql: 'SELECT 2' } }),
        );
        expect(list).toHaveLength(1);
        expect(list[0].id).toBe('old');
        expect(list[0].query.sql).toBe('SELECT 2');
    });

    it('stamps updatedAt on every save', () => {
        const list = upsertQuery([], q({ id: 'a', title: 'A' }));
        expect(Date.parse(list[0].meta?.updatedAt ?? '')).toBeGreaterThan(0);
    });

    it('keeps createdAt when one was supplied', () => {
        const created = '2020-01-01T00:00:00.000Z';
        const list = upsertQuery([], q({ id: 'a', title: 'A', meta: { createdAt: created } }));
        expect(list[0].meta?.createdAt).toBe(created);
    });
});

describe('removeQuery', () => {
    it('drops only the named query', () => {
        const list = removeQuery([q({ id: 'a', title: 'A' }), q({ id: 'b', title: 'B' })], 'a');
        expect(list.map(x => x.id)).toEqual(['b']);
    });
});

describe('the title/description header', () => {
    it('writes name and description as leading comments', () => {
        expect(queryHeader('Items by vendor', 'Medline only')).toBe(
            '-- name: Items by vendor\n-- description: Medline only',
        );
    });

    it('omits the description line when there is none', () => {
        expect(queryHeader('Items')).toBe('-- name: Items');
    });

    // A comment cannot span a line break, so a pasted multi-line description
    // would turn its second line into SQL.
    it('flattens newlines so a comment cannot break out into the query', () => {
        expect(queryHeader('A', 'one\ntwo')).toBe('-- name: A\n-- description: one two');
    });

    it('re-saving replaces the header instead of stacking one', () => {
        const once = withQueryHeader('SELECT 1', 'A', 'first');
        const twice = withQueryHeader(once, 'B', 'second');
        expect(twice).toBe('-- name: B\n-- description: second\n\nSELECT 1');
    });

    // Only the labelled lines are ours. An author's own leading comment is
    // theirs, and eating it would be a silent edit to their query.
    it("leaves the author's own leading comment alone", () => {
        const sql = '-- rough draft, check the join\nSELECT 1';
        expect(stripQueryHeader(sql)).toBe(sql);
    });

    it('keeps the body intact through a round trip', () => {
        const body = 'SELECT *\nFROM duckle_src."Item" AS Item\n-- inline note\nWHERE x = 1';
        expect(stripQueryHeader(withQueryHeader(body, 'T', 'D'))).toBe(body);
    });
});

describe('parseQueryFile', () => {
    it('reads back what exportQueries writes', () => {
        const file = JSON.stringify({
            kind: 'duckle.saved-queries',
            version: 1,
            queries: [{ id: 'a', title: 'A', query: { sql: 'SELECT 1' } }],
        });
        expect(parseQueryFile(file).map(q => q.id)).toEqual(['a']);
    });

    it('refuses a JSON file that is not ours', () => {
        expect(() => parseQueryFile('{"kind":"something-else","queries":[]}')).toThrow();
    });

    it('drops malformed entries rather than the whole file', () => {
        const file = JSON.stringify({
            kind: 'duckle.saved-queries',
            version: 1,
            queries: [{ id: 'a', title: 'A', query: { sql: 'SELECT 1' } }, { id: 'b' }],
        });
        expect(parseQueryFile(file)).toHaveLength(1);
    });
});

// §7a: the SQL, the chart and the builder state that produced it are ONE
// artefact. These pin the two fields that make a saved query a whole dive.
describe('a saved query carries its chart and its builder state', () => {
    const full = q({
        id: 'a',
        title: 'Items per vendor',
        chart: { mark: 'bar', encoding: { x: { field: 'Vendor', type: 'nominal' } } },
        builder: { schemaVersion: 1, columns: [], joins: [], filters: undefined } as never,
    });

    it('keeps both through an export/import round trip', () => {
        const file = JSON.stringify({
            kind: 'duckle.saved-queries',
            version: 1,
            queries: [full],
        });
        const [back] = parseQueryFile(file);
        expect(back.chart).toEqual(full.chart);
        expect(back.builder).toEqual(full.builder);
    });

    // A query saved before the Charts step existed, and a hand-written one.
    // Both are ordinary, so neither may be dropped.
    it('still accepts a query with neither', () => {
        const file = JSON.stringify({
            kind: 'duckle.saved-queries',
            version: 1,
            queries: [{ id: 'a', title: 'A', query: { sql: 'SELECT 1' } }],
        });
        const [back] = parseQueryFile(file);
        expect(back.chart).toBeUndefined();
        expect(back.builder).toBeUndefined();
    });

    // The SQL is the part worth keeping, so a bad optional field costs itself
    // rather than the query. Both reach code that indexes into them.
    it('strips a chart that is not an object, keeping the query', () => {
        const file = JSON.stringify({
            kind: 'duckle.saved-queries',
            version: 1,
            queries: [{ id: 'a', title: 'A', query: { sql: 'SELECT 1' }, chart: 'bar' }],
        });
        const [back] = parseQueryFile(file);
        expect(back.query.sql).toBe('SELECT 1');
        expect(back.chart).toBeUndefined();
    });

    it('strips builder state that is not builder state', () => {
        const file = JSON.stringify({
            kind: 'duckle.saved-queries',
            version: 1,
            queries: [{ id: 'a', title: 'A', query: { sql: 'SELECT 1' }, builder: { columns: 3 } }],
        });
        const [back] = parseQueryFile(file);
        expect(back.builder).toBeUndefined();
    });

    it('carries both through an upsert', () => {
        const [back] = upsertQuery([], full);
        expect(back.chart).toEqual(full.chart);
        expect(back.builder).toEqual(full.builder);
    });
});
