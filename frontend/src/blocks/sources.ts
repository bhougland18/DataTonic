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
    const out = assets
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

    // A catalogued table's display name is the TABLE, not the whole address.
    // `displayName` can only split on path separators, so it leaves the
    // database attached — `infor.duckdb.Item` rather than `Item` — which reads
    // badly as an ER diagram entity and is not what the SQL calls it either.
    //
    // Qualified with the database only when two databases hold a table of the
    // same name, because an ER model keys on the entity name and two boxes
    // called `Item` would be one box as far as a relationship is concerned.
    const tableNames = new Map<string, number>();
    const targets = new Map<string, AttachTarget>();
    for (const s of out) {
        const t = attachTargetOf(s);
        if (!t?.table) continue;
        targets.set(s.id, t);
        tableNames.set(t.table, (tableNames.get(t.table) ?? 0) + 1);
    }
    for (const s of out) {
        const t = targets.get(s.id);
        if (!t?.table) continue;
        const db = t.dbPath.split(/[/\\]/).pop() ?? t.dbPath;
        s.name = (tableNames.get(t.table) ?? 0) > 1 ? `${db}.${t.table}` : t.table;
    }
    return out;
}

/** Single-quote escape for a SQL string literal. The address is workspace
 *  metadata rather than user text, but it still goes into SQL, so it is
 *  escaped at the one place that composes the clause. */
function lit(s: string): string {
    return `'${s.replace(/'/g, "''")}'`;
}

/**
 * The FROM expression that reads a source INLINE, or null when there is none.
 *
 * Null is a real answer rather than a failure to handle later. `attach` sources
 * have no inline read at all — they are reachable only through an ATTACH
 * statement that has to run before the query, which is a different shape than a
 * FROM fragment. See `databaseGroups`; callers that know which database the run
 * attaches should use `readExpression`, which folds both cases together.
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

/** A database file, and optionally the one table inside it an asset names. */
export interface AttachTarget {
    /** Path to the database file, as DuckDB should ATTACH it. */
    dbPath: string;
    /** Schema inside the database, when the asset id carried one. */
    schema?: string;
    /** Table inside the database. Absent when the asset IS the whole database. */
    table?: string;
}

// A database file extension, used as the anchor when splitting an asset id.
const DB_EXT = /^(.*\.(?:duckdb|ddb|db))(?:\.(.+))?$/i;

/**
 * Recover (database, table) from a catalog asset id.
 *
 * `catalog.rs` composes a relational asset as `addr(authority, qualified)` where
 * qualified is `database.schema.table` joined with dots — so a `snk.duckdb`
 * writing `ItemLocation` to `data/infor.duckdb` is catalogued as
 * `duckdb://…/data/infor.duckdb.ItemLocation`. The parts are not carried
 * separately, so the only way back is to split the string.
 *
 * We anchor on the database EXTENSION rather than counting dots, because both
 * the path and the table name may contain them. The match is greedy, so a path
 * that itself contains `.duckdb` splits at the last one — the database file.
 *
 * Returns null for anything that is not a DuckDB target. That is deliberate:
 * `snk.sqlite` catalogues the same shape under a `sqlite://` scheme and needs a
 * different ATTACH, so guessing here would emit SQL that fails at Run.
 */
export function attachTargetOf(source: BlockSource): AttachTarget | null {
    if (source.format !== 'attach') return null;
    // Strip a scheme the catalog prefixed (`duckdb://`), keeping the raw path.
    // Only the duckdb family is claimed here; see the note above.
    const scheme = source.id.match(/^([a-z0-9]+):\/\/(.*)$/i);
    if (scheme && scheme[1].toLowerCase() !== 'duckdb') return null;
    const rest = scheme ? scheme[2] : source.id;

    const m = rest.match(DB_EXT);
    if (!m) return null;
    const dbPath = m[1];
    const tail = m[2];
    if (!tail) return { dbPath };
    // The tail is `table` or `schema.table`; the LAST segment is the table.
    const dot = tail.lastIndexOf('.');
    return dot < 0
        ? { dbPath, table: tail }
        : { dbPath, schema: tail.slice(0, dot), table: tail.slice(dot + 1) };
}

