import { describe, expect, it } from 'vitest';
import type { CatalogAsset } from '../tauri-bridge';
import {
    attachTargetOf,
    databaseGroups,
    durableSources,
    fromExpression,
    inferFormat,
    readExpression,
    starterSql,
    unresolvedAttachSources,
} from './sources';
import type { BlockSource } from './types';

function asset(over: Partial<CatalogAsset> & { id: string; kind: string }): CatalogAsset {
    return {
        columns: [],
        writtenBy: [],
        readBy: [],
        tags: [],
        ...over,
    } as CatalogAsset;
}

function source(over: Partial<BlockSource> & { id: string }): BlockSource {
    return {
        name: over.id,
        kind: 'file',
        format: inferFormat(over.id, over.kind ?? 'file'),
        columns: [],
        writtenBy: [],
        ...over,
    } as BlockSource;
}

describe('inferFormat', () => {
    it('reads the format off the address extension', () => {
        expect(inferFormat('C:/w/out.parquet', 'file')).toBe('parquet');
        expect(inferFormat('C:/w/out.csv', 'file')).toBe('csv');
        expect(inferFormat('C:/w/out.ndjson', 'file')).toBe('json');
        expect(inferFormat('C:/w/warehouse.duckdb', 'file')).toBe('attach');
    });

    it('is case-insensitive and ignores object query strings', () => {
        expect(inferFormat('s3://bucket/OUT.PARQUET', 'object')).toBe('parquet');
        expect(inferFormat('s3://bucket/out.parquet?versionId=abc', 'object')).toBe('parquet');
    });

    // A catalogued table is real data but is only reachable once its database
    // is attached, so it must land in the same bucket as a .duckdb file rather
    // than looking readable and failing at Run.
    it('treats tables and databases as attach targets', () => {
        expect(inferFormat('warehouse.orders', 'table')).toBe('attach');
        expect(inferFormat('warehouse', 'database')).toBe('attach');
    });

    it('admits when it cannot tell', () => {
        expect(inferFormat('C:/w/out.bin', 'file')).toBe('unknown');
    });
});

describe('durableSources', () => {
    it('keeps only durable kinds — live endpoints are not reporting sources', () => {
        const view = [
            asset({ id: 'C:/w/out.parquet', kind: 'file' }),
            asset({ id: 's3://b/k.csv', kind: 'object' }),
            asset({ id: 'wh.orders', kind: 'table' }),
            asset({ id: 'https://api.example.com/v1', kind: 'api' }),
            asset({ id: 'events', kind: 'topic' }),
            asset({ id: 'svc', kind: 'service' }),
        ];
        // Sorted by display name for the picker, not by catalog order:
        // k.csv < out.parquet < wh.orders.
        expect(durableSources(view).map(s => s.id)).toEqual([
            's3://b/k.csv',
            'C:/w/out.parquet',
            'wh.orders',
        ]);
    });

    it('carries provenance and freshness through for the picker', () => {
        const [s] = durableSources([
            asset({
                id: 'C:/w/out.parquet',
                kind: 'file',
                columns: ['id', 'total'],
                writtenBy: ['nightly'],
                freshness: {
                    lastWrittenAt: '2026-09-10T00:00:00Z',
                    pipelineId: 'nightly',
                    rows: 42,
                },
            }),
        ]);
        expect(s.name).toBe('out.parquet');
        expect(s.columns).toEqual(['id', 'total']);
        expect(s.writtenBy).toEqual(['nightly']);
        expect(s.lastWrittenAt).toBe('2026-09-10T00:00:00Z');
        expect(s.rows).toBe(42);
    });

    it('names windows and posix paths the same way', () => {
        const names = durableSources([
            asset({ id: 'C:/w/sub/out.parquet', kind: 'file' }),
            asset({ id: 'C:\\w\\sub\\win.parquet', kind: 'file' }),
        ]).map(s => s.name);
        expect(names).toContain('out.parquet');
        expect(names).toContain('win.parquet');
    });

    it('tolerates a catalog asset with no columns or provenance', () => {
        const [s] = durableSources([{ id: 'C:/w/out.parquet', kind: 'file' } as CatalogAsset]);
        expect(s.columns).toEqual([]);
        expect(s.writtenBy).toEqual([]);
    });
});

