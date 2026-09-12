import './blocks.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    AlertTriangle,
    Bookmark,
    ChartNoAxesCombined,
    Check,
    Database,
    FileCode2,
    FilePlus2,
    HelpCircle,
    LayoutGrid,
    Loader2,
    Network,
    RotateCw,
    Save,
    Sparkles,
    Wand2,
    X,
} from 'lucide-react';
import { maybeStartEditorTour, startEditorTour } from '../GuidedTour';
import ErdAuthoring from '../erd/ErdAuthoring';
import { inferRelationships } from '../erd/model';
import type { ErdRelationship, ErdTable } from '../erd/model';
import { loadSchemaModel, mergeRelationships, saveSchemaModel } from './model-io';
import QueryPane from '../sqleditor/QueryPane';
import AiPane from '../sqleditor/AiPane';
import type { SqlStudioColumn, SqlStudioTable } from '../sqleditor/types';
import { workspaceCatalog, workspaceCatalogRebuild } from '../tauri-bridge';
import {
    databaseGroups,
    durableSources,
    readExpression,
    unresolvedAttachSources,
} from './sources';
import { probeAll } from './probe';
import { runBlockSql } from './run';
import SourcesPanel from './SourcesPanel';
import SqlCatalogPanel from './SqlCatalogPanel';
import SavedQueriesPanel from './SavedQueriesPanel';
import UnsavedQueryDialog from './UnsavedQueryDialog';
import {
    exportQueries,
    importQueries,
    loadSavedQueries,
    queryId,
    removeQuery,
    saveSavedQueries,
    upsertQuery,
    withQueryHeader,
    type SavedQuery,
} from './query-io';
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
    /** Whether the AI pane is showing. The pane itself is always mounted. */
    const [showAi, setShowAi] = useState(false);
    // The AI's editable draft; non-null splits the SQL step into two panes.
    // A draft is NOT written straight into the editor, because the query you
    // already have is the one thing a suggestion can destroy — and you cannot
    // judge a generated query without running it. Side by side, both are
    // runnable, and accepting is a separate deliberate act.
    const [aiDraft, setAiDraft] = useState<string | null>(null);
    /** Saved queries, and which one the editor is currently holding. */
    const [saved, setSaved] = useState<SavedQuery[]>([]);
    const [savedOpen, setSavedOpen] = useState(false);
    const [activeQueryId, setActiveQueryId] = useState<string | null>(null);
    // Title and description are EDITOR fields, not a save-time prompt. A prompt
    // asks for the name at the one moment the author is least able to give it —
    // on the way out — and gives back nothing when the query is reopened, so
    // the description could never be read again. As fields they are filled
    // while the thinking is happening and restored with the query.
    const [queryTitle, setQueryTitle] = useState('');
    const [queryDesc, setQueryDesc] = useState('');
    /**
     * A move that is waiting on the unsaved-edits dialog.
     *
     * Held as an intention rather than run immediately, because the answer
     * decides whether it happens at all — Cancel has to leave the editor
     * exactly as it was, which means the move cannot have started.
     */
    const [pending, setPending] = useState<{ kind: 'new' | 'open'; query?: SavedQuery } | null>(
        null,
    );
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
                // No example query is seeded. One used to be, and it was in the
                // way rather than helpful: a non-empty editor is precisely what
                // stops the Joins list seeding a whole query, so the example had
                // to be deleted before the one-click joins could do their job.
                // An empty editor is also the honest starting state — there is
                // nothing to run until somebody says what they want.
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

    // Read each dataset's columns the first time a step that shows them is
    // opened. Not on mount: every probe spawns a DuckDB process, so it happens
    // when somebody actually asks to see the schema, not merely because the
    // surface is mounted behind another tab.
    //
    // The SQL step counts. Its catalog and its autocomplete are both column
    // lists, so going straight to SQL without passing through Schema used to
    // give an editor that completed nothing and a panel of empty tables.
    useEffect(() => {
        if ((step !== 'schema' && step !== 'sql') || probedRef.current || sources.length === 0)
            return;
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

    /** A source as the SQL surfaces see it: columns, plus its FROM address. */
    const asTable = useCallback(
        (s: BlockSource): SqlStudioTable => ({
            name: s.name,
            kind: 'upstream' as const,
            columns: schema[s.id] ?? s.columns.map(c => ({ name: c })),
            from: readExpression(s, activeGroup) ?? undefined,
        }),
        [schema, activeGroup],
    );

    // The SQL step's catalog and autocomplete, keyed on READABILITY rather than
    // on the canvas selection — see the note atop `SqlCatalogPanel`. The two
    // must agree: a name the panel lists and the editor will not complete (or
    // the reverse) is worse than either alone.
    const paneTables = useMemo(
        () => sources.filter(s => readExpression(s, activeGroup)).map(asTable),
        [sources, activeGroup, asTable],
    );
    const unreachableTables = useMemo(
        () => [
            ...otherDb.map(s => ({
                table: asTable(s),
                reason: 'in another database — switch above to read it',
            })),
            ...unresolved.map(s => ({ table: asTable(s), reason: 'no read can be composed' })),
        ],
        [otherDb, unresolved, asTable],
    );

    const run = useCallback(
        (text: string) => runBlockSql(text, workspacePath, 'Block', activeGroup?.dbPath ?? null),
        [workspacePath, activeGroup],
    );

    const acceptAiDraft = useCallback(() => {
        if (aiDraft != null) setSql(aiDraft);
        setAiDraft(null);
    }, [aiDraft]);

    // Saved queries load once per workspace, alongside the catalog.
    useEffect(() => {
        if (!workspacePath) return;
        let cancelled = false;
        void loadSavedQueries(workspacePath).then(qs => {
            if (!cancelled) setSaved(qs);
        });
        return () => {
            cancelled = true;
        };
    }, [workspacePath]);

    const commitSaved = useCallback(
        (next: SavedQuery[]) => {
            setSaved(next);
            void saveSavedQueries(workspacePath ?? '', next);
        },
        [workspacePath],
    );

    /** Save the editor's SQL under the title and description on the bar. */
    const saveQuery = useCallback(() => {
        const title = queryTitle.trim();
        if (!sql.trim() || !title) return;
        const current = saved.find(q => q.id === activeQueryId);
        const id = current?.id ?? queryId(title);
        // The header goes into the SQL, and the SQL goes back into the editor.
        // Both halves matter: writing it only to the stored copy would leave
        // the editor holding different text from the record, which is exactly
        // the state `dirty` reads as unsaved edits — so saving would leave the
        // query looking unsaved.
        const text = withQueryHeader(sql, title, queryDesc);
        setSql(text);
        const next = upsertQuery(saved, {
            id,
            title,
            description: queryDesc.trim() || undefined,
            query: { sql: text },
            meta: { createdAt: current?.meta?.createdAt ?? new Date().toISOString() },
        });
        commitSaved(next);
        // `upsertQuery` may have merged onto an existing entry of the same
        // title, so take the id back from the list rather than assuming ours.
        setActiveQueryId(next[0]?.id ?? id);
        setSavedOpen(true);
    }, [sql, queryTitle, queryDesc, saved, activeQueryId, commitSaved]);

    /** Load a saved query — SQL, title and description together. */
    const openQuery = useCallback((q: SavedQuery) => {
        setSql(q.query.sql);
        setQueryTitle(q.title);
        setQueryDesc(q.description ?? '');
        setActiveQueryId(q.id);
    }, []);

    /** Leave whatever is open and start from nothing. */
    const newQuery = useCallback(() => {
        setSql('');
        setQueryTitle('');
        setQueryDesc('');
        setActiveQueryId(null);
        setAiDraft(null);
    }, []);

    const activeSaved = useMemo(
        () => saved.find(q => q.id === activeQueryId) ?? null,
        [saved, activeQueryId],
    );

    /**
     * Are there edits that leaving would lose?
     *
     * Two cases, and both matter. Against a SAVED query it is a comparison —
     * opening one and reading it is not an edit, so arriving at a query must
     * not immediately claim it is dirty. With NO saved query it is simply
     * whether anything has been typed, because scratch work has nowhere to
     * have been kept.
     */
    const dirty = useMemo(() => {
        if (activeSaved) {
            return (
                sql !== activeSaved.query.sql ||
                queryTitle !== activeSaved.title ||
                queryDesc !== (activeSaved.description ?? '')
            );
        }
        return !!(sql.trim() || queryTitle.trim() || queryDesc.trim());
    }, [activeSaved, sql, queryTitle, queryDesc]);

    /** Ask first when leaving would lose edits; otherwise just go. */
    const requestNew = useCallback(() => {
        if (dirty) setPending({ kind: 'new' });
        else newQuery();
    }, [dirty, newQuery]);

    const requestOpen = useCallback(
        (q: SavedQuery) => {
            if (dirty && q.id !== activeQueryId) setPending({ kind: 'open', query: q });
            else openQuery(q);
        },
        [dirty, activeQueryId, openQuery],
    );

    const importSavedQueries = useCallback(async () => {
        try {
            const incoming = await importQueries();
            if (!incoming) return;
            // Merged, not replaced. An import is somebody handing you their
            // queries, not asking you to throw yours away — and `upsertQuery`
            // already folds same-title entries together, so re-importing a file
            // you already have updates rather than duplicates.
            let next = saved;
            for (const q of incoming) next = upsertQuery(next, q);
            commitSaved(next);
            setSavedOpen(true);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    }, [saved, commitSaved]);

    const exportSavedQueries = useCallback(async () => {
        const res = await exportQueries(saved);
        if (res !== 'ok' && res !== 'cancelled') setError(`Export failed: ${res}`);
    }, [saved]);

    const resolvePending = useCallback(
        (action: 'save' | 'discard') => {
            const p = pending;
            setPending(null);
            if (!p) return;
            if (action === 'save') saveQuery();
            if (p.kind === 'new') newQuery();
            else if (p.query) openQuery(p.query);
        },
        [pending, saveQuery, newQuery, openQuery],
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
                            attaches one database at a time, so switch to it in the panel on the
                            left to read {otherDb.length === 1 ? 'it' : 'them'}.
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

                {/* The left panel sits BELOW the step tabs, not beside them:
                    the tabs are the studio's top-level navigation and should
                    span the surface, while the panel serves the open step.

                    And it is the STEP's panel, not the studio's. Sources —
                    include/exclude — is a Schema-step control: it chooses what
                    goes on the ER canvas. The SQL step's question is what a
                    query can read, so it gets the table/field catalog instead.
                    Once each step owns its panel, the chart step can bring its
                    own without either of these two being in the way. */}
                <div className="blk-lower">
                    {step === 'sql' ? (
                        <SqlCatalogPanel
                            tables={paneTables}
                            unreachable={unreachableTables}
                            groups={groups}
                            activeDb={activeDb}
                            onSelectDb={setActiveDb}
                            relationships={relationships}
                            sql={sql}
                            onChangeSql={setSql}
                        />
                    ) : (

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
                    )}
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
                    {/* Second left panel, beside the catalog — the same slot the
                        Join Library takes on the Schema step, and only on the
                        step that can act on it. */}
                    {step === 'sql' && savedOpen ? (
                        <SavedQueriesPanel
                            queries={saved}
                            activeId={activeQueryId}
                            onOpen={requestOpen}
                            onRename={(id, title) =>
                                commitSaved(saved.map(q => (q.id === id ? { ...q, title } : q)))
                            }
                            onDelete={id => {
                                commitSaved(removeQuery(saved, id));
                                if (id === activeQueryId) setActiveQueryId(null);
                            }}
                            onClose={() => setSavedOpen(false)}
                            onImport={() => void importSavedQueries()}
                            onExport={() => void exportSavedQueries()}
                        />
                    ) : null}
                <div className="blk-body" data-tour="blocks-body">
                    {step === 'schema' ? (
                        erdTables.length > 0 ? (
                            <div className="blk-erd">
                                <div className="blk-bar">
                                    <span className="blk-bar-title">
                                        ER Model
                                        <small>
                                            {erdTables.length} durable dataset
                                            {erdTables.length === 1 ? '' : 's'}
                                        </small>
                                    </span>
                                    <span className="blk-bar-spacer" />
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
                        <div className="blk-sql">
                            <div className="blk-bar">
                                <span className="blk-bar-title">
                                    SQL
                                    <small>
                                        {paneTables.length} readable table
                                        {paneTables.length === 1 ? '' : 's'}
                                    </small>
                                </span>
                                <span className="blk-bar-spacer" />
                                <button
                                    className={`erd-btn${savedOpen ? ' erd-btn--on' : ''}`}
                                    onClick={() => setSavedOpen(o => !o)}
                                    title="Queries saved in this workspace"
                                >
                                    <FileCode2 size={14} /> Saved
                                    {saved.length > 0 ? ` (${saved.length})` : ''}
                                </button>
                                <button
                                    className={`erd-btn${showAi ? ' erd-btn--on' : ''}`}
                                    onClick={() => setShowAi(v => !v)}
                                    title="Ask AI to write SQL (text-to-SQL)"
                                >
                                    <Sparkles size={14} /> Ask AI
                                </button>
                                {/* Where Save used to be. Clicking a saved query
                                    puts the editor INTO that query, and every
                                    later edit belongs to it — so there has to be
                                    a way out that is not "delete what is there
                                    and hope". This is that way out. */}
                                <button
                                    className="erd-btn"
                                    onClick={requestNew}
                                    title="Start a new query, leaving the one open now"
                                >
                                    <FilePlus2 size={14} /> New query
                                </button>
                            </div>

                            {/* Below the toolbar rather than in it: a title and
                                a description are what the query IS, and they
                                are read far more often than the buttons are
                                pressed. The description gets the remaining
                                width because it is the part that has something
                                to say. */}
                            <div className="blk-qmeta">
                                <input
                                    className="blk-qmeta-title"
                                    value={queryTitle}
                                    placeholder="Title"
                                    aria-label="Query title"
                                    onChange={e => setQueryTitle(e.target.value)}
                                />
                                <input
                                    className="blk-qmeta-desc"
                                    value={queryDesc}
                                    placeholder="What this query answers (optional)"
                                    aria-label="Query description"
                                    onChange={e => setQueryDesc(e.target.value)}
                                />
                                {/* Save sits with the fields it saves, not with
                                    the step's navigation. The dot marks edits
                                    that leaving would lose — the same condition
                                    the dialog asks about, said quietly first. */}
                                <button
                                    className="erd-btn erd-btn--primary blk-qmeta-save"
                                    onClick={saveQuery}
                                    disabled={!sql.trim() || !queryTitle.trim()}
                                    title={
                                        !sql.trim()
                                            ? 'Write a query first'
                                            : !queryTitle.trim()
                                              ? 'Give the query a title to save it'
                                              : 'Save this query to the workspace'
                                    }
                                >
                                    <Save size={14} /> Save
                                    {dirty && activeSaved ? (
                                        <span className="blk-qmeta-dot" aria-hidden />
                                    ) : null}
                                </button>
                            </div>
                            {/* The node Studio's own split row, not a copy of it:
                                `sqlstudio-panes` already lays two panes side by
                                side and draws the divider between them. */}
                            <div className="sqlstudio-panes">
                                <QueryPane
                                    label="Query"
                                    sql={sql}
                                    onChange={setSql}
                                    run={run}
                                    tables={paneTables}
                                    placeholder="Write SQL, or add a join from the panel on the left."
                                />
                                {aiDraft != null && (
                                    <QueryPane
                                        label={
                                            <span className="sqlstudio-pane-ai">
                                                <Sparkles size={13} /> AI draft
                                            </span>
                                        }
                                        sql={aiDraft}
                                        onChange={v => setAiDraft(v)}
                                        run={run}
                                        tables={paneTables}
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

                {/* Always mounted, so collapsing the pane — or stepping away to
                    Schema and back — keeps the conversation. Visibility is
                    gated on the step as well as the toggle: the pane writes
                    SQL, and there is no editor to write into anywhere else. */}
                <AiPane
                    visible={step === 'sql' && showAi}
                    onCollapse={() => setShowAi(false)}
                    tables={paneTables}
                    relationships={relationships}
                    currentSql={sql}
                    workspacePath={workspacePath}
                    onInsert={setAiDraft}
                />
                </div>

                {pending ? (
                    <UnsavedQueryDialog
                        title={activeSaved?.title ?? queryTitle}
                        nextLabel={
                            pending.kind === 'new'
                                ? 'Starting a new query will leave them behind.'
                                : `Opening ${pending.query?.title} will leave them behind.`
                        }
                        canSave={!!sql.trim() && !!queryTitle.trim()}
                        onSave={() => resolvePending('save')}
                        onDiscard={() => resolvePending('discard')}
                        onCancel={() => setPending(null)}
                    />
                ) : null}
            </div>
        </div>
    );
}
