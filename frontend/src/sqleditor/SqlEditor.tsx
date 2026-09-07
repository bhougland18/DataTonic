import { useCallback, useEffect, useRef, useState } from 'react';
import {
    Database,
    Lock,
    ArrowUpToLine,
    Sparkles,
    Check,
    X,
    ChevronRight,
    ChevronDown,
    Table2,
} from 'lucide-react';
import './sqleditor.css';
import type { SqlEditorRequest, SqlEditorResult, SqlRunResult, SqlStudioTable } from './types';
import type { ErdRelationship } from '../erd/model';
import QueryPane from './QueryPane';
import AiPane from './AiPane';

interface SqlEditorProps {
    workspacePath?: string | null;
    openRequest: SqlEditorRequest | null;
    onApplyToNode?: (nodeId: string, result: SqlEditorResult) => void;
    onRun?: (nodeId: string, sqlText: string) => Promise<SqlRunResult>;
}

// SQL Studio surface. Authors a code.sqlstudio node's SQL: working-DB catalog
// (left), a query pane (editor + results), and a collapsible AI pane. When the
// AI drafts, a second pane opens side-by-side — run/edit it, then "Use this"
// copies it into the main editor and collapses the split. Only the main query
// is ever applied to the node.
export default function SqlEditor({
    workspacePath,
    openRequest,
    onApplyToNode,
    onRun,
}: SqlEditorProps) {
    const [nodeId, setNodeId] = useState<string | null>(null);
    const [nodeName, setNodeName] = useState<string | undefined>(undefined);
    const [tables, setTables] = useState<SqlStudioTable[]>([]);
    const [relationships, setRelationships] = useState<ErdRelationship[]>([]);
    const [showAi, setShowAi] = useState(false);
    const [mainSql, setMainSql] = useState('');
    // The AI's editable draft; non-null opens the split.
    const [aiDraft, setAiDraft] = useState<string | null>(null);
    const lastNonce = useRef<number>(-1);

    useEffect(() => {
        if (!openRequest) return;
        if (openRequest.nonce === lastNonce.current) return;
        lastNonce.current = openRequest.nonce;
        setNodeId(openRequest.nodeId);
        setNodeName(openRequest.nodeName);
        setTables(openRequest.tables ?? []);
        setRelationships(openRequest.relationships ?? []);
        setMainSql(openRequest.sql ?? '');
        setAiDraft(null);
    }, [openRequest]);

    const runQuery = useCallback(
        (sqlText: string): Promise<SqlRunResult> => {
            if (nodeId == null || !onRun) {
                return Promise.resolve({
                    columns: [],
                    rows: [],
                    error: 'Run is unavailable in this edition.',
                });
            }
            return onRun(nodeId, sqlText);
        },
        [nodeId, onRun],
    );

    const apply = useCallback(() => {
        if (nodeId != null && onApplyToNode) onApplyToNode(nodeId, { sql: mainSql });
    }, [nodeId, onApplyToNode, mainSql]);

    const acceptAiDraft = useCallback(() => {
        if (aiDraft != null) setMainSql(aiDraft);
        setAiDraft(null);
    }, [aiDraft]);

    if (nodeId == null) {
        return (
            <div className="sqlstudio">
                <div className="sqlstudio-empty">
                    Open a SQL Studio node from the canvas to author its query here.
                </div>
            </div>
        );
    }

    const split = aiDraft != null;

    return (
        <div className="sqlstudio">
            {/* Catalog sidebar */}
            <aside className="sqlstudio-side">
                <div className="sqlstudio-side-head">
                    <Database size={15} strokeWidth={1.8} />
                    <span>Working DB</span>
                </div>
                <div className="sqlstudio-catalog">
                    {tables.length === 0 ? (
                        <div className="sqlstudio-catalog-empty">
                            No upstream tables detected. Wire a source (or a Working DB) into this
                            node.
                        </div>
                    ) : (
                        tables.map(t => <CatalogTable key={t.name} table={t} />)
                    )}
                </div>
            </aside>

            {/* Main */}
            <div className="sqlstudio-main">
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
                        className={`sqlstudio-btn${showAi ? ' sqlstudio-btn--on' : ''}`}
                        onClick={() => setShowAi(v => !v)}
                        title="Ask AI to write SQL (text-to-SQL)"
                    >
                        <Sparkles size={14} strokeWidth={2} /> Ask AI
                    </button>
                    <button
                        type="button"
                        className="sqlstudio-btn sqlstudio-btn--primary"
                        onClick={apply}
                        disabled={onApplyToNode == null}
                        title="Write the main query back to the node"
                    >
                        <ArrowUpToLine size={14} strokeWidth={2} /> Apply to node
                    </button>
                </div>

                <div className="sqlstudio-panes">
                    <QueryPane
                        label="Query"
                        sql={mainSql}
                        onChange={setMainSql}
                        run={runQuery}
                        tables={tables}
                        className={split ? 'sqlstudio-pane--split' : undefined}
                    />
                    {split && (
                        <QueryPane
                            label={
                                <span className="sqlstudio-pane-ai">
                                    <Sparkles size={13} /> AI draft
                                </span>
                            }
                            sql={aiDraft ?? ''}
                            onChange={v => setAiDraft(v)}
                            run={runQuery}
                            tables={tables}
                            className="sqlstudio-pane--split"
                            actions={
                                <>
                                    <button
                                        type="button"
                                        className="sqlstudio-btn sqlstudio-btn--primary"
                                        onClick={acceptAiDraft}
                                        title="Copy this into the main query and close the split"
                                    >
                                        <Check size={14} strokeWidth={2} /> Use this
                                    </button>
                                    <button
                                        type="button"
                                        className="sqlstudio-btn"
                                        onClick={() => setAiDraft(null)}
                                        title="Discard the AI draft"
                                    >
                                        <X size={14} strokeWidth={2} /> Dismiss
                                    </button>
                                </>
                            }
                        />
                    )}
                </div>
            </div>

            {/* Always mounted so collapsing the pane keeps its conversation. */}
            <AiPane
                visible={showAi}
                onCollapse={() => setShowAi(false)}
                tables={tables}
                relationships={relationships}
                currentSql={mainSql}
                workspacePath={workspacePath}
                onInsert={setAiDraft}
            />
        </div>
    );
}

function CatalogTable({ table }: { table: SqlStudioTable }) {
    const [open, setOpen] = useState(table.kind === 'input');
    return (
        <div className="sqlstudio-tnode-wrap">
            <button className="sqlstudio-tnode" onClick={() => setOpen(o => !o)}>
                {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                <Table2 size={13} className="sqlstudio-tbl-icon" />
                <span className="nm">{table.name}</span>
                {table.kind === 'input' && <span className="tag">input</span>}
                <span className="ct">{table.columns.length}</span>
            </button>
            {open && (
                <div className="sqlstudio-cols">
                    {table.columns.map(c => (
                        <div className="sqlstudio-col" key={c.name}>
                            <span className="cn">{c.name}</span>
                            {c.primaryKey && <span className="pk">PK</span>}
                            {c.type && <span className="ty">{c.type}</span>}
                        </div>
                    ))}
                    {table.columns.length === 0 && (
                        <div className="sqlstudio-col sqlstudio-col--empty">schema unknown</div>
                    )}
                </div>
            )}
        </div>
    );
}
