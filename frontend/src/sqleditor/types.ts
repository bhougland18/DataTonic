// SQL Studio — domain types (DataTonic).
//
// The SQL Studio is an isolated module (like `playground/`) so the fork stays
// clean against upstream Duckle. It is launched from a `code.sqlstudio` node and
// authors the node's `sql` prop in a full read-only DuckDB studio.
//
// This file is intentionally free of upstream imports.

import type { ErdRelationship } from '../erd/model';

export interface SqlStudioColumn {
    name: string;
    type?: string;
    nullable?: boolean;
    primaryKey?: boolean;
}

// A table the studio's SQL can reference — derived from the node's upstream
// subgraph (each upstream relation the run DB will hold). `input` is the
// immediate main upstream, always available inside a code.sqlstudio node.
export interface SqlStudioTable {
    name: string;
    kind: 'input' | 'upstream';
    columns: SqlStudioColumn[];
    // What to write after FROM, when that differs from `name`. Inside a node it
    // never does — the working DB holds each upstream under its own name — but
    // Blocks queries durable sinks, where the address is `"duckle_src"."Item"`
    // or a parquet path. Optional so the node path is unaffected.
    from?: string;
}

// The request bag App.tsx hands the studio when a node opens it. `nonce` forces
// the open effect to re-run even when the same node is reopened (mirrors the
// Playground's `playgroundRequest.nonce`).
export interface SqlEditorRequest {
    nonce: number;
    nodeId: string;
    // The node's current SQL text (its `sql` prop), pre-loaded for editing.
    sql: string;
    // The node's SQL name / alias, shown for context (optional).
    nodeName?: string;
    // The working-DB catalog the SQL can query — the node's upstream tables.
    tables?: SqlStudioTable[];
    // Inherited ERD relationships (SE-11) — present only when the direct upstream
    // is a Working DB. Read-only in the Studio; feeds the ER tab + AI context.
    relationships?: ErdRelationship[];
    // Whether the catalog/ERD came from an upstream Working DB (vs. a single
    // `input` source). Drives the ER-tab messaging.
    fromWorkingDb?: boolean;
    /**
     * The node's saved builder state, if it was authored with the builder.
     *
     * Opaque here on purpose — `BuilderState` lives in `blocks/`, and typing it
     * would make this shared module depend on the builder rather than merely
     * carry it. The editor casts it; nothing else reads it.
     *
     * Absent means the node was written by hand (or predates the builder), and
     * it opens in SQL mode. That is the honest default: a `sql` prop alone does
     * not tell you it came from a builder, and reconstructing one from arbitrary
     * SQL is the text-to-SQL problem the builder exists to avoid.
     */
    builder?: unknown;
}

// What the studio writes back to the node via `onApplyToNode`.
export interface SqlEditorResult {
    sql: string;
    /**
     * Builder state to store alongside the SQL, so reopening returns to the
     * builder rather than to text.
     *
     * `null` clears it — the query was taken over by hand, and keeping a stale
     * builder would mean toggling it on silently replaced the SQL with an older
     * query. `undefined` leaves whatever is there untouched.
     *
     * Free to store: `build_custom_sql` reads `sql`, `rawSql` and `pureSql` by
     * name and ignores everything else, so an extra prop needs no engine change
     * and no migration. A node saved with one still runs on any engine build.
     */
    builder?: unknown | null;
}

// The shape a studio "Run" returns (mirrors the engine's NodePreview minus the
// node id). On failure, `error` carries the message and rows/columns are empty.
export interface SqlRunResult {
    columns: SqlStudioColumn[];
    rows: Record<string, unknown>[];
    error?: string;
    durationMs?: number;
}
