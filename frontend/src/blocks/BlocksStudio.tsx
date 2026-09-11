import './blocks.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    AlertTriangle,
    Bookmark,
    ChartNoAxesCombined,
    Check,
    Database,
    HelpCircle,
    LayoutGrid,
    Loader2,
    Network,
    RotateCw,
    Save,
    Wand2,
} from 'lucide-react';
import { maybeStartEditorTour, startEditorTour } from '../GuidedTour';
import ErdAuthoring from '../erd/ErdAuthoring';
import { inferRelationships } from '../erd/model';
import type { ErdRelationship, ErdTable } from '../erd/model';
import { loadSchemaModel, mergeRelationships, saveSchemaModel } from './model-io';
import QueryPane from '../sqleditor/QueryPane';
import type { SqlStudioColumn, SqlStudioTable } from '../sqleditor/types';
import { workspaceCatalog, workspaceCatalogRebuild } from '../tauri-bridge';
import {
    databaseGroups,
    durableSources,
    readExpression,
    starterSql,
    unresolvedAttachSources,
} from './sources';
import { probeAll } from './probe';
import { runBlockSql } from './run';
import SourcesPanel from './SourcesPanel';
import JoinLibraryPanel from './JoinLibraryPanel';
import {
    applicableJoins,
    exportJoinLibrary,
    importJoinLibrary,
    loadJoinLibrary,
    removeJoin,
    saveJoinLibrary,
    toSavedJoin,
    upsertJoin,
    type JoinScope,
    type SavedJoin,
} from './join-library';
import type { BlockSource, BlockStep } from './types';

