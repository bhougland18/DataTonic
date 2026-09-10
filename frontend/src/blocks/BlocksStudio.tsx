import './blocks.css';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    AlertTriangle,
    ChartNoAxesCombined,
    Database,
    HelpCircle,
    Loader2,
    Network,
    RotateCw,
} from 'lucide-react';
import { maybeStartEditorTour, startEditorTour } from '../GuidedTour';
import ErDiagram from '../erd/ErDiagram';
import { inferRelationships } from '../erd/model';
import type { ErdTable } from '../erd/model';
import QueryPane from '../sqleditor/QueryPane';
import type { SqlStudioColumn, SqlStudioTable } from '../sqleditor/types';
import { workspaceCatalog, workspaceCatalogRebuild } from '../tauri-bridge';
import { durableSources, starterSql } from './sources';
import { probeAll } from './probe';
import { runBlockSql } from './run';
import type { BlockSource, BlockStep } from './types';

interface BlocksStudioProps {
    workspacePath?: string | null;
    /** Whether this surface is the one on screen. Blocks is always mounted (so
     *  in-progress work survives a trip to Canvas), so unlike the node-launched
     *  editors there is no `openRequest` edge to hang the first-run tour on —
     *  becoming visible is the equivalent moment. */
    active?: boolean;
}

const STEPS: { id: BlockStep; label: string; Icon: typeof Network }[] = [
    { id: 'schema', label: 'Schema', Icon: Network },
    { id: 'sql', label: 'SQL', Icon: Database },
    { id: 'charts', label: 'Charts', Icon: ChartNoAxesCombined },
];

/**
 * Blocks — authoring the reusable pieces deliverables are made of.
 *
 * Deliberately knows nothing about dashboards, reports or decks: a block is
 * assembled into those elsewhere (`reporting/`), and asking "which output?"
 * here would destroy the reuse that makes one query serve all three.
 *
 * There is no "pick one source" step. A one-table ER diagram is just a column
 * list — the schema earns its place only across several sources, and the joins
 * between them are the thing worth seeing before writing SQL. So every durable
 * dataset in the workspace goes on the canvas from the start, which is the same
 * shape as the Working DB node: collect many sources, name them, query them by
 * name, move no data.
 *
 * Like the Reporting surface and unlike every other rail entry, this is NOT
 * node-launched — it reads durable sinks, takes no `openRequest`, and applies
 * nothing back to a node.
 */
