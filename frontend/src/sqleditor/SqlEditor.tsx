import { useEffect, useRef, useState } from 'react';
import { Database, Lock, ArrowUpToLine } from 'lucide-react';
import './sqleditor.css';
import type { SqlEditorRequest, SqlEditorResult } from './types';

interface SqlEditorProps {
    workspacePath?: string | null;
    // The node-driven open request. `nonce` re-fires the load effect so
    // reopening the same node reloads its SQL (mirrors the Playground).
    openRequest: SqlEditorRequest | null;
    // Write the authored SQL back to the launching node.
    onApplyToNode?: (nodeId: string, result: SqlEditorResult) => void;
}

// SQL Studio surface (Phase 1 shell). Behaves like the Inline SQL node at run
// time — it only authors the node's `sql` prop — so for now it round-trips the
// SQL through an editable pane and writes it back via `onApplyToNode`. The rich
// read-only DuckDB studio (CodeMirror, working-DB catalog, live preview, visual
// builder, ER diagram, AI text-to-SQL) lands in later phases; see
// docs/plans/sql-editor-node.md.
export default function SqlEditor({ openRequest, onApplyToNode }: SqlEditorProps) {
    const [sql, setSql] = useState('');
    const [nodeId, setNodeId] = useState<string | null>(null);
    const [nodeName, setNodeName] = useState<string | undefined>(undefined);
    const lastNonce = useRef<number>(-1);

    // Load the request's SQL whenever a (re)open fires. Keyed on nonce so the
    // same node reopening still reloads.
    useEffect(() => {
        if (!openRequest) return;
        if (openRequest.nonce === lastNonce.current) return;
        lastNonce.current = openRequest.nonce;
        setSql(openRequest.sql ?? '');
        setNodeId(openRequest.nodeId);
        setNodeName(openRequest.nodeName);
    }, [openRequest]);

    const canApply = nodeId != null && onApplyToNode != null;
    const apply = () => {
        if (nodeId != null && onApplyToNode) {
            onApplyToNode(nodeId, { sql });
        }
    };

    return (
        <div className="sqlstudio">
            <div className="sqlstudio-top">
                <div className="sqlstudio-ctx">
                    <span className="sqlstudio-glyph">
                        <Database size={15} strokeWidth={1.8} />
                    </span>
                    <span className="sqlstudio-titles">
                        <b>SQL Studio</b>
                        <small>{nodeName ? `node · ${nodeName}` : 'node'}</small>
                    </span>
                </div>
                <span className="sqlstudio-ro">
                    <Lock size={12} strokeWidth={2} /> Read-only
                </span>
                <span className="sqlstudio-spacer" />
                <button
                    type="button"
                    className="sqlstudio-btn sqlstudio-btn--primary"
                    onClick={apply}
                    disabled={!canApply}
                    title="Write this SQL back to the node"
                >
                    <ArrowUpToLine size={14} strokeWidth={2} /> Apply to node
                </button>
            </div>

            {nodeId == null ? (
                <div className="sqlstudio-empty">
                    Open a SQL Studio node from the canvas to author its query here.
                </div>
            ) : (
                <div className="sqlstudio-body">
                    <p className="sqlstudio-note">
                        Authoring the node&rsquo;s SQL. This runs exactly like an Inline SQL node —
                        the upstream rows are available as <code>input</code>. The full read-only
                        DuckDB studio (schema browser, live preview, visual builder, AI text-to-SQL)
                        is coming; for now, edit below and apply.
                    </p>
                    <textarea
                        className="sqlstudio-editor"
                        value={sql}
                        spellCheck={false}
                        placeholder="SELECT *, upper(status) AS status FROM input"
                        onChange={e => setSql(e.target.value)}
                    />
                </div>
            )}
        </div>
    );
}