interface BlocksStudioProps {
    workspacePath?: string | null;
    /** Whether this surface is the one on screen. Blocks is always mounted (so
     *  in-progress work survives a trip to Canvas), so unlike the node-launched
     *  editors there is no `openRequest` edge to hang the first-run tour on —
     *  becoming visible is the equivalent moment. */
    active?: boolean;
    /** Pipeline id -> display name, for provenance. The catalog cannot supply
     *  this: it records each pipeline's id as its name. */
    pipelineNames?: Record<string, string>;
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
export default function BlocksStudio({
    workspacePath,
    active = false,
    pipelineNames,
}: BlocksStudioProps) {
    const [step, setStep] = useState<BlockStep>('schema');
    const [sources, setSources] = useState<BlockSource[]>([]);
    const [sql, setSql] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // Probed schemas by source id, and how far the probe has got. Kept separate
    // from `sources` because the catalog knows names, not columns.
    const [schema, setSchema] = useState<Record<string, SqlStudioColumn[]>>({});
    const [probe, setProbe] = useState<{ done: number; total: number } | null>(null);
    /** Sources whose schema could not be read, with the reason. */
    const [probeErrors, setProbeErrors] = useState<{ sourceId: string; error: string }[]>([]);
    /**
     * Source ids on the canvas. `null` means "everything", which is NOT the
     * same as a full set: a workspace that gains a dataset later should show it,
     * whereas an explicit selection should not silently grow. The distinction
     * only matters after a rescan, which is exactly when it is least expected.
     */
    const [selectedIds, setSelectedIds] = useState<string[] | null>(null);
    /** The saved-join library, both scopes combined. */
    const [library, setLibrary] = useState<SavedJoin[]>([]);
    const [libraryOpen, setLibraryOpen] = useState(false);
    /** Bumped to re-run auto-arrange on the diagram. */
    const [arrangeNonce, setArrangeNonce] = useState(0);
    // "Have we probed yet" is a REF, not state, and deliberately so. As state it
    // was both written inside the probe effect and listed in that effect's
    // dependencies, so setting it re-ran the effect, whose cleanup cancelled the
    // probe still in flight. The results were then thrown away: the progress
    // line stuck at its initial count forever and no schema ever arrived.
    const probedRef = useRef(false);
    // Which database file the SQL step attaches. One, not many: the engine's
    // `src.duckdb` prelude attaches under the fixed alias `duckle_src`, so a
    // query reaches exactly one database. Null when the workspace has none.
    const [activeDb, setActiveDb] = useState<string | null>(null);
    // Read inside `loadCatalog` without making it depend on `activeDb`: the
    // load effect keys off the callback identity, so a dependency here would
    // re-fetch the whole catalog every time the user switched database.
    const activeDbRef = useRef(activeDb);
    activeDbRef.current = activeDb;

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
                probedRef.current = false;
                // Not the model: a rescan re-reads the catalog, and re-seeding
                // would discard relationships edited since the last save.
                // `mergeRelationships` already drops any whose tables are gone.
                // Pick the database to attach, keeping the current one if it is
                // still in the catalog so a rescan does not move the user.
                const groups = databaseGroups(next);
                const keep = groups.find(g => g.dbPath === activeDbRef.current);
                const group = keep ?? groups[0] ?? null;
                setActiveDb(group?.dbPath ?? null);
                // Seed an example query the first time, from whichever source we
                // can actually read — never clobbering SQL already written.
                // A database table is preferred over a loose file: it is what a
                // pipeline most recently chose to publish.
                const readable =
                    next.find(s => readExpression(s, group) && s.format === 'attach') ??
                    next.find(s => readExpression(s, group));
                if (readable) setSql(prev => (prev.trim() ? prev : starterSql(readable, group)));
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
        if (step !== 'schema' || probedRef.current || sources.length === 0) return;
        let cancelled = false;
        probedRef.current = true;
        setProbe({ done: 0, total: 1 });
        void probeAll(sources, workspacePath, (done, total) => {
            if (!cancelled) setProbe({ done, total });
        })
            .then(results => {
                if (cancelled) return;
                const next: Record<string, SqlStudioColumn[]> = {};
                for (const r of results) if (r.columns.length > 0) next[r.sourceId] = r.columns;
                setSchema(next);
                setProbe(null);
                // Surface the reasons, rather than leaving a box that silently
                // reads "schema unknown" with nothing said about why. Reported
                // for ANY failure, not only a total one: a single unreadable
                // source among four good ones is the case most likely to be a
                // real bug, and the one least likely to be noticed.
                setProbeErrors(
                    results
                        .filter(r => r.error)
                        .map(r => ({ sourceId: r.sourceId, error: r.error as string })),
                );
            })
            .catch(e => {
                if (cancelled) return;
                setProbe(null);
                setError(e instanceof Error ? e.message : String(e));
            });
        return () => {
            cancelled = true;
        };
    }, [step, sources, workspacePath]);

    /** Membership test for the canvas. `null` selection means everything. */
    const selected = useMemo(
        () => new Set(selectedIds ?? sources.map(s => s.id)),
        [selectedIds, sources],
    );
    /** The sources actually on the canvas and in the SQL sidebar. */
    const shown = useMemo(() => sources.filter(s => selected.has(s.id)), [sources, selected]);

    // Every SELECTED dataset goes on the canvas, including ones whose schema we
    // could not read — an empty box is a true statement about a dataset that
    // exists, whereas omitting it would silently shrink the workspace.
    const erdTables: ErdTable[] = useMemo(
        () =>
            shown.map(s => ({
                name: s.name,
                // Probed schema first; the catalog's declared columns are a
                // fallback and are empty for most real datasets.
                columns: schema[s.id] ?? s.columns.map(c => ({ name: c })),
            })),
        [shown, schema],
    );
    // The authored ER model. Seeded from what was saved, falling back to
    // inference the first time. Held as state rather than derived, because past
    // this point it is the user's document, not a function of the catalog.
    const [relationships, setRelationships] = useState<ErdRelationship[]>([]);
    const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
    /** Tables whose edges are not drawn. See the toggle on each diagram node. */
    const [hiddenRelations, setHiddenRelations] = useState<string[]>([]);
    // A ref for the same reason `probedRef` is one: writing it inside the effect
    // that also depends on it makes the effect cancel its own in-flight load.
    const seededRef = useRef(false);

    // Seed the model: whatever was saved, else what inference suggests.
    //
    // Gated on COLUMNS, not just on tables. The catalog gives us table names
    // immediately but no columns — those arrive later from the probe — and
    // `inferRelationships` matches on column names, so seeding early produced
    // an empty set and then never retried. That is why the joins only appeared
    // after pressing Auto-infer.
    useEffect(() => {
        if (seededRef.current || !workspacePath || erdTables.length === 0) return;
        if (!erdTables.some(t => t.columns.length > 0)) return;
        let cancelled = false;
        seededRef.current = true;
        void Promise.all([loadSchemaModel(workspacePath), loadJoinLibrary(workspacePath)])
            .then(([saved, lib]) => {
                if (cancelled) return;
                setLibrary(lib);
                setRelationships(
                    mergeRelationships(
                        saved.relationships,
                        inferRelationships(erdTables),
                        erdTables,
                        applicableJoins(lib, erdTables),
                    ),
                );
                setHiddenRelations(saved.hiddenRelations);
            })
            .catch(() => {
                // A model we cannot read must not block authoring a new one.
                if (!cancelled) setRelationships(inferRelationships(erdTables));
            });
        return () => {
            cancelled = true;
        };
    }, [workspacePath, erdTables]);

    const edit = useCallback((next: ErdRelationship[]) => {
        setRelationships(next);
        setSaveState('idle');
    }, []);

    const reinfer = useCallback(() => edit(inferRelationships(erdTables)), [edit, erdTables]);

    // Toggling resolves `null` to the current full set first, so the first
    // un-tick turns "everything" into an explicit choice rather than clearing it.
    const toggleSource = useCallback(
        (id: string) =>
            setSelectedIds(prev => {
                const cur = prev ?? sources.map(s => s.id);
                return cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id];
            }),
        [sources],
    );

    const toggleSources = useCallback(
        (ids: string[], next: boolean) =>
            setSelectedIds(prev => {
                const cur = new Set(prev ?? sources.map(s => s.id));
                for (const id of ids) {
                    if (next) cur.add(id);
                    else cur.delete(id);
                }
                return [...cur];
            }),
        [sources],
    );

    // Library mutations all write through one place, so the two stores (the
    // workspace file and localStorage) can never drift from what is on screen.
    const commitLibrary = useCallback(
        (next: SavedJoin[]) => {
            setLibrary(next);
            void saveJoinLibrary(workspacePath, next);
        },
        [workspacePath],
    );

    const savedJoinIds = useMemo(() => new Set(library.map(j => j.id)), [library]);

    const saveJoins = useCallback(
        (rels: ErdRelationship[]) => {
            // Saved into the WORKSPACE by default. Promoting to global is a
            // deliberate second step in the panel: a join that happens to work
            // here is not yet a claim about every future engagement.
            let next = library;
            for (const r of rels) next = upsertJoin(next, toSavedJoin(r, 'workspace'));
            commitLibrary(next);
            setLibraryOpen(true);
        },
        [library, commitLibrary],
    );

    const applyJoin = useCallback((join: SavedJoin) => {
        setRelationships(prev =>
            prev.some(r => r.id === join.id)
                ? prev
                : [
                      ...prev,
                      {
                          id: join.id,
                          fromTable: join.fromTable,
                          fromColumn: join.fromColumn,
                          toTable: join.toTable,
                          toColumn: join.toColumn,
                          inferred: false,
                      },
                  ],
        );
        setSaveState('idle');
    }, []);

    const rescopeJoin = useCallback(
        (join: SavedJoin, scope: JoinScope) =>
            commitLibrary(upsertJoin(removeJoin(library, join.id, join.scope), { ...join, scope })),
        [library, commitLibrary],
    );

    const importLibrary = useCallback(async () => {
        try {
            const imported = await importJoinLibrary();
            if (!imported) return;
            let next = library;
            for (const j of imported) next = upsertJoin(next, j);
            commitLibrary(next);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    }, [library, commitLibrary]);

    const exportLibrary = useCallback(async () => {
        const res = await exportJoinLibrary(library);
        if (res !== 'ok' && res !== 'cancelled') setError(`Export failed: ${res}`);
    }, [library]);

    const toggleRelations = useCallback((table: string) => {
        setHiddenRelations(prev =>
            prev.includes(table) ? prev.filter(t => t !== table) : [...prev, table],
        );
        setSaveState('idle');
    }, []);

    const save = useCallback(async () => {
        if (!workspacePath) return;
        setSaveState('saving');
        const ok = await saveSchemaModel(workspacePath, relationships, hiddenRelations);
        setSaveState(ok ? 'saved' : 'idle');
        if (!ok) setError('Could not save the ER model.');
    }, [workspacePath, relationships, hiddenRelations]);

    // QueryPane's catalog sidebar — the selected set, since the SQL reads each
    // address inline rather than through a single bound input.
    const paneTables: SqlStudioTable[] = useMemo(
        () =>
            shown.map(s => ({
                name: s.name,
                kind: 'upstream' as const,
                columns: schema[s.id] ?? s.columns.map(c => ({ name: c })),
            })),
        [shown, schema],
    );

    // The database files the catalog knows about, and the one a query attaches.
    const groups = useMemo(() => databaseGroups(sources), [sources]);
    const activeGroup = useMemo(
        () => groups.find(g => g.dbPath === activeDb) ?? null,
        [groups, activeDb],
    );

    // Datasets we cannot compose a FROM for. Worth naming rather than hiding:
    // they are on the canvas and joinable-looking, so a silent omission would
    // invite a join to a table the SQL step cannot then read.
    //
    // Two distinct reasons now that ATTACH is wired, and they need different
    // words: a table in a database we are not attached to is readable, just not
    // right now, whereas an unresolvable source is never readable here.
    const unresolved = useMemo(
        () => [...unresolvedAttachSources(sources), ...sources.filter(s => s.format === 'unknown')],
        [sources],
    );
    const otherDb = useMemo(
        () => sources.filter(s => !readExpression(s, activeGroup) && !unresolved.includes(s)),
        [sources, activeGroup, unresolved],
    );

    const run = useCallback(
        (text: string) => runBlockSql(text, workspacePath, 'Block', activeGroup?.dbPath ?? null),
        [workspacePath, activeGroup],
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

                {otherDb.length > 0 ? (
                    <div className="blk-note blk-note--warn">
                        <AlertTriangle size={14} />
                        <span>
                            {otherDb.length} dataset{otherDb.length === 1 ? '' : 's'} live in another
                            database: <strong>{otherDb.map(s => s.name).join(', ')}</strong>. A query
                            attaches one database at a time, so switch to it above to read{' '}
                            {otherDb.length === 1 ? 'it' : 'them'}.
                        </span>
                    </div>
                ) : null}

                {probeErrors.length > 0 ? (
                    <div className="blk-note blk-note--warn">
                        <AlertTriangle size={14} />
                        <span>
                            Could not read the schema of{' '}
                            <strong>
                                {probeErrors
                                    .map(e => sources.find(s => s.id === e.sourceId)?.name ?? e.sourceId)
                                    .join(', ')}
                            </strong>
                            : {probeErrors[0].error}
                        </span>
                    </div>
                ) : null}

                {unresolved.length > 0 ? (
                    <div className="blk-note blk-note--warn">
                        <AlertTriangle size={14} />
                        <span>
                            {unresolved.length} dataset{unresolved.length === 1 ? '' : 's'} cannot be
                            read here: <strong>{unresolved.map(s => s.name).join(', ')}</strong>.
                            They are shown because they are real, but a query reading one will fail.
                        </span>
                    </div>
                ) : null}

                {/* Sources sit BELOW the step tabs, not beside them: the tabs
                    are the studio's top-level navigation and should span the
                    surface, while the panel scopes what the open step sees. */}
                <div className="blk-lower">
                    <SourcesPanel
                        sources={sources}
                        groups={groups}
                        selected={selected}
                        onToggle={toggleSource}
                        onToggleMany={toggleSources}
                        activeDb={activeDb}
                        onSelectDb={setActiveDb}
                        pipelineNames={pipelineNames}
                    />
                    {libraryOpen ? (
                        <JoinLibraryPanel
                            joins={library}
                            tables={erdTables}
                            onApply={applyJoin}
                            onRemove={(id, scope) => commitLibrary(removeJoin(library, id, scope))}
                            onRescope={rescopeJoin}
                            onExport={() => void exportLibrary()}
                            onImport={() => void importLibrary()}
                            onClose={() => setLibraryOpen(false)}
                        />
                    ) : null}
                <div className="blk-body" data-tour="blocks-body">
                    {step === 'schema' ? (
                        erdTables.length > 0 ? (
                            <div className="blk-erd">
                                <div className="blk-erd-bar">
                                    <span className="blk-erd-title">
                                        ER Model
                                        <small>
                                            {erdTables.length} durable dataset
                                            {erdTables.length === 1 ? '' : 's'}
                                        </small>
                                    </span>
                                    <span className="blk-erd-spacer" />
                                    <button
                                        className={`erd-btn${libraryOpen ? ' erd-btn--on' : ''}`}
                                        onClick={() => setLibraryOpen(o => !o)}
                                        title="Saved joins you can reuse here and in other workspaces"
                                    >
                                        <Bookmark size={14} /> Library
                                        {library.length > 0 ? ` (${library.length})` : ''}
                                    </button>
                                    <button
                                        className="erd-btn"
                                        onClick={() => setArrangeNonce(n => n + 1)}
                                        title="Arrange the tables by how they connect"
                                    >
                                        <LayoutGrid size={14} /> Arrange
                                    </button>
                                    <button
                                        className="erd-btn"
                                        onClick={reinfer}
                                        title="Re-infer all relationships from column names"
                                    >
                                        <Wand2 size={14} /> Auto-infer all
                                    </button>
                                    <button
                                        className="erd-btn erd-btn--primary"
                                        onClick={() => void save()}
                                        disabled={saveState !== 'idle'}
                                    >
                                        {saveState === 'saved' ? (
                                            <>
                                                <Check size={14} /> Saved
                                            </>
                                        ) : (
                                            <>
                                                <Save size={14} />{' '}
                                                {saveState === 'saving' ? 'Saving…' : 'Save model'}
                                            </>
                                        )}
                                    </button>
                                </div>
                                <ErdAuthoring
                                    tables={erdTables}
                                    relationships={relationships}
                                    onRelationshipsChange={edit}
                                    hiddenRelations={hiddenRelations}
                                    onToggleRelations={toggleRelations}
                                    arrangeNonce={arrangeNonce}
                                    onSaveJoins={saveJoins}
                                    savedJoinIds={savedJoinIds}
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
                                The Vega-Lite chart editor lands next (DAA.72): GUI controls over a
                                spec you can drop into JSON at any point and edit by hand or with
                                the AI pane. One spec, rendered by vega-embed wherever the chart is
                                shown — editor, report preview, PDF export and deck alike.
                            </p>
                        </div>
                    ) : null}
                </div>
                </div>
            </div>
        </div>
    );
}
