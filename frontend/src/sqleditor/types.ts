// SQL Studio — domain types (DataTonic).
//
// The SQL Studio is an isolated module (like `playground/`) so the fork stays
// clean against upstream Duckle. It is launched from a `code.sqlstudio` node and
// authors the node's `sql` prop in a full read-only DuckDB studio.
//
// This file is intentionally free of upstream imports.

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
}

// What the studio writes back to the node via `onApplyToNode`. Kept to just the
// SQL for now — the node's runtime contract is identical to code.sql, so only
// the `sql` prop changes. Richer options (rawSql/pureSql) can join later.
export interface SqlEditorResult {
    sql: string;
}
