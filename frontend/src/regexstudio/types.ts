// Regex Studio — domain types (DataTonic).
//
// The Regex Studio is an isolated module (like `sqleditor/`) so the fork stays
// clean against upstream Duckle. It is launched from one of the four
// `*.regex*.studio` nodes and authors that node's regex props in a full-screen
// RE2 editor. Free of upstream imports.

// Which base node launched the studio; fixed for the session (not switchable).
export type RegexMode = 'replace' | 'extract' | 'match' | 'quality';

export interface RegexStudioColumn {
    name: string;
    type?: string;
}

// The request bag App.tsx hands the studio when a node opens it. `nonce` forces
// the open effect to re-run when the same node is reopened (mirrors the SQL
// Studio's `sqlEditorRequest.nonce`).
export interface RegexStudioRequest {
    nonce: number;
    nodeId: string;
    mode: RegexMode;
    nodeName?: string;
    // The node's chosen column and its current regex props, pre-loaded.
    column: string;
    columns: RegexStudioColumn[]; // available upstream columns (for the picker)
    pattern: string;
    replacement: string; // replace mode
    groupIndex: number; // extract mode
    groupNames: string; // extract mode (comma-separated)
}

// What the studio writes back to the node. Only the keys relevant to the mode
// are set; App merges them into the node's props (runtime contract unchanged).
export interface RegexStudioResult {
    column: string;
    pattern: string;
    replacement?: string;
    groupIndex?: number;
    groupNames?: string;
}

// Column values pulled from the node's upstream for the test/data panel.
export interface RegexColumnFetch {
    values: string[];
    total: number;
    error?: string;
}
