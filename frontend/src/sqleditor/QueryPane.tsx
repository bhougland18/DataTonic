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
    /**
     * Change this to RUN the pane's SQL from outside.
     *
     * The pane owns the run and the result, the same way it owns clearing it
     * (`resetToken`), so a caller that needs a run ASKS for one rather than
     * running the query itself and holding a second copy of the answer — two
     * copies is how the grid and the chart would come to disagree.
     *
     * Opening a saved dive is the case this exists for: the SQL arrives from a
     * list, and the chart has to be drawn over a result nobody pressed Run for.
     */
    runToken?: number | string;
}

/**
 * Rows this grid will put in the DOM at once.
 *
 * Five times what a run used to return, so nothing that worked before is
 * clipped by it; well under what a chart now asks for. See `shownRows`.
 */
const GRID_ROW_LIMIT = 500;

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
    runToken,
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

    // Run when the caller asks. Through `runRef`, which is reassigned on every
    // render, so the run uses the SQL as it is NOW — a caller that sets the SQL
    // and bumps the token in one handler gets the new query, not the old one.
    //
    // The first pass is skipped deliberately: mounting is not a request to run,
    // and treating it as one would fire a DuckDB spawn for every pane that
    // appears.
    const askedRef = useRef(true);
    useEffect(() => {
        if (askedRef.current) {
            askedRef.current = false;
            return;
        }
        if (runToken === undefined) return;
        runRef.current();
    }, [runToken]);

    const sortedRows = useMemo(() => {
        if (!result || !sort) return result?.rows ?? [];
        // Sorting happens over ALL the rows, before the display cap below —
        // sorting a truncated list and calling it "largest first" would be a
        // different and wronger answer than showing fewer rows.
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

    /**
     * Rows put in the DOM. Not a cap on the RESULT — see the count in the head.
     *
     * This table is not virtualised: every row becomes a `<tr>` with a cell per
     * column. That was free while a run returned 100 rows and stopped being free
     * the moment charts started asking for thousands (`BLOCK_ROW_LIMIT`), which
     * they need because a chart draws its rows rather than sampling them. The
     * grid does not — a grid is read by scrolling, and nobody scrolls five
     * thousand rows looking for one.
     */
    const shownRows = sortedRows.length > GRID_ROW_LIMIT
        ? sortedRows.slice(0, GRID_ROW_LIMIT)
        : sortedRows;

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
                            {result.rows.length > GRID_ROW_LIMIT
                                ? ` · showing the first `
                                : ''}
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
                            {shownRows.map((row, i) => (
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
