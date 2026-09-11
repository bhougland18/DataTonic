// Reading a durable dataset's columns.
//
// Neither obvious source works here. The workspace catalog records asset NAMES,
// not schemas — `catalog.rs` builds address-derived assets with `columns:
// Vec::new()` — so `CatalogAsset.columns` is empty for most real datasets. And
// `workspace_catalog_inspect` only answers for assets some `src.*` node READS
// ("nothing in this workspace READS {asset}, so there is no node to inspect it
// through"), which is backwards for us: the datasets worth reporting on are
// pipeline OUTPUTS, and nothing usually reads those back.
//
// So we ask DuckDB directly, over the engine path the SQL step already uses.
// Two shapes, because the two kinds of source have different best answers:
//
//   * An ATTACHED DATABASE is read with `duckdb_columns()` — ONE query for
//     every table in the file. Four tables in one database cost one DuckDB
//     spawn rather than four, which at a measured ~115 ms floor per spawn is
//     the difference between instant and visibly slow. It also avoids DESCRIBE
//     entirely: `src.duckdb` passes its `sql` prop through as `({sql})`, and
//     `DESCRIBE` is a statement, not something that survives being wrapped in
//     parentheses inside the engine's `CREATE OR REPLACE VIEW`.
//
//   * An INLINE file (parquet/csv/json) has no catalog to interrogate, so it
//     still uses `DESCRIBE`, which `code.sql` emits unwrapped.
//
// `DESCRIBE` rather than `SELECT * … LIMIT 0` on purpose: the engine runs the
// DuckDB CLI in `-json` mode, where an empty result set is just `[]` and
// carries no column information. DESCRIBE returns the schema as ROWS, which
// survive that round-trip whether or not the dataset has any data in it.

import type { SqlStudioColumn } from '../sqleditor/types';
import { ATTACH_ALIAS, attachTargetOf, databaseGroups, fromExpression } from './sources';
import { runBlockSql } from './run';
import type { BlockSource } from './types';

/** One dataset's probed schema, or why we could not read it. */
export interface ProbeResult {
    sourceId: string;
    columns: SqlStudioColumn[];
    error?: string;
}

/**
 * Read the columns of every table in one attached database, in a single query.
 *
 * No trailing semicolon: `build_duckdb_source` wraps this as `({sql})`, and a
 * statement terminator inside those parentheses is a syntax error — the bug
 * that made every database probe fail silently.
 */
export async function probeDatabase(
    sources: BlockSource[],
    dbPath: string,
    workspacePath?: string | null,
): Promise<ProbeResult[]> {
    const sql =
        'SELECT table_name, column_name, data_type ' +
        `FROM duckdb_columns() WHERE database_name = '${ATTACH_ALIAS}' ` +
        'ORDER BY table_name, column_index';
    const res = await runBlockSql(sql, workspacePath, 'Schema', dbPath);
    if (res.error) {
        return sources.map(s => ({ sourceId: s.id, columns: [], error: res.error }));
    }

    // Rows are (table, column, type) triples; regroup them per table.
    const byTable = new Map<string, SqlStudioColumn[]>();
    for (const r of res.rows) {
        const table = String(r.table_name ?? '');
        const name = String(r.column_name ?? '');
        if (!table || !name) continue;
        const cols = byTable.get(table) ?? [];
        cols.push({ name, type: r.data_type == null ? undefined : String(r.data_type) });
        byTable.set(table, cols);
    }

    return sources.map(s => {
        const table = attachTargetOf(s)?.table;
        const columns = table ? (byTable.get(table) ?? []) : [];
        // An empty result for a table the catalog lists is a real disagreement
        // — the pipeline recorded a write the database does not show — so it is
        // reported rather than rendered as a table that merely has no columns.
        return columns.length > 0
            ? { sourceId: s.id, columns }
            : {
                  sourceId: s.id,
                  columns: [],
                  error: `${s.name} is not in the attached database — rerun the pipeline that writes it.`,
              };
    });
}

/**
 * Read one inline dataset's columns.
 *
 * A source we cannot compose a FROM for is reported as an error rather than an
 * empty schema — "no columns" and "could not look" are different facts, and
 * only one of them means the dataset is empty.
 */
export async function probeSource(
    source: BlockSource,
    workspacePath?: string | null,
): Promise<ProbeResult> {
    const from = fromExpression(source);
    if (!from) {
        return {
            sourceId: source.id,
            columns: [],
            error: `${source.name} is not a dataset the Studio can compose a read for.`,
        };
    }
    // `SELECT * FROM (DESCRIBE ...)`, not a bare `DESCRIBE`. The engine wraps a
    // `code.sql` body in `CREATE OR REPLACE VIEW "<node>" AS <body>`, and
    // DESCRIBE is a STATEMENT — it cannot be a view body. Used as a subquery it
    // is an ordinary relation and wraps fine. No trailing semicolon, for the
    // same reason the database probe has none.
    const res = await runBlockSql(
        `SELECT * FROM (DESCRIBE SELECT * FROM ${from})`,
        workspacePath,
        source.name,
    );
    if (res.error) return { sourceId: source.id, columns: [], error: res.error };
    const columns = res.rows
        .map(r => ({
            name: String(r.column_name ?? ''),
            type: r.column_type == null ? undefined : String(r.column_type),
        }))
        .filter(c => c.name);
    return { sourceId: source.id, columns };
}

/**
 * Probe every source, reporting progress as it goes.
 *
 * Sequential rather than parallel: each probe spawns a DuckDB process, so
 * fanning fifteen out at once buys latency with a thundering herd. One failure
 * never sinks the batch — a dataset that cannot be read is recorded with its
 * reason and the rest continue.
 *
 * Progress counts QUERIES, not datasets, since one query now covers a whole
 * database. "1 of 2" that finishes is a truer report than "0 of 4" that hangs.
 */
export async function probeAll(
    sources: BlockSource[],
    workspacePath: string | null | undefined,
    onProgress?: (done: number, total: number) => void,
): Promise<ProbeResult[]> {
    const groups = databaseGroups(sources);
    const grouped = new Set(groups.flatMap(g => g.sources.map(s => s.id)));
    const inline = sources.filter(s => !grouped.has(s.id));

    const total = groups.length + inline.length;
    const out: ProbeResult[] = [];
    let done = 0;

    for (const g of groups) {
        try {
            out.push(...(await probeDatabase(g.sources, g.dbPath, workspacePath)));
        } catch (e) {
            const error = e instanceof Error ? e.message : String(e);
            out.push(...g.sources.map(s => ({ sourceId: s.id, columns: [], error })));
        }
        onProgress?.((done += 1), total);
    }

    for (const s of inline) {
        try {
            out.push(await probeSource(s, workspacePath));
        } catch (e) {
            out.push({
                sourceId: s.id,
                columns: [],
                error: e instanceof Error ? e.message : String(e),
            });
        }
        onProgress?.((done += 1), total);
    }

    return out;
}
