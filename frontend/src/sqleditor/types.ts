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
}

// What the studio writes back to the node via `onApplyToNode`.
export interface SqlEditorResult {
    sql: string;
}

// The shape a studio "Run" returns (mirrors the engine's NodePreview minus the
// node id). On failure, `error` carries the message and rows/columns are empty.
export interface SqlRunResult {
    columns: SqlStudioColumn[];
    rows: Record<string, unknown>[];
    error?: string;
    durationMs?: number;
}
