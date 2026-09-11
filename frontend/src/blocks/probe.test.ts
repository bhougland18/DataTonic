import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { SqlRunResult } from '../sqleditor/types';
import { inferFormat } from './sources';
import type { BlockSource } from './types';

const run = vi.hoisted(() => vi.fn());
vi.mock('./run', () => ({ runBlockSql: run }));

const { probeAll, probeDatabase } = await import('./probe');

const DB = 'C:/w/infor.duckdb';

function source(id: string, kind = 'table'): BlockSource {
    return {
        id,
        name: id,
        kind,
        format: inferFormat(id, kind),
        columns: [],
        writtenBy: [],
    };
}

function ok(rows: Record<string, unknown>[]): SqlRunResult {
    return { columns: [], rows };
}

beforeEach(() => run.mockReset());

describe('probeDatabase', () => {
    const sources = [source(`duckdb://${DB}.Item`), source(`duckdb://${DB}.Vendor`)];

    it('regroups flat (table, column, type) rows per table', async () => {
        run.mockResolvedValue(
            ok([
                { table_name: 'Item', column_name: 'Item', data_type: 'VARCHAR' },
                { table_name: 'Item', column_name: 'Description', data_type: 'VARCHAR' },
                { table_name: 'Vendor', column_name: 'Vendor', data_type: 'VARCHAR' },
            ]),
        );
        const out = await probeDatabase(sources, DB);
        expect(out[0].columns.map(c => c.name)).toEqual(['Item', 'Description']);
        expect(out[0].columns[0].type).toBe('VARCHAR');
        expect(out[1].columns.map(c => c.name)).toEqual(['Vendor']);
    });

    // The bug this replaced: `src.duckdb` wraps its sql prop as `({sql})`, so a
    // statement terminator inside made every database probe a syntax error.
    it('sends no trailing semicolon and attaches the database', async () => {
        run.mockResolvedValue(ok([]));
        await probeDatabase(sources, DB);
        const [sql, , , database] = run.mock.calls[0];
        expect(sql.trim().endsWith(';')).toBe(false);
        expect(sql).not.toMatch(/DESCRIBE/i);
        expect(database).toBe(DB);
    });

    it('reads every table in one query, not one per table', async () => {
        run.mockResolvedValue(ok([]));
        await probeDatabase(sources, DB);
        expect(run).toHaveBeenCalledTimes(1);
    });

    // A table the catalog lists but the database does not hold is a real
    // disagreement, not a table that happens to have no columns.
    it('reports a missing table rather than showing it as empty', async () => {
        run.mockResolvedValue(ok([{ table_name: 'Item', column_name: 'Item', data_type: 'VARCHAR' }]));
        const out = await probeDatabase(sources, DB);
        expect(out[1].columns).toEqual([]);
        expect(out[1].error).toMatch(/not in the attached database/);
    });

    it('attributes a query failure to every table in the database', async () => {
        run.mockResolvedValue({ columns: [], rows: [], error: 'boom' });
        const out = await probeDatabase(sources, DB);
        expect(out.map(r => r.error)).toEqual(['boom', 'boom']);
    });
});

describe('probeSource', () => {
    // The engine wraps a code.sql body in `CREATE OR REPLACE VIEW ... AS <body>`
    // and DESCRIBE is a statement, so a bare DESCRIBE cannot be a view body.
    // This is why a parquet source showed "schema unknown" while every attached
    // table read fine.
    it('wraps DESCRIBE in a SELECT so it can be a view body', async () => {
        run.mockResolvedValue(ok([]));
        const { probeSource } = await import('./probe');
        await probeSource(source('C:/w/out.parquet', 'file'));
        const [sql] = run.mock.calls[0];
        expect(sql).toMatch(/^SELECT \* FROM \(DESCRIBE /);
        expect(sql.trim().endsWith(';')).toBe(false);
        expect(sql).toContain("read_parquet('C:/w/out.parquet')");
    });

    it('reads columns off the DESCRIBE result', async () => {
        run.mockResolvedValue(
            ok([
                { column_name: 'Item', column_type: 'VARCHAR' },
                { column_name: 'Qty', column_type: 'BIGINT' },
            ]),
        );
        const { probeSource } = await import('./probe');
        const out = await probeSource(source('C:/w/out.parquet', 'file'));
        expect(out.columns).toEqual([
            { name: 'Item', type: 'VARCHAR' },
            { name: 'Qty', type: 'BIGINT' },
        ]);
    });
});

describe('probeAll', () => {
    it('counts queries, not datasets, so four tables in one file is one step', async () => {
        run.mockResolvedValue(ok([]));
        const seen: string[] = [];
        await probeAll(
            [
                source(`duckdb://${DB}.Item`),
                source(`duckdb://${DB}.Vendor`),
                source('C:/w/out.parquet', 'file'),
            ],
            null,
            (done, total) => seen.push(`${done}/${total}`),
        );
        expect(seen).toEqual(['1/2', '2/2']);
    });

    it('returns a result for every source, database-backed or inline', async () => {
        run.mockResolvedValue(ok([]));
        const out = await probeAll(
            [source(`duckdb://${DB}.Item`), source('C:/w/out.parquet', 'file')],
            null,
        );
        expect(out.map(r => r.sourceId).sort()).toEqual([
            'C:/w/out.parquet',
            `duckdb://${DB}.Item`,
        ]);
    });
});
