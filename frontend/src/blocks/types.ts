// Analysis Blocks — domain types (DataTonic).
//
// A *block* is a reusable analysis artifact: a saved query, a chart over one,
// or a model of the durable schema. Blocks are authored here and ASSEMBLED
// elsewhere (`reporting/`) into a dashboard, report or deck.
//
// The separation is the point. Authoring a block must not know which
// deliverable it will end up in, because the same query and chart should feed
// all three without being re-authored — the "one source, three deliverables"
// property. A funnel that asks "dashboard, report or deck?" before you write
// any SQL quietly destroys it.
//
// Three layers, then: Canvas (ETL, produces durable data) → Analysis Blocks
// (this module, produces reusable pieces) → Reporting (assembles pieces into
// outputs). See docs/plans/reporting-studio.md.
//
// NB "block" here is an analysis artifact. The report stitcher's document tree
// calls its units *elements* precisely so the two do not collide.
//
// This file is intentionally free of upstream imports.

/** What kind of reusable piece a block is. */
export type BlockKind = 'query' | 'chart' | 'model';

/** The authoring steps in the Blocks studio. */
export type BlockStep = 'schema' | 'sql' | 'charts';

/**
 * A durable source a block may read.
 *
 * The contract with the transformation layer is that this is ALWAYS a
 * persistent store — a file/table a pipeline wrote — never an ephemeral
 * pipeline temp DB, which the run deletes. This mirrors `DiveSource` in
 * `dives/dive-types.ts`, which already documents and enforces the same rule.
 */
export interface BlockSource {
    /** Catalog asset id — for a file kind this is the normalised path. */
    id: string;
    /** Display name (basename for files). */
    name: string;
    /** Catalog asset kind: file | object | table | database | ... */
    kind: string;
    /** How the SQL step should read it, inferred from the address. */
    format: BlockSourceFormat;
    /** Column names the catalog knows about (names only — types come from a run). */
    columns: string[];
    /** Which pipeline(s) wrote it, for provenance in the picker. */
    writtenBy: string[];
    /** ISO timestamp of the last write, when the catalog tracked it. */
    lastWrittenAt?: string;
    rows?: number;
}

/**
 * How to read a source in SQL. `attach` and `unknown` are carried rather than
 * hidden: a source we cannot compose a FROM clause for should say so in the
 * picker instead of silently producing SQL that fails at Run.
 */
export type BlockSourceFormat = 'parquet' | 'csv' | 'json' | 'attach' | 'unknown';

/**
 * A saved block. Persisted as a repo item alongside connections/docs/dives, so
 * it inherits the sidebar tree, persistence and sharing rather than inventing
 * a parallel store. Not yet wired — see DAA.79.
 */
export interface Block {
    schemaVersion: 1;
    id: string;
    name: string;
    kind: BlockKind;
    /** Catalog asset the block reads. */
    sourceId: string;
    /** The block's query. Chart blocks carry one too — a chart is a spec over a query. */
    sql: string;
    /** vgplot spec for `chart` blocks (DAA.72). */
    spec?: Record<string, unknown>;
}
