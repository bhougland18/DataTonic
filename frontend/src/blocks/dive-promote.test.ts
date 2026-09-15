import { describe, expect, it } from 'vitest';
import { DIVE_SCHEMA_VERSION } from '../dives/dive-types';
import { parseDive } from '../dives/dive-types';
import { withQueryHeader } from './query-io';
import { asDive, datasetKey, diveId, hasChart, sameDataset, toDive } from './dive-promote';

const CHART = { mark: 'bar', encoding: { x: { field: 'Vendor', type: 'nominal' } } };
const SQL = 'SELECT Vendor.VendorName, count(Item.Item) AS "count Item.Item" FROM Vendor';

describe('diveId', () => {
    it('slugifies the title, so the filename says what it holds', () => {
        expect(diveId('Items per vendor')).toMatch(/^items-per-vendor-[a-z0-9]{5}$/);
    });

    it('falls back rather than producing a bare suffix', () => {
        expect(diveId('!!!')).toMatch(/^dive-[a-z0-9]{5}$/);
    });
});

describe('toDive', () => {
    it('produces something Duckle itself will open', () => {
        // The real gate: `parseDive` is what every other dive surface uses, so
        // a dive this app writes and Duckle refuses would be worse than none.
        const r = parseDive(toDive({ title: 'Items per vendor', sql: SQL, chart: CHART }));
        expect(r.ok, r.error).toBe(true);
    });

    it('carries the version, the query and the chart', () => {
        const d = toDive({ title: 'T', sql: SQL, chart: CHART });
        expect(d.diveSchemaVersion).toBe(DIVE_SCHEMA_VERSION);
        expect(d.query.sql).toBe(SQL);
        expect(d.chart).toEqual(CHART);
    });

    // One query → many dives. A fresh id per save is what makes the second
    // facet a second dive rather than an overwrite of the first.
    it('mints a new id each time unless one is given', () => {
        const a = toDive({ title: 'T', sql: SQL, chart: CHART });
        const b = toDive({ title: 'T', sql: SQL, chart: CHART });
        expect(a.id).not.toBe(b.id);
    });

    it('reuses the id when updating an existing dive', () => {
        const d = toDive({ id: 'kept-abc12', title: 'T', sql: SQL, chart: CHART });
        expect(d.id).toBe('kept-abc12');
    });

    it('keeps the original createdAt and moves updatedAt', () => {
        const d = toDive({
            title: 'T',
            sql: SQL,
            chart: CHART,
            createdAt: '2020-01-01T00:00:00.000Z',
        });
        expect(d.meta?.createdAt).toBe('2020-01-01T00:00:00.000Z');
        expect(d.meta?.updatedAt).not.toBe('2020-01-01T00:00:00.000Z');
    });

    it('omits a description that is only whitespace', () => {
        expect(toDive({ title: 'T', sql: SQL, chart: CHART, description: '  ' })).not.toHaveProperty(
            'description',
        );
    });

    // A sibling of `query`, not inside `state` — see the module header.
    it('puts builder state beside the query, where DiveState is not', () => {
        const builder = { schemaVersion: 1, columns: [], joins: [] } as never;
        const d = toDive({ title: 'T', sql: SQL, chart: CHART, builder });
        expect(d.builder).toBe(builder);
        expect(d.state).toBeUndefined();
    });

    it('stays a valid dive even with the builder field on it', () => {
        const builder = { schemaVersion: 1, columns: [], joins: [] } as never;
        const d = toDive({ title: 'T', sql: SQL, chart: CHART, builder });
        expect(parseDive(d).ok).toBe(true);
    });

    it('never writes an empty title', () => {
        expect(toDive({ title: '   ', sql: SQL, chart: CHART }).title).toBe('Untitled dive');
    });
});