describe('fromExpression', () => {
    it('composes the right reader per format', () => {
        expect(fromExpression(source({ id: 'a.parquet' }))).toBe("read_parquet('a.parquet')");
        expect(fromExpression(source({ id: 'a.csv' }))).toBe("read_csv_auto('a.csv')");
        expect(fromExpression(source({ id: 'a.json' }))).toBe("read_json_auto('a.json')");
    });

    // Null is a real answer, not an oversight: the picker surfaces it instead
    // of emitting SQL that dies at Run.
    it('returns null rather than guessing for attach/unknown', () => {
        expect(fromExpression(source({ id: 'wh.duckdb' }))).toBeNull();
        expect(fromExpression(source({ id: 'a.bin' }))).toBeNull();
    });

    it('escapes quotes in the address', () => {
        expect(fromExpression(source({ id: "o'brien.parquet" }))).toBe(
            "read_parquet('o''brien.parquet')",
        );
    });
});

describe('starterSql', () => {
    it('seeds a self-contained SELECT for a readable source', () => {
        expect(starterSql(source({ id: 'a.parquet' }))).toContain("FROM read_parquet('a.parquet')");
    });

    it('explains itself instead of seeding broken SQL for an unattached database', () => {
        const sql = starterSql(source({ id: 'wh.duckdb', name: 'wh.duckdb' }));
        expect(sql).toContain('cannot compose a read for');
        expect(sql).not.toContain('read_parquet');
    });

    // With the database attached the same source IS readable, through the
    // engine's fixed alias rather than an inline reader.
    it('seeds a qualified SELECT once the database is attached', () => {
        const s = source({ id: 'duckdb://C:/w/wh.duckdb.orders', kind: 'table' });
        const [group] = databaseGroups([s]);
        expect(starterSql(s, group)).toContain('FROM "duckle_src"."orders"');
    });
});

describe('durableSources naming', () => {
    // An ER diagram entity called `infor.duckdb.Item` reads badly and is not
    // what the SQL calls it either.
    it('names a catalogued table after the table', () => {
        const out = durableSources([
            asset({ id: 'duckdb://C:/w/infor.duckdb.Item', kind: 'table' }),
            asset({ id: 'duckdb://C:/w/infor.duckdb.Vendor', kind: 'table' }),
        ]);
        expect(out.map(s => s.name)).toEqual(['Item', 'Vendor']);
    });

    // Two boxes called `Item` would be ONE entity as far as a relationship is
    // concerned, so the name has to carry the database when it collides.
    it('qualifies with the database only when the table name collides', () => {
        const out = durableSources([
            asset({ id: 'duckdb://C:/w/a.duckdb.Item', kind: 'table' }),
            asset({ id: 'duckdb://C:/w/b.duckdb.Item', kind: 'table' }),
            asset({ id: 'duckdb://C:/w/a.duckdb.Vendor', kind: 'table' }),
        ]);
        expect(out.map(s => s.name).sort()).toEqual(['Vendor', 'a.duckdb.Item', 'b.duckdb.Item']);
    });

    it('leaves a plain file name alone', () => {
        expect(durableSources([asset({ id: 'C:/w/out.parquet', kind: 'file' })])[0].name).toBe(
            'out.parquet',
        );
    });
});

describe('attachTargetOf', () => {
    // catalog.rs joins database/schema/table with dots and prefixes the family
    // scheme, so the only way back to the parts is to split on the db extension.
    it('splits a catalogued table id into database and table', () => {
        expect(attachTargetOf(source({ id: 'duckdb://C:/w/data/infor.duckdb.ItemLocation', kind: 'table' }))).toEqual(
            { dbPath: 'C:/w/data/infor.duckdb', table: 'ItemLocation' },
        );
    });

    it('keeps a schema segment when the asset carried one', () => {
        expect(attachTargetOf(source({ id: 'duckdb://wh.duckdb.main.orders', kind: 'table' }))).toEqual(
            { dbPath: 'wh.duckdb', schema: 'main', table: 'orders' },
        );
    });

    it('treats a bare database file as the whole database', () => {
        expect(attachTargetOf(source({ id: 'C:/w/wh.duckdb' }))).toEqual({ dbPath: 'C:/w/wh.duckdb' });
    });

    // Windows paths arrive with backslashes and may contain dots of their own;
    // the split anchors on the LAST database extension, not the first dot.
    it('handles backslash paths and dotted folder names', () => {
        expect(attachTargetOf(source({ id: 'duckdb://C:\\w\\v1.2\\infor.duckdb.Item', kind: 'table' }))).toEqual(
            { dbPath: 'C:\\w\\v1.2\\infor.duckdb', table: 'Item' },
        );
    });

    // A sqlite target has the same shape but needs a different ATTACH, so
    // claiming it here would emit SQL that fails at Run.
    it('declines a non-duckdb scheme', () => {
        expect(attachTargetOf(source({ id: 'sqlite://wh.db.orders', kind: 'table' }))).toBeNull();
    });

    it('declines a source that is not attach-format', () => {
        expect(attachTargetOf(source({ id: 'a.parquet' }))).toBeNull();
    });
});

