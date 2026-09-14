import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Play, Loader2, AlertTriangle } from 'lucide-react';
import CodeMirror from '@uiw/react-codemirror';
import { sqlExtensions } from './cm';
import type { SqlRunResult, SqlStudioTable } from './types';

interface QueryPaneProps {
    label: ReactNode;
    sql: string;
    onChange: (v: string) => void;
    // Run the pane's SQL against the node's upstream, returning the grid.
    run: (sql: string) => Promise<SqlRunResult>;
    tables: SqlStudioTable[];
    // Extra header buttons (e.g. Use this / Dismiss on the AI draft), left of Run.
    actions?: ReactNode;
    className?: string;
    // Empty-editor hint. Overridable because the default names `input`, which
    // exists inside a node and nowhere else — above the graph it reads as an
    // example query for a table that is not there.
    placeholder?: string;
    /** Builder mode: the SQL is a projection of the builder state, so editing
     *  it here would be edits with nowhere to live (plan §3). */
    readOnly?: boolean;
    /**
     * Rendered between the results header and the grid, for a successful run.
     *
     * A slot rather than the chart strip itself, because this pane is shared
     * with the SQL Editor NODE, where chart guidance means nothing — a node
     * writes a table, not a picture. Blocks passes something; the node passes
     * nothing and is unchanged.
     */
    resultInfo?: (result: SqlRunResult) => ReactNode;
    /**
     * The result of each run, for callers that need it outside the pane.
     *
     * The pane keeps owning its own result — two panes run independently and
     * lifting the state would entangle them. This is a copy for context, not
     * the source of truth.
     */
    onResult?: (result: SqlRunResult) => void;
    /**
     * Change this to throw the current result away.
     *
     * The pane owns its result — two panes run independently, and lifting that
     * state would entangle them — so clearing it has to be asked for from
     * outside rather than done to it. Starting a new query or opening a saved
     * one leaves a grid of rows belonging to a query that is no longer on
     * screen, which reads as the new query's answer.
     */
    resetToken?: number | string;
}

// One editor + its own results grid. Used full-width for the main query and,
// when the AI drafts, side-by-side so both can be run and compared. Keeps its
// own result/sort so switching panes doesn't lose anything.
export default function QueryPane({
    label,
    sql,
    onChange,
    run,
    tables,
    actions,
    className,
    placeholder,
    readOnly,
    resultInfo,
    onResult,
    resetToken,
}: QueryPaneProps) {
    const [result, setResult] = useState<SqlRunResult | null>(null);
    const [running, setRunning] = useState(false);
    const [sort, setSort] = useState<{ col: string; dir: 'asc' | 'desc' } | null>(null);

    // The sort goes with the result: a column ordering is about the grid that
    // is being cleared, and keeping it would apply a dead column's sort to
    // whatever runs next.
    useEffect(() => {
        setResult(null);
        setSort(null);
    }, [resetToken]);

    const runRef = useRef<() => void>(() => {});
    const doRun = useCallback(async () => {
        if (running) return;
        setRunning(true);
        try {
            const r = await run(sql);
            setResult(r);
            onResult?.(r);
            setSort(null);
        } catch (e) {
            const failed = {
                columns: [],
                rows: [],
                error: e instanceof Error ? e.message : String(e),
            };
            setResult(failed);
            // Reported too: a caller holding the last result should learn that
            // it is stale, not go on describing the one before it.
            onResult?.(failed);
        } finally {
            setRunning(false);
        }
    }, [run, sql, running, onResult]);
    runRef.current = doRun;

    const extensions = useMemo(() => sqlExtensions(tables, runRef), [tables]);

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
            s?.col === col ? (s.dir === 'asc' ? { col, dir: 'desc' } : null) : { col, dir: 'asc' },
        );

    return (
        <div className={`sqlstudio-pane${className ? ` ${className}` : ''}`}>
            <div className="sqlstudio-pane-head">
                <span className="sqlstudio-pane-label">{label}</span>
                <span className="sqlstudio-spacer" />
                {actions}
                {/* Primary, like the pipeline toolbar's Run. It is the action
                    this pane exists for, and it was reading as one more grey
                    button among the pane's controls. Solid triangle for the
                    same reason the toolbar uses one — an outlined play glyph
                    goes muddy at 14px on a filled background. */}
                <button
                    type="button"
                    className="sqlstudio-btn sqlstudio-btn--primary"
                    onClick={doRun}
                    disabled={running}
                    title="Run this query (⌘/Ctrl+Enter)"
                >
                    {running ? (
                        <Loader2 size={14} className="sqlstudio-spin" strokeWidth={2} />
                    ) : (
                        <Play size={13} fill="currentColor" strokeWidth={2} />
                    )}
                    Run
                </button>
            </div>

            <div className="sqlstudio-editor">
                <CodeMirror
                    value={sql}
                    height="100%"
                    theme="none"
                    extensions={extensions}
                    onChange={v => {
                        onChange(v);
                        if (result?.error) setResult(null);
                    }}
                    basicSetup={{ lineNumbers: true, foldGutter: false }}
                    editable={!readOnly}
                    placeholder={placeholder ?? 'SELECT *, upper(status) AS status FROM input'}
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
                                · {Math.round(result.durationMs)} ms
                            </span>
                        )}
                    </>
                ) : (
                    <span className="sqlstudio-res-m">Run to preview results.</span>
                )}
            </div>

            {resultInfo && result && !result.error && result.columns.length > 0
                ? resultInfo(result)
                : null}

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
                        {result?.error ? 'Fix the query and run again.' : 'No results yet.'}
                    </div>
                )}
            </div>
        </div>
    );
}