export default function BlocksStudio({ workspacePath, active = false }: BlocksStudioProps) {
    const [step, setStep] = useState<BlockStep>('schema');
    const [sources, setSources] = useState<BlockSource[]>([]);
    const [sql, setSql] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // Probed schemas by source id, and how far the probe has got. Kept separate
    // from `sources` because the catalog knows names, not columns.
    const [schema, setSchema] = useState<Record<string, SqlStudioColumn[]>>({});
    const [probe, setProbe] = useState<{ done: number; total: number } | null>(null);
    const [probed, setProbed] = useState(false);

    // Load the durable sources from the workspace catalog. A read failure is
    // shown, never flattened to "no sources" — an unreadable catalog and an
    // empty one look identical as an empty list, and only one is good news.
    const loadCatalog = useCallback(
        async (rebuild = false) => {
            if (!workspacePath) {
                setSources([]);
                return;
            }
            setLoading(true);
            setError(null);
            try {
                const view = rebuild
                    ? await workspaceCatalogRebuild(workspacePath)
                    : await workspaceCatalog(workspacePath);
                const next = durableSources(view.assets ?? []);
                setSources(next);
                setSchema({});
                setProbed(false);
                // Seed an example query the first time, from whichever source we
                // can actually read — never clobbering SQL already written.
                const readable = next.find(s => s.format !== 'attach' && s.format !== 'unknown');
                if (readable) setSql(prev => (prev.trim() ? prev : starterSql(readable)));
            } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
                setSources([]);
            } finally {
                setLoading(false);
            }
        },
        [workspacePath],
    );

    useEffect(() => {
        void loadCatalog(false);
    }, [loadCatalog]);

    // First time Blocks is opened, walk its tour once. It carries the mental
    // model — canvas gathers, blocks build pieces, reporting assembles — which
    // is the one thing the surface itself cannot show.
    useEffect(() => {
        if (active) maybeStartEditorTour('blocks');
    }, [active]);

    // Read each dataset's columns the first time the Schema step is opened.
    // Not on mount: every probe spawns a DuckDB process, so it happens when
    // somebody actually asks to see the schema, not merely because the surface
    // is mounted behind another tab.
    useEffect(() => {
        if (step !== 'schema' || probed || sources.length === 0) return;
        let cancelled = false;
        setProbed(true);
        setProbe({ done: 0, total: sources.length });
        void probeAll(sources, workspacePath, (done, total) => {
            if (!cancelled) setProbe({ done, total });
        }).then(results => {
            if (cancelled) return;
            const next: Record<string, SqlStudioColumn[]> = {};
            for (const r of results) if (r.columns.length > 0) next[r.sourceId] = r.columns;
            setSchema(next);
            setProbe(null);
        });
        return () => {
            cancelled = true;
        };
    }, [step, probed, sources, workspacePath]);

    // Every durable dataset goes on the canvas, including ones whose schema we
    // could not read — an empty box is a true statement about a dataset that
    // exists, whereas omitting it would silently shrink the workspace.
    const erdTables: ErdTable[] = useMemo(
        () =>
            sources.map(s => ({
                name: s.name,
                // Probed schema first; the catalog's declared columns are a
                // fallback and are empty for most real datasets.
                columns: schema[s.id] ?? s.columns.map(c => ({ name: c })),
            })),
        [sources, schema],
    );
    const erdRelationships = useMemo(() => inferRelationships(erdTables), [erdTables]);

    // QueryPane's catalog sidebar — the same full set, since the SQL reads each
    // address inline rather than through a single bound input.
    const paneTables: SqlStudioTable[] = useMemo(
        () =>
            sources.map(s => ({
                name: s.name,
                kind: 'upstream' as const,
                columns: schema[s.id] ?? s.columns.map(c => ({ name: c })),
            })),
        [sources, schema],
    );

    // Datasets we cannot compose a FROM for. Worth naming rather than hiding:
    // they are on the canvas and joinable-looking, so a silent omission would
    // invite a join to a table the SQL step cannot then read.
    const unreadable = useMemo(
        () => sources.filter(s => s.format === 'attach' || s.format === 'unknown'),
        [sources],
    );

    const run = useCallback(
        (text: string) => runBlockSql(text, workspacePath, 'Block'),
        [workspacePath],
    );

    if (!workspacePath) {
        return (
            <div className="blk blk-empty">
                <p>Open a workspace to build blocks.</p>
            </div>
        );
    }

    return (
        <div className="blk">
            <div className="blk-main">
                <header className="blk-head">
                    <span className="blk-count" data-tour="blocks-source">
                        {loading
                            ? 'Reading the workspace catalog…'
                            : probe
                              ? `Reading schemas… ${probe.done} of ${probe.total}`
                              : `${sources.length} durable dataset${sources.length === 1 ? '' : 's'}`}
                    </span>
                    <button
                        type="button"
                        className="blk-icon-btn"
                        title="Rescan the workspace catalog"
                        onClick={() => void loadCatalog(true)}
                        disabled={loading}
                    >
                        {loading ? <Loader2 size={14} className="blk-spin" /> : <RotateCw size={14} />}
                    </button>

                    <nav className="blk-steps" data-tour="blocks-steps">
                        {STEPS.map(s => (
                            <button
                                key={s.id}
                                type="button"
                                className={`blk-step${step === s.id ? ' blk-step--active' : ''}`}
                                onClick={() => setStep(s.id)}
                            >
                                <s.Icon size={14} strokeWidth={1.75} />
                                {s.label}
                            </button>
                        ))}
                    </nav>

                    <button
                        type="button"
                        className="editor-help-btn"
                        data-tour="blocks-help"
                        onClick={() => startEditorTour('blocks')}
                        title="Show the Blocks tour"
                        aria-label="Show the Blocks tour"
                    >
                        <HelpCircle size={16} />
                    </button>
                </header>

                {error ? (
                    <div className="blk-note blk-note--error">
                        <AlertTriangle size={14} />
                        <span>Could not read the workspace catalog: {error}</span>
                    </div>
                ) : null}

                {unreadable.length > 0 ? (
                    <div className="blk-note blk-note--warn">
                        <AlertTriangle size={14} />
                        <span>
                            {unreadable.length} dataset{unreadable.length === 1 ? '' : 's'} on the
                            canvas cannot be read inline yet — ATTACH is not wired:{' '}
                            <strong>{unreadable.map(s => s.name).join(', ')}</strong>. They are shown
                            because they are real, but a query joining one will fail until then.
                        </span>
                    </div>
                ) : null}

                <div className="blk-body" data-tour="blocks-body">
                    {step === 'schema' ? (
                        erdTables.length > 0 ? (
                            <div className="blk-erd">
                                <ErDiagram
                                    tables={erdTables}
                                    relationships={erdRelationships}
                                    readOnly
                                />
                            </div>
                        ) : (
                            <div className="blk-blank">
                                <p>
                                    {loading
                                        ? 'Reading the workspace catalog…'
                                        : 'The catalog lists no durable datasets with columns yet. Run a pipeline that writes one, then rescan.'}
                                </p>
                            </div>
                        )
                    ) : null}

                    {step === 'sql' ? (
                        <QueryPane
                            label="SQL"
                            sql={sql}
                            onChange={setSql}
                            run={run}
                            tables={paneTables}
                            className="blk-query"
                        />
                    ) : null}

                    {step === 'charts' ? (
                        <div className="blk-blank">
                            <p>
                                The editable vgplot chart designer lands next (DAA.72). One spec
                                language for every output — baked to SVG for a report or deck, live
                                for a dashboard.
                            </p>
                        </div>
                    ) : null}
                </div>
            </div>
        </div>
    );
}