/** Quote a SQL identifier, doubling any embedded quote. */
function ident(s: string): string {
    return `"${s.replace(/"/g, '""')}"`;
}

/**
 * The alias an attached database is reachable under.
 *
 * This is NOT ours to choose. The engine's `src.duckdb` stage emits its own
 * prelude — `ATTACH '<database>' AS duckle_src (READ_ONLY)` — and
 * `build_duckdb_source` reads back through that fixed name. We mirror the
 * constant so the SQL we compose and the SQL the engine composes agree.
 *
 * Its immediate consequence is the one-database limit below: the alias is a
 * constant, so two databases cannot be attached to one query.
 */
export const ATTACH_ALIAS = 'duckle_src';

/**
 * The durable datasets that live inside one database file.
 *
 * Blocks reads a database through a `src.duckdb` node rather than by writing
 * ATTACH itself, because the engine wraps a node's SQL in `CREATE OR REPLACE
 * VIEW … AS (…)` and DDL cannot appear in a view body. The `pureSql` escape
 * hatch does drop that wrapper, but it also sets `no_output_relation`, so the
 * executor skips the node's preview — and a query that returns no grid is no
 * use to a studio whose whole job is showing you the rows.
 */
export interface DatabaseGroup {
    /** Path to the database file, as the `src.duckdb` `database` prop wants it. */
    dbPath: string;
    /** Base name, for the picker. */
    name: string;
    /** The catalogued tables inside it. */
    sources: BlockSource[];
    /** Source id -> the qualified name that reads it once attached. */
    fromById: Record<string, string>;
}

/**
 * Group the database-backed sources by the file they live in.
 *
 * Several `snk.duckdb` nodes commonly write several tables into ONE file, so
 * the file — not the table — is the unit that gets attached, and grouping is
 * what lets the studio offer "query this database" rather than "query this
 * table".
 */
export function databaseGroups(sources: BlockSource[]): DatabaseGroup[] {
    const byPath = new Map<string, DatabaseGroup>();
    for (const s of sources) {
        if (s.format !== 'attach') continue;
        const target = attachTargetOf(s);
        if (!target) continue;
        let g = byPath.get(target.dbPath);
        if (!g) {
            g = {
                dbPath: target.dbPath,
                name: target.dbPath.split(/[/\\]/).pop() ?? target.dbPath,
                sources: [],
                fromById: {},
            };
            byPath.set(target.dbPath, g);
        }
        g.sources.push(s);
        // A source naming no table IS the whole database: it is what makes the
        // group exist, but there is no single relation to read from it.
        if (!target.table) continue;
        const parts = [ATTACH_ALIAS, ...(target.schema ? [target.schema] : []), target.table];
        g.fromById[s.id] = parts.map(ident).join('.');
    }
    return [...byPath.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Sources whose format is `attach` but whose id we could not decompose — a
 *  non-DuckDB database (sqlite) or an id shape we do not recognise. Named
 *  rather than dropped, so the studio can say why they are unreadable. */
export function unresolvedAttachSources(sources: BlockSource[]): BlockSource[] {
    return sources.filter(s => s.format === 'attach' && !attachTargetOf(s));
}

/**
 * How to read a source: inline when it has an inline read, otherwise through
 * `group` if that is the database currently attached.
 *
 * Returns null for a table in a DIFFERENT database than the attached one. That
 * is the honest answer given `ATTACH_ALIAS` is a constant — one query reaches
 * one database — and it is better than composing a qualified name that would
 * resolve to nothing at Run.
 */
export function readExpression(source: BlockSource, group?: DatabaseGroup | null): string | null {
    return fromExpression(source) ?? group?.fromById[source.id] ?? null;
}

/** The starter query for a newly picked source. Reads the source inline when it
 *  can; otherwise through `group`, the database the run will attach. */
export function starterSql(source: BlockSource, group?: DatabaseGroup | null): string {
    const from = readExpression(source, group);
    if (!from) {
        return `-- ${source.name} is a ${source.format === 'attach' ? 'database' : 'source'} the Studio\n-- cannot compose a read for. Write the read yourself below.\nSELECT 1;`;
    }
    return `SELECT *\nFROM ${from}\nLIMIT 100;`;
}