// The point of this: switching between two facets of one dataset must not
// re-run a query whose answer is already on screen.
describe('sameDataset', () => {
    it('ignores the name/description header, which every save rewrites', () => {
        const a = withQueryHeader(SQL, 'Items per vendor', 'as bars');
        const b = withQueryHeader(SQL, 'Items per vendor', 'as a pie');
        expect(sameDataset(a, b)).toBe(true);
    });

    it('ignores whitespace and comments nobody meant as a difference', () => {
        expect(sameDataset(SQL, `\n  ${SQL}   -- trailing note\n`)).toBe(true);
    });

    it('is case-insensitive about the SQL itself', () => {
        expect(sameDataset('select 1 from t', 'SELECT 1 FROM T')).toBe(true);
    });

    it('still tells two different queries apart', () => {
        expect(sameDataset(SQL, `${SQL} WHERE Active`)).toBe(false);
    });

    it('reduces a header-only difference to the same key', () => {
        expect(datasetKey(withQueryHeader(SQL, 'A'))).toBe(datasetKey(withQueryHeader(SQL, 'B')));
    });
});

describe('asDive', () => {
    const good = toDive({ title: 'T', sql: SQL, chart: CHART });

    it('accepts a dive it wrote', () => {
        expect(asDive(good)?.id).toBe(good.id);
    });

    // `DiveModal` writes `chart: {}` for a dive with no chart, and that is a
    // real record: it opens on the gallery, like a query never charted.
    it('accepts a dive with no chart yet', () => {
        expect(asDive({ ...good, chart: {} })).not.toBeNull();
        expect(hasChart({ ...good, chart: {} })).toBe(false);
        expect(hasChart(good)).toBe(true);
    });

    it.each([
        ['not an object', 'nope'],
        ['null', null],
        ['no id', { ...good, id: '' }],
        ['no title', { ...good, title: '' }],
        ['no sql', { ...good, query: { sql: '  ' } }],
        ['no query', { ...good, query: undefined }],
        ['a chart that is not an object', { ...good, chart: 'bar' }],
    ])('refuses %s', (_label, raw) => {
        expect(asDive(raw)).toBeNull();
    });

    // Half-reading a future record is worse than not showing it.
    it('refuses a version from the future', () => {
        expect(asDive({ ...good, diveSchemaVersion: DIVE_SCHEMA_VERSION + 1 })).toBeNull();
    });
});

// The bug that only showed up on a DASHBOARD: Blocks queries through a
// `src.duckdb` node whose prelude emits `ATTACH … AS duckle_src`, so its SQL
// names `duckle_src."Vendor"`. Saved without the database, the dive ran in
// Blocks and nowhere else — `schema "duckle_src" does not exist`.
describe('the attach source', () => {
    const ATTACHED = 'C:/ws/data/infor.duckdb';

    it('records the database the SQL needs', () => {
        const d = toDive({
            title: 'T',
            sql: 'SELECT * FROM duckle_src."Vendor"',
            chart: CHART,
            source: { kind: 'duckdb', database: ATTACHED, table: 'Vendor' },
        });
        expect(d.source).toEqual({ kind: 'duckdb', database: ATTACHED, table: 'Vendor' });
    });

    // An attach-based dive joins across several tables, so the database is the
    // load-bearing part and the table is a note.
    it('accepts a source with no single table', () => {
        const d = toDive({
            title: 'T',
            sql: 'SELECT * FROM duckle_src."Vendor" JOIN duckle_src."Item" ON 1=1',
            chart: CHART,
            source: { kind: 'duckdb', database: ATTACHED },
        });
        expect(d.source).toEqual({ kind: 'duckdb', database: ATTACHED });
        expect(parseDive(d).ok).toBe(true);
    });

    it('stays a valid dive with the source on it', () => {
        const d = toDive({
            title: 'T',
            sql: SQL,
            chart: CHART,
            source: { kind: 'duckdb', database: ATTACHED },
        });
        expect(parseDive(d).ok).toBe(true);
        expect(asDive(d)?.source).toBeDefined();
    });

    // Self-contained SQL (read_parquet, an already-attached table) needs none,
    // so absence stays meaningful rather than becoming an error.
    it('omits it when there is nothing to attach', () => {
        expect(toDive({ title: 'T', sql: SQL, chart: CHART })).not.toHaveProperty('source');
    });
});
