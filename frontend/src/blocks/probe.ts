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
//
// `DESCRIBE` rather than `SELECT * … LIMIT 0` on purpose: the engine runs the
// DuckDB CLI in `-json` mode, where an empty result set is just `[]` and
// carries no column information. DESCRIBE returns the schema as ROWS, which
// survive that round-trip whether or not the dataset has any data in it.

import type { SqlStudioColumn } from '../sqleditor/types';
import { fromExpression } from './sources';
import { runBlockSql } from './run';
import type { BlockSource } from './types';

/** One dataset's probed schema, or why we could not read it. */
export interface ProbeResult {
    sourceId: string;
    columns: SqlStudioColumn[];
    error?: string;
}

/**
 * Read one dataset's columns.
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
            error: `${source.name} cannot be read inline (ATTACH is not wired).`,
        };
    }
    const res = await runBlockSql(`DESCRIBE SELECT * FROM ${from};`, workspacePath, source.name);
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
 * Probe every source, one at a time, reporting progress as it goes.
 *
 * Sequential rather than parallel: each probe spawns a DuckDB process, so
 * fanning fifteen out at once buys latency with a thundering herd. One failure
 * never sinks the batch — a dataset that cannot be read is recorded with its
 * reason and the rest continue.
 */
export async function probeAll(
    sources: BlockSource[],
    workspacePath: string | null | undefined,
    onProgress?: (done: number, total: number) => void,
): Promise<ProbeResult[]> {
    const out: ProbeResult[] = [];
    for (const s of sources) {
        try {
            out.push(await probeSource(s, workspacePath));
        } catch (e) {
            out.push({
                sourceId: s.id,
                columns: [],
                error: e instanceof Error ? e.message : String(e),
            });
        }
        onProgress?.(out.length, sources.length);
    }
    return out;
}
