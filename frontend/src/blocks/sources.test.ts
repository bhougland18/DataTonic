import { describe, expect, it } from 'vitest';
import type { CatalogAsset } from '../tauri-bridge';
import { durableSources, fromExpression, inferFormat, starterSql } from './sources';
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

    it('explains itself instead of seeding broken SQL for an attach source', () => {
        const sql = starterSql(source({ id: 'wh.duckdb', name: 'wh.duckdb' }));
        expect(sql).toContain('ATTACH is not wired');
        expect(sql).not.toContain('read_parquet');
    });
});
