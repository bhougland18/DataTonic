// Durable-source discovery for the Analysis Blocks studio.
//
// The studio never browses the pipeline graph — it reads the WORKSPACE CATALOG
// (`workspace_catalog`), which is the record of what pipelines actually wrote.
// That keeps the two-layer contract honest (plan §2): the reporting layer can
// only ever point at something durable, because that is the only thing the
// catalog lists.

import type { CatalogAsset } from '../tauri-bridge';
import type { BlockSource, BlockSourceFormat } from './types';

// Kinds that name a readable, persistent store. `api`, `topic` and `service`
// are live endpoints, not durable data, so they are not reporting sources.
const DURABLE_KINDS = new Set(['file', 'object', 'table', 'database']);

/** Infer how to read an address. Extension-driven, because that is what the
 *  catalog gives us — a path or an addr(), not a declared format. */
export function inferFormat(id: string, kind: string): BlockSourceFormat {
    const addr = id.toLowerCase();
    // Strip any query string / fragment an object address may carry.
    const clean = addr.split(/[?#]/)[0];
    if (clean.endsWith('.parquet') || clean.endsWith('.pq')) return 'parquet';
    if (clean.endsWith('.csv') || clean.endsWith('.tsv') || clean.endsWith('.txt')) return 'csv';
    if (clean.endsWith('.json') || clean.endsWith('.ndjson') || clean.endsWith('.jsonl')) return 'json';
    if (clean.endsWith('.duckdb') || clean.endsWith('.db') || clean.endsWith('.ddb')) return 'attach';
    // A catalogued table inside a database is reachable, but only once its
    // database is attached — same handling as a .duckdb file.
    if (kind === 'table' || kind === 'database') return 'attach';
    return 'unknown';
}

/** Basename for display; falls back to the whole id for addr()-style ids. */
function displayName(id: string): string {
    const parts = id.split(/[\/\\]/);
    return parts[parts.length - 1] || id;
}

/** Project the catalog into the durable sources the Studio may read. */
export function durableSources(assets: CatalogAsset[]): BlockSource[] {
    return assets
        .filter(a => DURABLE_KINDS.has(a.kind))
        .map(a => ({
            id: a.id,
            name: displayName(a.id),
            kind: a.kind,
            format: inferFormat(a.id, a.kind),
            columns: a.columns ?? [],
            writtenBy: a.writtenBy ?? [],
            lastWrittenAt: a.freshness?.lastWrittenAt,
            rows: a.freshness?.rows,
        }))
        .sort((x, y) => x.name.localeCompare(y.name));
}

/** Single-quote escape for a SQL string literal. The address is workspace
 *  metadata rather than user text, but it still goes into SQL, so it is
 *  escaped at the one place that composes the clause. */
function lit(s: string): string {
    return `'${s.replace(/'/g, "''")}'`;
}

/**
 * The FROM expression that reads a source, or null when we cannot compose one.
 *
 * Null is a real answer, not a failure to handle later: `attach` sources need
 * an ATTACH statement the Studio does not write yet (DAA.79), and returning
 * null lets the picker say so instead of emitting SQL that dies at Run.
 */
export function fromExpression(source: BlockSource): string | null {
    switch (source.format) {
        case 'parquet':
            return `read_parquet(${lit(source.id)})`;
        case 'csv':
            return `read_csv_auto(${lit(source.id)})`;
        case 'json':
            return `read_json_auto(${lit(source.id)})`;
        case 'attach':
        case 'unknown':
        default:
            return null;
    }
}

/** The starter query for a newly picked source — the shape dives require, a
 *  single self-contained SELECT that reads its source inline. */
export function starterSql(source: BlockSource): string {
    const from = fromExpression(source);
    if (!from) {
        return `-- ${source.name} is a ${source.format === 'attach' ? 'database/table' : 'source'} the Studio\n-- cannot read inline yet (ATTACH is not wired — see DAA.79).\n-- Pick a parquet/csv/json source, or write the read yourself below.\nSELECT 1;`;
    }
    return `SELECT *\nFROM ${from}\nLIMIT 100;`;
}
