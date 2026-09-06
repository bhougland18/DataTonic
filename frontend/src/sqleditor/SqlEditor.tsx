import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    Database,
    Lock,
    ArrowUpToLine,
    Play,
    Loader2,
    ChevronRight,
    ChevronDown,
    Table2,
    Sparkles,
    Plus,
    X,
    AlertTriangle,
} from 'lucide-react';
import CodeMirror from '@uiw/react-codemirror';
import { sql, type SQLNamespace } from '@codemirror/lang-sql';
import { keymap, EditorView } from '@codemirror/view';
import { Prec } from '@codemirror/state';
import { acceptCompletion } from '@codemirror/autocomplete';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import './sqleditor.css';
import type { SqlEditorRequest, SqlEditorResult, SqlRunResult, SqlStudioTable } from './types';
import type { ErdRelationship } from '../erd/model';
import AiPane from './AiPane';

// Theme the editor with the app's own tokens so it tracks Duckle's light/dark
// mode automatically (var(--bg-1) etc. resolve per theme), instead of a fixed
// dark theme that clashes in light mode.
const duckleEditorTheme = EditorView.theme({
    // Match the data-grid cell background (--bg-0) so the editor and results
    // read as one surface.
    '&': { backgroundColor: 'var(--bg-0)', color: 'var(--text-1)' },
    '.cm-content': {
        caretColor: 'var(--accent)',
        fontFamily: 'var(--mono, ui-monospace, "Cascadia Code", Menlo, monospace)',
    },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
        backgroundColor: 'var(--accent-soft)',
    },
    '.cm-gutters': { backgroundColor: 'var(--bg-0)', color: 'var(--text-4)', border: 'none' },
    '.cm-activeLine': { backgroundColor: 'var(--bg-1)' },
    '.cm-activeLineGutter': { backgroundColor: 'var(--bg-1)', color: 'var(--text-2)' },
    '.cm-tooltip': {
        backgroundColor: 'var(--bg-3)',
        border: '1px solid var(--border)',
        color: 'var(--text-1)',
    },
    '.cm-tooltip-autocomplete ul li[aria-selected]': {
        backgroundColor: 'var(--accent-soft)',
        color: 'var(--accent)',
    },
});

const duckleHighlight = HighlightStyle.define([
    { tag: [t.keyword, t.operatorKeyword, t.modifier], color: 'var(--accent)', fontWeight: '600' },
    { tag: [t.string, t.special(t.string)], color: 'var(--ok, #3a9c5a)' },
    { tag: [t.number, t.bool, t.null], color: 'var(--accent-warn, #d9880a)' },
    { tag: [t.lineComment, t.blockComment], color: 'var(--text-3)', fontStyle: 'italic' },
    {
        tag: [t.function(t.variableName), t.function(t.propertyName), t.typeName, t.className],
        color: 'var(--accent-cyan, #1f8fce)',
    },
    { tag: [t.propertyName, t.variableName], color: 'var(--text-1)' },
]);

interface SqlEditorProps {
    workspacePath?: string | null;
    openRequest: SqlEditorRequest | null;
    onApplyToNode?: (nodeId: string, result: SqlEditorResult) => void;
    onRun?: (nodeId: string, sqlText: string) => Promise<SqlRunResult>;
}

interface QueryTab {
    id: string;
    name: string;
    sql: string;
}

const MAIN = 'main';
const AI_TAB = 'ai';