describe('databaseGroups', () => {
    // Several snk.duckdb nodes commonly write several tables into ONE file, and
    // the file is the unit that gets attached.
    it('groups tables by the database file they live in', () => {
        const groups = databaseGroups([
            source({ id: 'duckdb://C:/w/a.duckdb.orders', kind: 'table' }),
            source({ id: 'duckdb://C:/w/a.duckdb.items', kind: 'table' }),
            source({ id: 'duckdb://C:/w/b.duckdb.sales', kind: 'table' }),
            source({ id: 'plain.parquet' }),
        ]);
        expect(groups.map(g => g.name)).toEqual(['a.duckdb', 'b.duckdb']);
        expect(groups[0].sources).toHaveLength(2);
        expect(groups[0].fromById['duckdb://C:/w/a.duckdb.orders']).toBe('"duckle_src"."orders"');
    });

    it('quotes identifiers so a table named like a keyword still reads', () => {
        const [g] = databaseGroups([source({ id: 'duckdb://a.duckdb.select', kind: 'table' })]);
        expect(g.fromById['duckdb://a.duckdb.select']).toBe('"duckle_src"."select"');
    });
});

describe('readExpression', () => {
    it('prefers the inline read and ignores the attachment', () => {
        expect(readExpression(source({ id: 'a.parquet' }), null)).toBe("read_parquet('a.parquet')");
    });

    // The alias is a constant, so one query reaches one database. A table in
    // the other file is readable — just not by this run.
    it('returns null for a table in a database that is not the attached one', () => {
        const a = source({ id: 'duckdb://C:/w/a.duckdb.orders', kind: 'table' });
        const b = source({ id: 'duckdb://C:/w/b.duckdb.sales', kind: 'table' });
        const [groupA] = databaseGroups([a, b]);
        expect(readExpression(a, groupA)).toBe('"duckle_src"."orders"');
        expect(readExpression(b, groupA)).toBeNull();
    });
});

// Anchored on the asset ids a real workspace produces: four `snk.duckdb` nodes
// across two pipelines, all writing into one Windows-path database file. This
// is the shape the whole attach path was built for, so it is worth pinning to
// actual values rather than only to tidy invented ones.
describe('a real multi-sink DuckDB workspace', () => {
    const DB = 'C:\\Users\\b\\Documents\\Duckle_new_workspace\\data\\infor.duckdb';
    const ids = ['Item', 'VendorItem', 'Vendor', 'ItemLocation'].map(t => `duckdb://${DB}.${t}`);

    it('collapses every table into one attachable database', () => {
        const groups = databaseGroups(ids.map(id => source({ id, kind: 'table' })));
        expect(groups).toHaveLength(1);
        expect(groups[0].dbPath).toBe(DB);
        expect(groups[0].name).toBe('infor.duckdb');
        expect(groups[0].sources).toHaveLength(4);
        expect(Object.values(groups[0].fromById)).toEqual([
            '"duckle_src"."Item"',
            '"duckle_src"."VendorItem"',
            '"duckle_src"."Vendor"',
            '"duckle_src"."ItemLocation"',
        ]);
    });

    // Mixed case survives: DuckDB folds unquoted identifiers, and `ItemLocation`
    // read back as `itemlocation` would not resolve.
    it('preserves table-name case through quoting', () => {
        const s = source({ id: `duckdb://${DB}.ItemLocation`, kind: 'table' });
        const [g] = databaseGroups([s]);
        expect(starterSql(s, g)).toContain('FROM "duckle_src"."ItemLocation"');
    });
});

describe('unresolvedAttachSources', () => {
    it('names only the attach sources we could not decompose', () => {
        const out = unresolvedAttachSources([
            source({ id: 'duckdb://a.duckdb.orders', kind: 'table' }),
            source({ id: 'sqlite://wh.db.orders', kind: 'table' }),
            source({ id: 'a.parquet' }),
        ]);
        expect(out.map(s => s.id)).toEqual(['sqlite://wh.db.orders']);
    });
});
