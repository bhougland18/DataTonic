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
    PanelLeftClose,
    PanelLeftOpen,
    AlignLeft,
    HelpCircle,
} from 'lucide-react';
import { format as formatSqlText } from 'sql-formatter';
import './sqleditor.css';
import type { SqlEditorRequest, SqlEditorResult, SqlRunResult, SqlStudioTable } from './types';
import type { ErdRelationship } from '../erd/model';
import QueryPane from './QueryPane';
import AiPane from './AiPane';
import { maybeStartEditorTour, startEditorTour } from '../GuidedTour';

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
    const [showCatalog, setShowCatalog] = useState(true);
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
        // First time this editor is opened, walk the SQL Studio tour once.
        maybeStartEditorTour('sql');
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

    // Pretty-print the main query (DuckDB ≈ PostgreSQL). Leaves it unchanged if
    // it can't be parsed, so a half-written query is never mangled.
    const formatMain = useCallback(() => {
        setMainSql(s => {
            if (!s.trim()) return s;
            try {
                return formatSqlText(s, { language: 'postgresql' });
            } catch {
                return s;
            }
        });
    }, []);

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
            <aside
                className={`sqlstudio-side${showCatalog ? '' : ' sqlstudio-side--hidden'}`}
                data-tour="sqlstudio-catalog"
            >
                <div className="sqlstudio-side-head">
                    <Database size={15} strokeWidth={1.8} />
                    <span>Working DB</span>
                    <span className="sqlstudio-spacer" />
                    <button
                        type="button"
                        className="sqlstudio-icon-btn"
                        onClick={() => setShowCatalog(false)}
                        title="Collapse table catalog"
                        aria-label="Collapse table catalog"
                    >
                        <PanelLeftClose size={15} />
                    </button>
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
                    {!showCatalog && (
                        <button
                            type="button"
                            className="sqlstudio-icon-btn"
                            onClick={() => setShowCatalog(true)}
                            title="Show table catalog"
                            aria-label="Show table catalog"
                        >
                            <PanelLeftOpen size={16} />
                        </button>
                    )}
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
                        className="editor-help-btn"
                        onClick={() => startEditorTour('sql')}
                        title="Show the SQL Studio tour"
                        aria-label="Show the SQL Studio tour"
                    >
                        <HelpCircle size={16} />
                    </button>
                    <button
                        type="button"
                        className="sqlstudio-btn"
                        onClick={formatMain}
                        title="Auto-format the query"
                    >
                        <AlignLeft size={14} strokeWidth={2} /> Format
                    </button>
                    <button
                        type="button"
                        className={`sqlstudio-btn${showAi ? ' sqlstudio-btn--on' : ''}`}
                        onClick={() => setShowAi(v => !v)}
                        title="Ask AI to write SQL (text-to-SQL)"
                        data-tour="sqlstudio-askai"
                    >
                        <Sparkles size={14} strokeWidth={2} /> Ask AI
                    </button>
                    <button
                        type="button"
                        className="sqlstudio-btn sqlstudio-btn--primary"
                        onClick={apply}
                        disabled={onApplyToNode == null}
                        title="Write the main query back to the node"
                        data-tour="sqlstudio-apply"
                    >
                        <ArrowUpToLine size={14} strokeWidth={2} /> Apply to node
                    </button>
                </div>

                <div className="sqlstudio-panes" data-tour="sqlstudio-editor">
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