// SQL Studio surface. Authors a code.sqlstudio node's SQL in a read-only DuckDB
// studio: working-DB catalog (left), CodeMirror editor + live preview grid, a
// collapsible AI pane. Multiple query tabs let the AI draft into its own tab
// without overwriting your query, so you can run and compare both.
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

    // Query tabs. The primary tab holds the node's SQL; the AI drafts into its
    // own tab. Results + sort are kept per tab so switching preserves them.
    const [tabs, setTabs] = useState<QueryTab[]>([{ id: MAIN, name: 'Query', sql: '' }]);
    const [activeId, setActiveId] = useState(MAIN);
    const [results, setResults] = useState<Record<string, SqlRunResult | null>>({});
    const [sorts, setSorts] = useState<Record<string, { col: string; dir: 'asc' | 'desc' } | null>>(
        {},
    );
    const [runningId, setRunningId] = useState<string | null>(null);
    const idSeq = useRef(1);
    const lastNonce = useRef<number>(-1);

    useEffect(() => {
        if (!openRequest) return;
        if (openRequest.nonce === lastNonce.current) return;
        lastNonce.current = openRequest.nonce;
        setNodeId(openRequest.nodeId);
        setNodeName(openRequest.nodeName);
        setTables(openRequest.tables ?? []);
        setRelationships(openRequest.relationships ?? []);
        setTabs([{ id: MAIN, name: 'Query', sql: openRequest.sql ?? '' }]);
        setActiveId(MAIN);
        setResults({});
        setSorts({});
    }, [openRequest]);

    const activeTab = tabs.find(t => t.id === activeId) ?? tabs[0];
    const activeSql = activeTab?.sql ?? '';
    const activeResult = results[activeId] ?? null;
    const activeSort = sorts[activeId] ?? null;

    const setActiveSql = useCallback(
        (v: string) => {
            setTabs(ts => ts.map(t => (t.id === activeId ? { ...t, sql: v } : t)));
            // Drop a stale error banner for this tab once the user edits.
            setResults(m => (m[activeId]?.error ? { ...m, [activeId]: null } : m));
        },
        [activeId],
    );

    const canApply = nodeId != null && onApplyToNode != null;
    const apply = useCallback(() => {
        if (nodeId != null && onApplyToNode && activeTab) {
            onApplyToNode(nodeId, { sql: activeTab.sql });
        }
    }, [nodeId, onApplyToNode, activeTab]);

    const runRef = useRef<() => void>(() => {});
    const run = useCallback(async () => {
        const tab = tabs.find(t => t.id === activeId);
        if (!tab || nodeId == null || !onRun || runningId) return;
        setRunningId(tab.id);
        try {
            const r = await onRun(nodeId, tab.sql);
            setResults(m => ({ ...m, [tab.id]: r }));
            setSorts(m => ({ ...m, [tab.id]: null }));
        } catch (e) {
            setResults(m => ({
                ...m,
                [tab.id]: { columns: [], rows: [], error: e instanceof Error ? e.message : String(e) },
            }));
        } finally {
            setRunningId(null);
        }
    }, [tabs, activeId, nodeId, onRun, runningId]);
    runRef.current = run;

    // AI drafts into its own tab (non-destructive) and we switch to it.
    const aiInsert = useCallback((generated: string) => {
        setTabs(ts => {
            const has = ts.some(t => t.id === AI_TAB);
            return has
                ? ts.map(t => (t.id === AI_TAB ? { ...t, sql: generated } : t))
                : [...ts, { id: AI_TAB, name: 'AI draft', sql: generated }];
        });
        setResults(m => ({ ...m, [AI_TAB]: null }));
        setActiveId(AI_TAB);
    }, []);

    const addTab = useCallback(() => {
        const id = `q${idSeq.current++}`;
        setTabs(ts => [...ts, { id, name: `Query ${ts.length + 1}`, sql: '' }]);
        setActiveId(id);
    }, []);

    const closeTab = useCallback(
        (id: string) => {
            if (id === MAIN) return;
            setTabs(ts => ts.filter(t => t.id !== id));
            setResults(m => {
                const n = { ...m };
                delete n[id];
                return n;
            });
            setActiveId(a => (a === id ? MAIN : a));
        },
        [],
    );

    // CodeMirror extensions — SQL language (catalog-aware autocomplete),
    // app-themed styling + highlight. Tab accepts the highlighted completion
    // (falls through to indent when the popup is closed); Mod-Enter runs.
    const extensions = useMemo(() => {
        const schema: SQLNamespace = {};
        for (const tbl of tables) {
            (schema as Record<string, string[]>)[tbl.name] = tbl.columns.map(c => c.name);
        }
        const defaultTable = tables.find(tb => tb.kind === 'input')?.name;
        return [
            sql({ schema, defaultTable, upperCaseKeywords: false }),
            duckleEditorTheme,
            syntaxHighlighting(duckleHighlight),
            Prec.highest(
                keymap.of([
                    { key: 'Tab', run: acceptCompletion },
                    {
                        key: 'Mod-Enter',
                        run: () => {
                            runRef.current();
                            return true;
                        },
                    },
                ]),
            ),
        ];
    }, [tables]);

    const sortedRows = useMemo(() => {
        if (!activeResult || !activeSort) return activeResult?.rows ?? [];
        const { col, dir } = activeSort;
        const factor = dir === 'asc' ? 1 : -1;
        return [...activeResult.rows].sort((a, b) => {
            const av = a[col];
            const bv = b[col];
            if (av == null && bv == null) return 0;
            if (av == null) return 1;
            if (bv == null) return -1;
            if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * factor;
            return String(av).localeCompare(String(bv)) * factor;
        });
    }, [activeResult, activeSort]);

    const toggleSort = (col: string) =>
        setSorts(m => {
            const s = m[activeId] ?? null;
            const next =
                s?.col === col
                    ? s.dir === 'asc'
                        ? { col, dir: 'desc' as const }
                        : null
                    : { col, dir: 'asc' as const };
            return { ...m, [activeId]: next };
        });

    if (nodeId == null) {
        return (
            <div className="sqlstudio">
                <div className="sqlstudio-empty">
                    Open a SQL Studio node from the canvas to author its query here.
                </div>
            </div>
        );
    }

    const running = runningId != null;

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
                        className="sqlstudio-btn"
                        onClick={run}
                        disabled={running || !onRun}
                        title="Run this query against upstream (⌘/Ctrl+Enter)"
                    >
                        {running ? (
                            <Loader2 size={14} className="sqlstudio-spin" strokeWidth={2} />
                        ) : (
                            <Play size={14} strokeWidth={2} />
                        )}
                        Run
                    </button>
                    <button
                        type="button"
                        className="sqlstudio-btn sqlstudio-btn--primary"
                        onClick={apply}
                        disabled={!canApply}
                        title="Write the active query back to the node"
                    >
                        <ArrowUpToLine size={14} strokeWidth={2} /> Apply to node
                    </button>
                </div>

                {/* Query tabs */}
                <div className="sqlstudio-qtabs">
                    {tabs.map(tb => (
                        <div
                            key={tb.id}
                            className={`sqlstudio-qtab${tb.id === activeId ? ' on' : ''}`}
                            onClick={() => setActiveId(tb.id)}
                        >
                            <span>{tb.name}</span>
                            {tb.id !== MAIN && (
                                <button
                                    className="sqlstudio-qtab-x"
                                    onClick={e => {
                                        e.stopPropagation();
                                        closeTab(tb.id);
                                    }}
                                    aria-label="Close tab"
                                >
                                    <X size={11} />
                                </button>
                            )}
                        </div>
                    ))}
                    <button className="sqlstudio-qtab-add" onClick={addTab} title="New query tab">
                        <Plus size={13} />
                    </button>
                </div>

                <div className="sqlstudio-editor">
                    <CodeMirror
                        value={activeSql}
                        height="100%"
                        theme="none"
                        extensions={extensions}
                        onChange={setActiveSql}
                        basicSetup={{ lineNumbers: true, foldGutter: false }}
                        placeholder="SELECT *, upper(status) AS status FROM input"
                    />
                </div>

                <div className="sqlstudio-res-head">
                    <span className="sqlstudio-res-lbl">Results</span>
                    {activeResult?.error ? (
                        <span className="sqlstudio-res-err">
                            <AlertTriangle size={13} /> {activeResult.error}
                        </span>
                    ) : activeResult ? (
                        <>
                            <span className="sqlstudio-res-ok">
                                {activeResult.rows.length} row
                                {activeResult.rows.length === 1 ? '' : 's'}
                            </span>
                            {activeResult.durationMs != null && (
                                <span className="sqlstudio-res-m">
                                    · {Math.round(activeResult.durationMs)} ms · read-only preview
                                </span>
                            )}
                        </>
                    ) : (
                        <span className="sqlstudio-res-m">Run the query to preview results.</span>
                    )}
                </div>

                <div className="sqlstudio-grid-wrap">
                    {activeResult && !activeResult.error && activeResult.columns.length > 0 ? (
                        <table className="sqlstudio-grid">
                            <thead>
                                <tr>
                                    <th className="rownum">#</th>
                                    {activeResult.columns.map(c => (
                                        <th key={c.name} onClick={() => toggleSort(c.name)}>
                                            {c.name}
                                            {activeSort?.col === c.name && (
                                                <span className="srt">
                                                    {activeSort.dir === 'asc' ? ' ▲' : ' ▼'}
                                                </span>
                                            )}
                                            {c.type && <span className="ty">{c.type}</span>}
                                        </th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {sortedRows.map((row, i) => (
                                    <tr key={i}>
                                        <td className="rownum">{i + 1}</td>
                                        {activeResult.columns.map(c => {
                                            const v = row[c.name];
                                            return (
                                                <td key={c.name}>
                                                    {v == null ? (
                                                        <span className="null">null</span>
                                                    ) : (
                                                        String(v)
                                                    )}
                                                </td>
                                            );
                                        })}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    ) : (
                        <div className="sqlstudio-grid-empty">
                            {activeResult?.error
                                ? 'Fix the query and run again.'
                                : 'No results yet.'}
                        </div>
                    )}
                </div>
            </div>

            {/* Always mounted so collapsing the pane keeps its conversation. */}
            <AiPane
                visible={showAi}
                onCollapse={() => setShowAi(false)}
                tables={tables}
                relationships={relationships}
                currentSql={activeSql}
                workspacePath={workspacePath}
                onInsert={aiInsert}
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
