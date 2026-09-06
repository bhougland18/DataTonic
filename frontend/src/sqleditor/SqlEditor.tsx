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
    Braces,
    Network,
    AlertTriangle,
} from 'lucide-react';
import CodeMirror from '@uiw/react-codemirror';
import { sql, type SQLNamespace } from '@codemirror/lang-sql';
import { keymap, EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import './sqleditor.css';
import type { SqlEditorRequest, SqlEditorResult, SqlRunResult, SqlStudioTable } from './types';

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
    // Run the given SQL as this node against its upstream, returning the result
    // grid. Backed by the pipeline partial-run path (see App.handleRunSqlEditor).
    onRun?: (nodeId: string, sqlText: string) => Promise<SqlRunResult>;
}

type StudioTab = 'sql' | 'er';

// SQL Studio surface. Authors a code.sqlstudio node's SQL in a read-only DuckDB
// studio: a working-DB catalog (left), a CodeMirror editor + live preview grid
// (center). Runtime is identical to Inline SQL — "Apply to node" writes the SQL
// back. See docs/plans/sql-editor-node.md.
export default function SqlEditor({ openRequest, onApplyToNode, onRun }: SqlEditorProps) {
    const [sqlText, setSqlText] = useState('');
    const [nodeId, setNodeId] = useState<string | null>(null);
    const [nodeName, setNodeName] = useState<string | undefined>(undefined);
    const [tables, setTables] = useState<SqlStudioTable[]>([]);
    const [tab, setTab] = useState<StudioTab>('sql');
    const [running, setRunning] = useState(false);
    const [result, setResult] = useState<SqlRunResult | null>(null);
    const [sort, setSort] = useState<{ col: string; dir: 'asc' | 'desc' } | null>(null);
    const lastNonce = useRef<number>(-1);

    // Load the request whenever a (re)open fires. Keyed on nonce so the same
    // node reopening still reloads.
    useEffect(() => {
        if (!openRequest) return;
        if (openRequest.nonce === lastNonce.current) return;
        lastNonce.current = openRequest.nonce;
        setSqlText(openRequest.sql ?? '');
        setNodeId(openRequest.nodeId);
        setNodeName(openRequest.nodeName);
        setTables(openRequest.tables ?? []);
        setResult(null);
        setSort(null);
        setTab('sql');
    }, [openRequest]);

    const canApply = nodeId != null && onApplyToNode != null;
    const apply = useCallback(() => {
        if (nodeId != null && onApplyToNode) onApplyToNode(nodeId, { sql: sqlText });
    }, [nodeId, onApplyToNode, sqlText]);

    // Run in a ref so the CodeMirror keymap (memoized once) always calls the
    // latest closure with fresh sql/nodeId.
    const runRef = useRef<() => void>(() => {});
    const run = useCallback(async () => {
        if (nodeId == null || !onRun || running) return;
        setRunning(true);
        try {
            const r = await onRun(nodeId, sqlText);
            setResult(r);
            setSort(null);
        } catch (e) {
            setResult({ columns: [], rows: [], error: e instanceof Error ? e.message : String(e) });
        } finally {
            setRunning(false);
        }
    }, [nodeId, onRun, running, sqlText]);
    runRef.current = run;

    // CodeMirror extensions — SQL language (with catalog-aware autocomplete),
    // app-themed styling + highlight, and Mod-Enter to run. The `schema` feeds
    // the completion engine the upstream tables and their columns.
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
            keymap.of([
                {
                    key: 'Mod-Enter',
                    run: () => {
                        runRef.current();
                        return true;
                    },
                },
            ]),
        ];
    }, [tables]);

    const sortedRows = useMemo(() => {
        if (!result || !sort) return result?.rows ?? [];
        const { col, dir } = sort;
        const factor = dir === 'asc' ? 1 : -1;
        return [...result.rows].sort((a, b) => {
            const av = a[col];
            const bv = b[col];
            if (av == null && bv == null) return 0;
            if (av == null) return 1;
            if (bv == null) return -1;
            if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * factor;
            return String(av).localeCompare(String(bv)) * factor;
        });
    }, [result, sort]);

    const toggleSort = (col: string) =>
        setSort(s =>
            s?.col === col
                ? s.dir === 'asc'
                    ? { col, dir: 'desc' }
                    : null
                : { col, dir: 'asc' },
        );

    if (nodeId == null) {
        return (
            <div className="sqlstudio">
                <div className="sqlstudio-empty">
                    Open a SQL Studio node from the canvas to author its query here.
                </div>
            </div>
        );
    }

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
                        className="sqlstudio-btn"
                        onClick={run}
                        disabled={running || !onRun}
                        title="Run this SQL against upstream (⌘/Ctrl+Enter)"
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
                        title="Write this SQL back to the node"
                    >
                        <ArrowUpToLine size={14} strokeWidth={2} /> Apply to node
                    </button>
                </div>

                <div className="sqlstudio-tabs">
                    <button className={tab === 'sql' ? 'on' : ''} onClick={() => setTab('sql')}>
                        <Braces size={14} /> SQL Editor
                    </button>
                    <button className={tab === 'er' ? 'on' : ''} onClick={() => setTab('er')}>
                        <Network size={14} /> ER Diagram
                    </button>
                </div>

                {tab === 'sql' ? (
                    <>
                        <div className="sqlstudio-editor">
                            <CodeMirror
                                value={sqlText}
                                height="100%"
                                theme="none"
                                extensions={extensions}
                                onChange={v => {
                                    setSqlText(v);
                                    // Drop a stale error banner once the user edits.
                                    if (result?.error) setResult(null);
                                }}
                                basicSetup={{ lineNumbers: true, foldGutter: false }}
                                placeholder="SELECT *, upper(status) AS status FROM input"
                            />
                        </div>

                        <div className="sqlstudio-res-head">
                            <span className="sqlstudio-res-lbl">Results</span>
                            {result?.error ? (
                                <span className="sqlstudio-res-err">
                                    <AlertTriangle size={13} /> {result.error}
                                </span>
                            ) : result ? (
                                <>
                                    <span className="sqlstudio-res-ok">
                                        {result.rows.length} row{result.rows.length === 1 ? '' : 's'}
                                    </span>
                                    {result.durationMs != null && (
                                        <span className="sqlstudio-res-m">
                                            · {Math.round(result.durationMs)} ms · read-only preview
                                        </span>
                                    )}
                                </>
                            ) : (
                                <span className="sqlstudio-res-m">
                                    Run the query to preview results.
                                </span>
                            )}
                        </div>

                        <div className="sqlstudio-grid-wrap">
                            {result && !result.error && result.columns.length > 0 ? (
                                <table className="sqlstudio-grid">
                                    <thead>
                                        <tr>
                                            <th className="rownum">#</th>
                                            {result.columns.map(c => (
                                                <th key={c.name} onClick={() => toggleSort(c.name)}>
                                                    {c.name}
                                                    {sort?.col === c.name && (
                                                        <span className="srt">
                                                            {sort.dir === 'asc' ? ' ▲' : ' ▼'}
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
                                                {result.columns.map(c => {
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
                                    {result?.error
                                        ? 'Fix the query and run again.'
                                        : 'No results yet.'}
                                </div>
                            )}
                        </div>
                    </>
                ) : (
                    <div className="sqlstudio-soon">
                        <span className="sqlstudio-glyph">
                            <Network size={16} />
                        </span>
                        <b>ER Diagram</b>
                        <p>Coming next — a read-only view of the entity-relationship model defined
                            on the upstream Working DB node, shared by every SQL Studio wired to it.</p>
                    </div>
                )}
            </div>
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
