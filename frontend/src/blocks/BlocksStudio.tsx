import './blocks.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { normalizeBuilder } from './builder-ops';
import {
    AlertTriangle,
    ChartNoAxesCombined,
    Check,
    Database,
    FileCode2,
    FilePlus2,
    HelpCircle,
    Loader2,
    MousePointerClick,
    Network,
    RotateCcw,
    RotateCw,
    Save,
    Sparkles,
    X,
} from 'lucide-react';
import { maybeStartEditorTour, startEditorTour } from '../GuidedTour';
import { useTheme } from '../theme';
import { VegaChart } from '../dives/VegaChart';
import ErdEditor, { type ErdSavedModel } from '../erd/ErdEditor';
import type { ErdRelationship, ErdTable } from '../erd/model';
import { loadSchemaModel, saveSchemaModel } from './model-io';
import QueryPane from '../sqleditor/QueryPane';
import AiPane from '../sqleditor/AiPane';
import type { SqlRunResult, SqlStudioColumn, SqlStudioTable } from '../sqleditor/types';
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
import SelectedColumns from './SelectedColumns';
import SortList from './SortList';
import TransformsPanel from './TransformsPanel';
import { chartContext } from './chart-context';
import { addressOf } from './join-insert';
import { useQueryBuilder } from './useQueryBuilder';
import { clearDistinctCache, distinctValues } from './distinct-values';
import ChartShapeStrip from './ChartShapeStrip';
import ChartGallery from './ChartGallery';
import ChartEditorPanel from './ChartEditorPanel';
import DivesPanel from './DivesPanel';
import NameDialog from './NameDialog';
import { useChartEditor } from './useChartEditor';
import { asDive, sameDataset, toDive, type BlockDive } from './dive-promote';
import {
    CUSTOM_CHARTS_ID,
    customId,
    parseCustomCharts,
    removeCustom,
    storedCustomCharts,
    upsertCustom,
    type CustomChart,
} from './custom-charts';
import { loadItemPayload, saveItemPayload } from '../workspace';
import { identifierColumns, shapeFor } from './chart-shapes';
import FiltersPanel from './FiltersPanel';
import JoinReviewDialog from './JoinReviewDialog';
import { countRules } from './builder-types';
// Only what the HOST still decides for itself. Every other builder operation
// moved into `useQueryBuilder`, which is what makes the builder mountable by
// the SQL Studio node rather than by this component alone.
import { tableReason } from './builder-ops';
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
    /**
     * The workspace's dives, as repo item payloads.
     *
     * Passed in rather than read here because dives are REPO ITEMS: they are
     * enumerated from `repository.json`, they appear in the sidebar tree and the
     * Dives gallery, and `App.tsx` owns that list. Saved queries are different
     * — they are one payload this surface owns outright — which is exactly why
     * only this half needs threading.
     */
    dives?: unknown[];
    /** Write a dive. `App.tsx` upserts the repo item; persistence is automatic. */
    onSaveDive?: (dive: BlockDive) => void;
    onDeleteDive?: (id: string) => void;
}

/** Remembers "do not tell me about join types again", across workspaces. */
const JOIN_PROMPT_KEY = 'duckle.builder.joinPrompt';

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
    dives: divePayloads,
    onSaveDive,
    onDeleteDive,
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
     * Whether the builder owns the query (plan §3).
     *
     * Switching off does NOT clear the builder — it goes dormant, so coming
     * back restores what it held rather than needing the SQL parsed. The only
     * thing lost is edits made while it was off, and the switch says so.
     *
     * The builder ITSELF lives in `useQueryBuilder`, mounted below once the
     * catalog is known, because it needs the tables. This flag stays here: which
     * of two documents is on screen is a question about this surface, and the
     * SQL Studio node will answer it differently.
     */
    const [builderMode, setBuilderMode] = useState(true);
    /**
     * Shown the first time a query grows a join.
     *
     * The default is INNER, which silently drops rows that do not match — the
     * kind of wrong that looks like a smaller answer rather than an error. It
     * is worth interrupting for exactly once, and dismissable for good because
     * somebody who knows that does not need telling again.
     */
    const [joinPrompt, setJoinPrompt] = useState(false);
    const joinPromptShown = useRef(false);
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
            // Remembered filter values describe the data as it was. A rescan is
            // the moment somebody expects to see a pipeline's new output, so
            // serving yesterday's value list from cache would be the one time
            // it is actually misleading.
            clearDistinctCache();
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
    /**
     * A read-only MIRROR of the ER model, which `ErdEditor` owns.
     *
     * The SQL step builds queries from the relationships, so this surface needs
     * to read them — but not to write them. Keeping one owner is the point:
     * two copies of this model is how the Working DB node and this studio
     * drifted apart.
     */
    const [relationships, setRelationships] = useState<ErdRelationship[]>([]);

    /** Where this surface stores its ER model: a file in the workspace. The
     *  Working DB node stores its own on the node instead — that difference is
     *  the whole reason `ErdEditor` takes an adapter. */
    const erdPersistence = useMemo(
        () => ({
            key: `workspace:${workspacePath ?? ''}`,
            saveLabel: 'Save model',
            load: () =>
                workspacePath
                    ? loadSchemaModel(workspacePath)
                    : Promise.resolve({ relationships: [], hiddenRelations: [] }),
            save: (model: ErdSavedModel) =>
                workspacePath
                    ? saveSchemaModel(
                          workspacePath,
                          model.relationships,
                          model.hiddenRelations,
                          model.positions,
                      )
                    : Promise.resolve(false),
        }),
        [workspacePath],
    );

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

    // In builder mode the SQL is a projection, regenerated on every change.
    // Held as derived state rather than pushed into `sql` from a handler: an
    // effect writing into the editor on every tick is the shape that goes
    // subtly wrong when the two disagree.
    const qb = useQueryBuilder({
        tables: paneTables,
        relationships,
        title: queryTitle,
        description: queryDesc,
    });
    // Read-only aliases. The builder's state and every edit to it now live in
    // the hook, so the SQL Studio node can mount the same thing.
    const builder = qb.state;
    const builderSql = qb.sql;
    const stranded = qb.stranded;
    const editorSql = builderMode ? builderSql : sql;

    // The first join in a session earns one interruption. A ref, not state, so
    // asking does not itself re-trigger the effect that asked.
    useEffect(() => {
        if (builder.joins.length === 0 || joinPromptShown.current) return;
        joinPromptShown.current = true;
        if (localStorage.getItem(JOIN_PROMPT_KEY) === 'off') return;
        setJoinPrompt(true);
    }, [builder.joins.length]);

    /**
     * The values in one column, for a filter's dropdown.
     *
     * Needs the table's ADDRESS, not its name — `duckle_src."Item"` or a
     * parquet read — which only the catalog knows, so this is assembled here
     * and handed down rather than looked up in the panel.
     */
    const fetchFilterValues = useCallback(
        (table: string, column: string) =>
            distinctValues({
                // `addressOf`, not `table.from` — a table whose address IS its
                // name is the normal case inside a node, and reading `from`
                // directly returned no values at all there.
                from: addressOf(table, paneTables),
                column,
                workspacePath,
                database: activeGroup?.dbPath ?? null,
            }),
        [paneTables, workspacePath, activeGroup],
    );


    /**
     * The last run, kept so the AI pane can be told what is on screen.
     *
     * The pane owns its own result for rendering; this is a copy for context.
     * Without it the pane answers charting questions from general knowledge,
     * which is how "what do I need for a line chart" came back recommending
     * matplotlib.
     */
    const [lastRun, setLastRun] = useState<{
        result: SqlRunResult;
        /**
         * The SQL that produced it.
         *
         * Not the same as what the editor holds NOW, and the difference is
         * load-bearing: the dives strip decides whether a saved dive is another
         * facet of what is on screen by comparing SQL, and comparing against an
         * editor edited since the run would draw a chart over somebody else's
         * result. Same drift `aggregated` is snapshotted for.
         */
        sql: string;
        /**
         * The database it was ATTACHed against, or null for self-contained SQL.
         *
         * Snapshotted with the result for the same reason as `sql`: a dive
         * records this so it can run anywhere, and reading it from current
         * state at SAVE time is a different question from "what did this
         * result actually come from". One dive was written without it that way.
         */
        database: string | null;
        /** Undefined outside builder mode — hand-written SQL does not say. */
        aggregated?: boolean;
    } | null>(null);

    /**
     * Snapshot what produced the result, not what the builder holds NOW.
     *
     * Taken at run time because the two drift: removing an aggregate after
     * running leaves a grouped result on screen while the builder says
     * otherwise, and the strip would then judge the visible rows against a
     * query nobody has run.
     */
    const noteRun = useCallback(
        (result: SqlRunResult) => {
            setLastRun({
                result,
                // What the pane just ran is its `sql` prop, which is `editorSql`,
                // against the database `run` passes — read from the same place.
                sql: editorSql,
                database: activeGroup?.dbPath ?? null,
                aggregated: builderMode
                    ? qb.aggregated
                    : undefined,
            });
        },
        [builderMode, builder.columns, editorSql, qb.aggregated, activeGroup],
    );

    // One payload this surface owns outright, like the saved queries and unlike
    // the dives — a template is not a workspace item anybody else shows, so it
    // needs no repo plumbing.
    const [customs, setCustoms] = useState<CustomChart[]>([]);

    /**
     * Columns that identify a row rather than measure it.
     *
     * From facts the workspace already holds — the joins drawn on the Schema
     * step, and any primary key the probe reported. A foreign key is an
     * integer, so without this a line chart over vendor ID NUMBERS ranked
     * first and the bar chart was offered with the ID as its bar heights.
     * See `fieldsFromColumns`.
     */
    const identifiers = useMemo(
        () => identifierColumns(relationships, Object.values(schema).flat()),
        [relationships, schema],
    );

    /**
     * The chart, over the result on screen.
     *
     * Mounted HERE rather than inside the Charts step, for the same reason the
     * AI pane is always mounted: a chart half-refined is work, and stepping back
     * to SQL to look at the query it is drawn over must not throw it away.
     *
     * Fed the LAST RUN's columns, not the builder's current ones. The chart is
     * drawn over rows that exist, and judging it against a query nobody has run
     * is the drift `noteRun` was written to avoid.
     */
    const chart = useChartEditor({
        columns: lastRun?.result.columns ?? [],
        rowCount: lastRun?.result.rows.length,
        aggregated: lastRun?.aggregated,
        customs,
        identifiers,
    });
    const { theme } = useTheme();

    const aiContext = useMemo(
        // `chart.state` as well as the result: once a chart is picked, the
        // question the pane gets is about THAT chart, and answering it from the
        // list of everything that fits answers something nobody asked.
        () =>
            chartContext(
                lastRun?.result,
                { aggregated: lastRun?.aggregated },
                chart.state,
                identifiers,
            ),
        [lastRun, chart.state, identifiers],
    );

    /**
     * Take a chart from the strip under the results and go and refine it.
     *
     * `DAA.102`, and the step's seam with the SQL step: the strip already knows
     * which chart was chosen and the matcher already knows which column goes on
     * which channel, so the Charts step opens on a working spec. Writing that
     * mapping a second time over there is exactly how the two would disagree.
     */
    const pickChart = useCallback(
        (type: Parameters<typeof chart.pick>[0]) => {
            chart.pick(type);
            setStep('charts');
        },
        [chart],
    );

    /**
     * Throw away the result on screen, and everything derived from it.
     *
     * Three places hold a view of the last run and all three go together: the
     * pane's own grid (via `resetToken`), the available-charts strip that reads
     * it, and the copy the AI pane is given as context. Leaving any one behind
     * describes a query that is no longer on screen — the AI pane confidently
     * answering about columns nobody can see is the worst of the three.
     */
    const [resetToken, setResetToken] = useState(0);
    const clearResults = useCallback(() => {
        setResetToken(t => t + 1);
        setLastRun(null);
    }, []);

    // ---- Dives: one query, many charts ------------------------------------
    //
    // Ben's framing (2026-09-14): a dataset has several stories in it, and each
    // is a dive. So saving makes ANOTHER one rather than replacing the chart on
    // the query, and switching between two facets of one dataset must not
    // re-run a query whose answer is already on screen.

    /** Only the payloads that really are dives. A bad one costs itself. */
    const dives = useMemo(
        () => (divePayloads ?? []).map(asDive).filter((d): d is BlockDive => d !== null),
        [divePayloads],
    );
    /** The dive being edited, so Save can overwrite it rather than fork it. */
    const [activeDiveId, setActiveDiveId] = useState<string | null>(null);
    /** Whether the dives panel is showing, like `savedOpen` on the SQL step. */
    const [divesOpen, setDivesOpen] = useState(true);
    /**
     * A dive save waiting on the query being named (Ben, 2026-09-14).
     *
     * Held as an intention rather than done immediately, the same shape
     * `pending` uses for the unsaved-edits dialog: Cancel has to leave
     * everything as it was, so the save cannot have started.
     *
     * Why ask at all — a dive names its query in `-- name:` and is listed by
     * it, so a dive over an unsaved query produces "Untitled query · Bar chart"
     * and a SQL library that never learns about the query the dive depends on.
     * Asking once, here, is the only moment somebody has both in mind.
     */
    const [namingQueryFor, setNamingQueryFor] = useState<'new' | 'update' | null>(null);
    const activeDive = useMemo(
        () => dives.find(d => d.id === activeDiveId) ?? null,
        [dives, activeDiveId],
    );
    /** Bumped to ask `QueryPane` to run — it owns the run and the result. */
    const [runToken, setRunToken] = useState(0);

    /**
     * What to call a dive nobody has named.
     *
     * The chart's own title first, then the query's title plus the chart type.
     * The fallback matters more than it looks: saving two facets of one query
     * without typing anything gives "group by example · Bar chart" and
     * "group by example · Pie chart" rather than two identical names, which is
     * the difference between a usable list and a guessing game.
     */
    const diveName = useCallback(
        (
            /** The query's title, when the caller has a fresher one than state. */
            stemOverride?: string,
        ): string => {
            const own = chart.state?.title?.trim();
            if (own) return own;
            const stem = (stemOverride ?? queryTitle).trim() || 'Untitled query';
            const label = chart.state ? shapeFor(chart.state.chart)?.label : null;
            return label ? `${stem} · ${label}` : stem;
        },
        [chart.state, queryTitle],
    );

    /**
     * The editor has moved on from the result the chart is drawn over.
     *
     * A dive re-runs its own SQL on every open, so saving one in this state
     * would store a query whose result no longer has the columns the chart
     * names — and Vega-Lite draws that as an EMPTY chart rather than an error.
     * Refusing with a reason beats writing an artefact that is broken the first
     * time anybody opens it.
     */
    const runStale = !!lastRun && !sameDataset(lastRun.sql, editorSql);

    /**
     * Is the query behind this chart in the SQL library, as it stands NOW?
     *
     * Not merely "has a title": an edited-since-save query is one the library
     * does not have, and a dive over it would reference SQL that exists only in
     * this editor.
     *
     * A REF, read at call time, because it derives from `activeSaved` and
     * `dirty` — both declared below, with the saved-queries state they belong
     * to. Hoisting those above the chart editor purely to satisfy this would
     * move a lot of code for one boolean. Same trick `activeDbRef` uses.
     */
    const queryIsSavedRef = useRef(false);

    const saveDive = useCallback(
        (asNew: boolean) => {
            if (!onSaveDive || !chart.spec) return;
            // Name and file the query first — a dive is (query, chart), and
            // half of it living nowhere but this editor is how the pair comes
            // apart later.
            if (!queryIsSavedRef.current) {
                setNamingQueryFor(asNew ? 'new' : 'update');
                return;
            }
            const existing = asNew ? null : activeDive;
            const dive = toDive({
                id: existing?.id,
                createdAt: existing?.meta?.createdAt,
                title: existing && !asNew ? existing.title : diveName(),
                description: queryDesc,
                // The STORED form, header and all, so the dive explains itself
                // wherever it ends up — the same reason `saveQuery` does it.
                sql: withQueryHeader(editorSql, queryTitle.trim() || 'Untitled query', queryDesc),
                chart: chart.spec,
                builder: builderMode ? builder : undefined,
                // The database this SQL needs ATTACHed, taken from the RUN
                // rather than from current state. Blocks reads through
                // `src.duckdb`, so the SQL says `duckle_src."Vendor"` and a
                // dive without this is unrunnable outside this step — which is
                // how one got saved broken.
                source: lastRun?.database
                    ? {
                          kind: 'duckdb',
                          database: lastRun.database,
                          table: builderMode ? builder.anchor : undefined,
                      }
                    : undefined,
            });
            onSaveDive(dive);
            setActiveDiveId(dive.id);
        },
        [
            onSaveDive,
            chart.spec,
            activeDive,
            diveName,
            editorSql,
            queryTitle,
            queryDesc,
            builderMode,
            builder,
            lastRun,
        ],
    );



    /**
     * Open a dive — either a different FACET of what is on screen, or a
     * different query altogether.
     *
     * The two are genuinely different moves and the distinction is the whole
     * point of `sameDataset`: swapping facets is instant and touches nothing but
     * the chart, whereas a dive over another query replaces the SQL and has to
     * be run. Re-running a query whose answer is already on screen would make
     * flipping between two views of one dataset cost a DuckDB spawn each time.
     */
    const openDive = useCallback(
        (dive: BlockDive) => {
            setActiveDiveId(dive.id);
            if (lastRun && sameDataset(dive.query.sql, lastRun.sql)) {
                chart.load(dive.chart);
                setStep('charts');
                return;
            }
            setSql(dive.query.sql);
            // If the SQL library already holds this query, the editor joins
            // THAT query rather than floating free — so Save, the dirty dot and
            // the unsaved-edits prompt all behave as they would had you opened
            // it from the SQL step. Its title is the QUERY's name; the dive's
            // title names the picture, which is a different thing.
            const sameQuery = saved.find(q => sameDataset(q.query.sql, dive.query.sql)) ?? null;
            setQueryTitle(sameQuery?.title ?? dive.title);
            setQueryDesc(sameQuery?.description ?? dive.description ?? '');
            setActiveQueryId(sameQuery?.id ?? null);
            setAiDraft(null);
            if (dive.builder) {
                qb.setState(normalizeBuilder(dive.builder));
                setBuilderMode(true);
            } else {
                qb.reset();
                setBuilderMode(false);
            }
            chart.load(dive.chart);
            clearResults();
            // A dive re-runs on every open — that is what `dive-types.ts` means
            // by never-stale, and the chart has nothing to draw over until it
            // has. Asked of the pane rather than run here, so one result exists.
            setRunToken(t => t + 1);
            setStep('charts');
        },
        [lastRun, editorSql, chart, qb, clearResults, saved],
    );

    // ---- Custom chart templates --------------------------------------------
    //
    // The list itself is declared above, because the chart editor is fed it.

    useEffect(() => {
        if (!workspacePath) return;
        let cancelled = false;
        void loadItemPayload<unknown>(workspacePath, 'block', CUSTOM_CHARTS_ID).then(raw => {
            if (!cancelled) setCustoms(parseCustomCharts(raw));
        });
        return () => {
            cancelled = true;
        };
    }, [workspacePath]);

    const commitCustoms = useCallback(
        (next: CustomChart[]) => {
            setCustoms(next);
            if (workspacePath) {
                void saveItemPayload(
                    workspacePath,
                    'block',
                    CUSTOM_CHARTS_ID,
                    storedCustomCharts(next),
                );
            }
        },
        [workspacePath],
    );

    /**
     * Naming a template. Non-null while the dialog is open.
     *
     * NOT `window.prompt`: WebView2 does not implement it, so on the desktop
     * build the button would have done nothing at all and said nothing about
     * why. See `NameDialog`.
     */
    const [namingCustom, setNamingCustom] = useState(false);

    /** Find a template already filed under this name, case-insensitively. */
    const customNamed = useCallback(
        (name: string) => customs.find(c => c.name.toLowerCase() === name.trim().toLowerCase()),
        [customs],
    );

    /**
     * Keep the spec on screen as a template.
     *
     * Named here rather than in the panel, because the host owns the list and
     * therefore owns what a duplicate name means. Re-saving under an existing
     * name REVISES that template instead of growing a second one nobody can
     * tell apart — the dialog says "Replace" when that is what Save will do.
     */
    const saveCustom = useCallback(
        (name: string) => {
            if (!chart.spec) return;
            const existing = customNamed(name);
            commitCustoms(
                upsertCustom(customs, {
                    id: existing?.id ?? customId(name),
                    name,
                    spec: chart.spec,
                    createdAt: existing?.createdAt ?? new Date().toISOString(),
                }),
            );
            setNamingCustom(false);
        },
        [chart.spec, customs, customNamed, commitCustoms],
    );

    const deleteCustom = useCallback(
        (id: string) => {
            const c = customs.find(x => x.id === id);
            if (c && !window.confirm(`Delete the template "${c.name}"?`)) return;
            commitCustoms(removeCustom(customs, id));
        },
        [customs, commitCustoms],
    );

    const deleteDive = useCallback(
        (id: string) => {
            if (!onDeleteDive) return;
            const d = dives.find(x => x.id === id);
            if (d && !window.confirm(`Delete the dive "${d.title}"? This cannot be undone.`)) return;
            onDeleteDive(id);
            if (id === activeDiveId) setActiveDiveId(null);
        },
        [onDeleteDive, dives, activeDiveId],
    );


    /** Hand the query over, or take it back. */
    const toggleBuilder = useCallback(() => {
        if (builderMode) {
            // Off: the generated SQL becomes the editable text. Nothing is
            // lost, so nothing to confirm.
            setSql(builderSql);
            setBuilderMode(false);
            return;
        }
        // On: the builder's own state comes back, and whatever was typed since
        // switching off does not. That is worth asking about.
        const hasEdits = sql.trim() !== builderSql.trim();
        if (hasEdits && !window.confirm('Go back to the builder? Your SQL edits will be lost.')) {
            return;
        }
        setBuilderMode(true);
    }, [builderMode, builderSql, sql]);

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

    /**
     * Save what the editor is SHOWING, under the title and description.
     *
     * `editorSql`, not `sql`: in builder mode the text is generated and `sql`
     * holds whatever was last hand-written, which is usually nothing. Reading
     * the wrong one made Save look broken — it was disabled on an empty string
     * while a perfectly good query was on screen.
     */
    const saveQuery = useCallback(
        (
            /**
             * Override the editor's title/description.
             *
             * Needed because a caller that collects them in a dialog cannot set
             * state and then call this in the same tick — the closure would
             * still hold the old values. Passing them is the honest fix; an
             * effect that saves when the title changes would save on every
             * keystroke.
             */
            titleArg?: string,
            descArg?: string,
        ) => {
        const title = (titleArg ?? queryTitle).trim();
        const desc = descArg ?? queryDesc;
        const text = builderMode ? builderSql : sql;
        if (!text.trim() || !title) return;
        const current = saved.find(q => q.id === activeQueryId);
        const id = current?.id ?? queryId(title);
        // The header goes into the SQL, and the SQL goes back into the editor.
        // Both halves matter: writing it only to the stored copy would leave
        // the editor holding different text from the record, which is exactly
        // the state `dirty` reads as unsaved edits — so saving would leave the
        // query looking unsaved.
        const stored = withQueryHeader(text, title, desc);
        // Only the hand-written text is written back. In builder mode the SQL is
        // regenerated from state on every render, so pushing into `sql` would be
        // overwritten immediately — the header is already in `builderSql`
        // because the generator puts it there.
        if (!builderMode) setSql(stored);
        const next = upsertQuery(saved, {
            id,
            title,
            description: desc.trim() || undefined,
            query: { sql: stored },
            // The query and the chart are saved TOGETHER, as one artefact
            // (§7a). Not a second Save on the Charts step: a block is a dive,
            // and half a dive saved separately from its other half is two
            // records that can disagree.
            chart: chart.spec ?? undefined,
            // How it was authored, so reopening returns to the builder rather
            // than to SQL it would have to parse. Only in builder mode — in
            // hand-written mode the builder is dormant and its state describes
            // a different query.
            builder: builderMode ? builder : undefined,
            meta: { createdAt: current?.meta?.createdAt ?? new Date().toISOString() },
        });
        commitSaved(next);
        // Reflected back into the editor's own fields when they came from a
        // dialog, or the title bar would go on showing the old name while the
        // record has the new one.
        if (titleArg !== undefined) setQueryTitle(title);
        if (descArg !== undefined) setQueryDesc(desc);
        // `upsertQuery` may have merged onto an existing entry of the same
        // title, so take the id back from the list rather than assuming ours.
        setActiveQueryId(next[0]?.id ?? id);
        setSavedOpen(true);
        return next[0]?.id ?? id;
    }, [
        sql,
        builderMode,
        builderSql,
        builder,
        chart.spec,
        queryTitle,
        queryDesc,
        saved,
        activeQueryId,
        commitSaved,
        ],
    );

    /**
     * Load a saved query — SQL, chart, builder state, title and description.
     *
     * Which MODE it lands in is decided by the record, not by a default. A
     * query saved from the builder carries the builder state that produced it
     * (§7a), so it reopens in the builder; one without carries none, which is
     * the honest signal that it was hand-written, and it opens in SQL mode
     * exactly as the SQL Studio node does. Reconstructing builder state from
     * arbitrary SQL is the text-to-SQL problem the builder exists to avoid.
     *
     * Clearing the builder when there is nothing to restore matters as much as
     * switching off it. Left behind, it would still be generating the PREVIOUS
     * query, so toggling the builder back on would silently replace the query
     * just opened with the one before it.
     */
    const openQuery = useCallback(
        (q: SavedQuery) => {
            setSql(q.query.sql);
            setQueryTitle(q.title);
            setQueryDesc(q.description ?? '');
            setActiveQueryId(q.id);
            setAiDraft(null);
            if (q.builder) {
                qb.setState(normalizeBuilder(q.builder));
                setBuilderMode(true);
            } else {
                qb.reset();
                setBuilderMode(false);
            }
            // The chart comes back with the query, because they are one
            // artefact. `load` decides whether it opens in the controls or in
            // JSON — a spec the controls cannot model stays text.
            chart.load(q.chart ?? null);
            clearResults();
        },
        [qb, chart, clearResults],
    );

    /**
     * Leave whatever is open and start from nothing.
     *
     * The builder is reset too. Without that, New query cleared `sql` — which
     * in builder mode is not what is on screen — so the button appeared to do
     * nothing at all while every ticked column stayed exactly where it was.
     */
    const newQuery = useCallback(() => {
        setSql('');
        setQueryTitle('');
        setQueryDesc('');
        setActiveQueryId(null);
        setAiDraft(null);
        qb.reset();
        // Back to the default the studio opens in, not to whatever mode the
        // last query happened to leave behind.
        setBuilderMode(true);
        // The chart goes with the query. A chart left behind would be drawn
        // over a result belonging to a query nobody has open — the same class
        // of mistake `clearResults` exists to prevent.
        chart.clear();
        clearResults();
    }, [qb, chart, clearResults]);

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
     *
     * Reads `editorSql`, NOT `sql`. In builder mode `sql` holds whatever was
     * last hand-written — usually nothing — so a builder query full of ticked
     * columns read as a clean slate, and the "you will lose your changes"
     * prompt never appeared for the one kind of work most at risk of being
     * thrown away. Same bug Save had, and the same fix.
     *
     * Compared in its STORED form rather than raw, because saving rewrites the
     * `-- name:` header; comparing raw text would call a freshly saved query
     * dirty the moment its title was in the header twice over.
     */
    const dirty = useMemo(() => {
        if (activeSaved) {
            return (
                withQueryHeader(editorSql, queryTitle, queryDesc) !== activeSaved.query.sql ||
                queryTitle !== activeSaved.title ||
                queryDesc !== (activeSaved.description ?? '') ||
                // The chart counts, because the chart is half the artefact.
                // Without this, an afternoon spent refining a spec left no
                // trace of being unsaved and the dialog never appeared for it.
                // Compared as JSON: the spec is rebuilt from state on every
                // render, so it is never the same object twice.
                JSON.stringify(chart.spec ?? null) !== JSON.stringify(activeSaved.chart ?? null)
            );
        }
        return !!(editorSql.trim() || queryTitle.trim() || queryDesc.trim());
    }, [activeSaved, editorSql, queryTitle, queryDesc, chart.spec]);

    // Kept current for `saveDive`, which runs above this point.
    //
    // A DIVE counts as well as a saved query, and missing that was a bug worth
    // recording: opening a dive clears `activeQueryId` (it is not a saved
    // query), so re-saving an already-saved dive asked to name the query it had
    // just opened. A dive carries `query.sql` — the SQL is durable the moment a
    // dive holds it, whether or not the SQL library has a copy.
    queryIsSavedRef.current =
        (!!activeSaved && !dirty) ||
        (!!activeDive && sameDataset(activeDive.query.sql, editorSql));

    /**
     * The query was just named: file it, then make the dive that was waiting.
     *
     * `saveQuery` is given the values explicitly because state set in this tick
     * is not readable from the closure that follows it — and the dive's SQL
     * header has to carry the name the person just typed, not the blank it
     * replaced.
     */
    const nameQueryThenSaveDive = useCallback(
        (title: string, description?: string) => {
            const asNew = namingQueryFor === 'new';
            setNamingQueryFor(null);
            saveQuery(title, description ?? '');
            if (!onSaveDive || !chart.spec) return;
            const existing = asNew ? null : activeDive;
            const dive = toDive({
                id: existing?.id,
                createdAt: existing?.meta?.createdAt,
                // `diveName(title)` rather than the editor's title: the name
                // was typed a moment ago and state does not have it yet.
                title: existing && !asNew ? existing.title : diveName(title),
                description,
                sql: withQueryHeader(editorSql, title, description ?? ''),
                chart: chart.spec,
                builder: builderMode ? builder : undefined,
                source: lastRun?.database
                    ? {
                          kind: 'duckdb',
                          database: lastRun.database,
                          table: builderMode ? builder.anchor : undefined,
                      }
                    : undefined,
            });
            onSaveDive(dive);
            setActiveDiveId(dive.id);
        },
        [
            namingQueryFor,
            saveQuery,
            onSaveDive,
            chart.spec,
            diveName,
            activeDive,
            editorSql,
            builderMode,
            builder,
            lastRun,
        ],
    );

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
                            sql={editorSql}
                            onChangeSql={setSql}
                            selectionFor={builderMode ? qb.selectionFor : undefined}
                            activeJoins={builderMode ? qb.activeJoins : undefined}
                            onSetJoinMode={builderMode ? qb.setJoinMode : undefined}
                            onAddJoinTable={builderMode ? qb.addJoinTable : undefined}
                            reasonFor={
                                builderMode ? table => tableReason(builder, table) : undefined
                            }
                            excludedJoins={qb.excludedJoinIds}
                            onExcludeJoin={builderMode ? qb.excludeJoin : undefined}
                            onRestoreJoin={builderMode ? qb.restoreJoin : undefined}
                            canExcludeJoin={builderMode ? qb.canExcludeJoin : undefined}
                            transformCount={(builder.transforms ?? []).length || undefined}
                            transforms={
                                builderMode ? (
                                    <TransformsPanel
                                        transforms={builder.transforms ?? []}
                                        tables={paneTables}
                                        onUpsert={qb.upsertTransform}
                                        onRemove={qb.removeTransform}
                                        onToggle={qb.setTransformEnabled}
                                    />
                                ) : undefined
                            }
                            selectedCount={builder.columns.length}
                            filterCount={countRules(builder.filters)}
                            havingCount={countRules(builder.having)}
                            sortCount={builder.sort.length}
                            sort={
                                builderMode ? (
                                    <SortList
                                        sort={builder.sort}
                                        columns={builder.columns}
                                        onAdd={qb.addSort}
                                        onRemove={qb.removeSortAt}
                                        onChange={qb.setSortAt}
                                        onMove={qb.moveSort}
                                    />
                                ) : undefined
                            }
                            having={
                                builderMode && qb.havingOptions.length > 0 ? (
                                    <FiltersPanel
                                        root={builder.having}
                                        // Only the aggregated columns: HAVING
                                        // filters groups, and a group has no
                                        // value for a column it grouped BY.
                                        options={qb.havingOptions}
                                        onUpdate={qb.updateHaving}
                                        onAdd={qb.addHaving}
                                        onRemove={qb.removeHaving}
                                    />
                                ) : undefined
                            }
                            filters={
                                builderMode ? (
                                    <FiltersPanel
                                        root={builder.filters}
                                        options={qb.filterOptions}
                                        onUpdate={qb.updateFilter}
                                        onAdd={qb.addFilter}
                                        onRemove={qb.removeFilter}
                                        fetchValues={fetchFilterValues}
                                    />
                                ) : undefined
                            }
                            selected={
                                builderMode && builder.columns.length > 0 ? (
                                    <SelectedColumns
                                        columns={builder.columns}
                                        onMove={qb.moveColumn}
                                        onRemove={qb.removeColumn}
                                    />
                                ) : undefined
                            }
                        />
                    ) : step === 'schema' ? (
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
                    ) : step === 'charts' && onSaveDive ? (
                        // Always mounted: collapsed it is a RAIL, which is what
                        // keeps its own reopen control on screen.
                        <DivesPanel
                            dives={dives}
                            currentSql={editorSql}
                            activeId={activeDiveId}
                            onOpen={openDive}
                            onDelete={deleteDive}
                            collapsed={!divesOpen}
                            onToggle={() => setDivesOpen(o => !o)}
                        />
                    ) : null}
                    {/* Neither of the other two panels, which is what the note
                        above was waiting for: it brings its own panel (the
                        chart's controls), and a list of sources beside it is a
                        question already answered — the chart is drawn over a
                        result, not over a dataset you pick here. Two panels
                        also left the chart itself the narrowest thing on a
                        screen that exists to show it. */}
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
                                <ErdEditor
                                    tables={erdTables}
                                    subtitle={`${erdTables.length} durable dataset${
                                        erdTables.length === 1 ? '' : 's'
                                    }`}
                                    persistence={erdPersistence}
                                    workspacePath={workspacePath}
                                    onError={setError}
                                    onModelChange={m => setRelationships(m.relationships)}
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

                    {/* ALWAYS MOUNTED, hidden when another step is open — the
                        same trick `App.tsx` uses to keep Blocks and Reporting
                        alive behind each other, and for the same reason.

                        `QueryPane` owns its own result (two panes run
                        independently, and lifting that state would entangle
                        them), so unmounting this threw the result away: going
                        SQL → Charts → SQL came back to "No results yet" and the
                        query had to be re-run. Nobody noticed before the Charts
                        step existed, because there was nowhere worth going. */}
                    <div
                        className="blk-sql"
                        style={{ display: step === 'sql' ? 'flex' : 'none' }}
                    >
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

                            {/* A picked table the ER model cannot reach. Said
                                here rather than silently dropped: its columns
                                are in the SELECT, so the query is wrong in a
                                way the SQL alone does not explain. */}
                            {builderMode && stranded.length > 0 ? (
                                <div className="blk-note blk-note--warn">
                                    <AlertTriangle size={14} />
                                    <span>
                                        No relationship connects{' '}
                                        <strong>{stranded.join(', ')}</strong> to the rest of the
                                        query. Draw the join on the Schema step, or unpick those
                                        columns.
                                    </span>
                                </div>
                            ) : null}

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
                                    className="erd-btn erd-btn--accent blk-qmeta-save"
                                    onClick={() => saveQuery()}
                                    disabled={!editorSql.trim() || !queryTitle.trim()}
                                    title={
                                        !editorSql.trim()
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
                                    label={
                                        // The handover lives with the thing it
                                        // hands over, not in the step's
                                        // navigation: it is a statement about
                                        // THIS editor's contents.
                                        <span className="blk-mode">
                                            <button
                                                type="button"
                                                className={`blk-mode-toggle${
                                                    builderMode ? ' blk-mode-toggle--on' : ''
                                                }`}
                                                onClick={toggleBuilder}
                                                role="switch"
                                                aria-checked={builderMode}
                                                title={
                                                    builderMode
                                                        ? 'Switch the builder off and edit this SQL by hand'
                                                        : 'Switch the builder back on (discards SQL edits)'
                                                }
                                            >
                                                <span className="blk-mode-knob" />
                                            </button>
                                            <MousePointerClick size={13} />
                                            Query · {builderMode ? 'built' : 'hand-written'}
                                        </span>
                                    }
                                    sql={editorSql}
                                    onChange={setSql}
                                    run={run}
                                    tables={paneTables}
                                    readOnly={builderMode}
                                    placeholder={
                                        builderMode
                                            ? 'Tick columns on the left to build a query.'
                                            : 'Write SQL, or add a join from the panel on the left.'
                                    }
                                    // What this result could be charted as. On
                                    // the main query only: the AI draft is a
                                    // proposal, and telling somebody which
                                    // charts fit a query they have not accepted
                                    // yet is an answer to a question they are
                                    // not asking.
                                    resultInfo={r => (
                                        <ChartShapeStrip
                                            columns={r.columns}
                                            rowCount={r.rows.length}
                                            aggregated={lastRun?.aggregated}
                                            // The strip and the gallery must
                                            // agree about what is a measure.
                                            identifiers={identifiers}
                                            // Wiring this turns the chips from
                                            // labels into the way into the
                                            // Charts step (DAA.98/DAA.102).
                                            // The judgement was already beside
                                            // the data; now so is the action.
                                            onPick={pickChart}
                                        />
                                    )}
                                    onResult={noteRun}
                                    resetToken={resetToken}
                                    runToken={runToken}
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

                    {step === 'charts' ? (
                        // The dives strip sits ABOVE the run check, because a
                        // saved dive is the way back INTO a result — telling
                        // somebody to go and run a query while hiding the list
                        // of queries they have already saved would be the one
                        // moment the list is most useful.
                        <>
                        {!lastRun || lastRun.result.error ? (
                            // Nothing to chart is not the same as no chart. A
                            // spec is drawn over ROWS, and the honest thing to
                            // say when there are none is which step produces
                            // them — not an empty canvas that looks broken.
                            <div className="blk-blank">
                                <p>
                                    Run a query on the SQL step first — or open a saved dive, which
                                    brings its own query with it. A chart is drawn over the result,
                                    so what this step can offer depends on the columns that come
                                    back.
                                </p>
                                <div className="blk-blank-actions">
                                    <button className="erd-btn" onClick={() => setStep('sql')}>
                                        <Database size={14} /> Go to SQL
                                    </button>
                                </div>
                            </div>
                        ) : (
                            <div className="blk-charts">
                                <div className="blk-bar">
                                    <span className="blk-bar-title">
                                        {queryTitle.trim() || 'Untitled block'}
                                        <small>
                                            {lastRun.result.rows.length} row
                                            {lastRun.result.rows.length === 1 ? '' : 's'} ·{' '}
                                            {lastRun.result.columns.length} column
                                            {lastRun.result.columns.length === 1 ? '' : 's'}
                                        </small>
                                    </span>
                                    <span className="blk-bar-spacer" />
                                    {/* The dive controls live here now that the
                                        list is a panel: a dive is what this step
                                        PRODUCES, so its Save belongs with the
                                        step rather than inside the list of ones
                                        already saved. */}
                                    {runStale ? (
                                        <span className="blk-charts-hint">
                                            The SQL changed since this ran — run it again to save.
                                        </span>
                                    ) : !chart.spec ? (
                                        <span className="blk-charts-hint">
                                            Pick a chart to save this as a dive.
                                        </span>
                                    ) : null}
                                    {/* Beside Save as dive (Ben, 2026-09-14).
                                        Both act on the WHOLE chart, so they
                                        belong together in the step's bar rather
                                        than one being buried in the panel that
                                        edits the chart's details. */}
                                    {chart.state || chart.jsonOnly ? (
                                        <button
                                            type="button"
                                            className="erd-btn"
                                            onClick={chart.clear}
                                            title="Go back to the gallery and pick a different chart"
                                        >
                                            <RotateCcw size={14} /> Change chart
                                        </button>
                                    ) : null}
                                    {onSaveDive && activeDive && chart.spec && !runStale ? (
                                        <button
                                            type="button"
                                            className="erd-btn"
                                            onClick={() => saveDive(false)}
                                            title={`Overwrite "${activeDive.title}" with the chart on screen`}
                                        >
                                            <Save size={14} /> Save dive
                                        </button>
                                    ) : null}
                                    {onSaveDive && chart.spec && !runStale ? (
                                        <button
                                            type="button"
                                            className="erd-btn erd-btn--accent"
                                            onClick={() => saveDive(true)}
                                            title="Keep the chart on screen as another dive over this query"
                                        >
                                            <FilePlus2 size={14} />{' '}
                                            {activeDive ? 'Save as new dive' : 'Save as dive'}
                                        </button>
                                    ) : null}
                                </div>

                                {/* The gallery goes away once a chart is chosen
                                    and comes back through "Change chart". Both
                                    on screen at once would leave the thumbnail
                                    of what you picked sitting beside the real
                                    chart, which reads as two answers. */}
                                {chart.state || chart.jsonOnly ? (
                                    <div className="blk-charts-work">
                                        <div className="blk-charts-panel">
                                            <ChartEditorPanel
                                                editor={chart}
                                                onSaveCustom={() => setNamingCustom(true)}
                                            />
                                        </div>
                                        <div className="blk-charts-view">
                                            {chart.spec ? (
                                                <VegaChart
                                                    spec={chart.spec}
                                                    rows={lastRun.result.rows}
                                                    theme={theme === 'light' ? 'light' : 'dark'}
                                                    fit
                                                    height={340}
                                                    className="blk-charts-vega"
                                                />
                                            ) : null}
                                            {/* The row cap is the engine's
                                                preview limit, not this step's.
                                                Said because a chart over a
                                                truncated result is a chart that
                                                means something slightly
                                                different. */}
                                            {lastRun.result.rows.length >= 100 ? (
                                                <p className="blk-charts-cap">
                                                    Drawn over the first{' '}
                                                    {lastRun.result.rows.length} rows — a run
                                                    returns a preview, not the whole result.
                                                </p>
                                            ) : null}
                                        </div>
                                    </div>
                                ) : (
                                    <ChartGallery
                                        charts={chart.charts}
                                        onPick={chart.pick}
                                        theme={theme === 'light' ? 'light' : 'dark'}
                                        note="Pick one to refine it. Greyed cards say what they still need."
                                        customs={chart.customCharts}
                                        onPickCustom={chart.pickCustom}
                                        onDeleteCustom={deleteCustom}
                                        onNewCustom={chart.startCustom}
                                    />
                                )}
                            </div>
                        )}
                        </>
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
                    extraContext={aiContext}
                />
                </div>

                {joinPrompt ? (
                    <JoinReviewDialog
                        onClose={remember => {
                            if (remember) localStorage.setItem(JOIN_PROMPT_KEY, 'off');
                            setJoinPrompt(false);
                        }}
                    />
                ) : null}

                {/* A dive is (query, chart), so the query has to be somewhere
                    other than this editor before the pair is worth saving.
                    Asked here because this is the one moment somebody has both
                    the query and the picture in mind. */}
                {namingQueryFor ? (
                    <NameDialog
                        title="Name this query first"
                        body="A dive saves the query alongside the chart, so the query needs a name. It is added to the SQL library too, where you can reopen it."
                        initial={queryTitle.trim() || 'Untitled query'}
                        label="Query title"
                        placeholder="Total spend by vendor"
                        descriptionLabel="Description (optional)"
                        initialDescription={queryDesc}
                        descriptionPlaceholder="What this query answers"
                        onSubmit={nameQueryThenSaveDive}
                        onCancel={() => setNamingQueryFor(null)}
                    />
                ) : null}

                {namingCustom ? (
                    <NameDialog
                        title="Save as a custom chart"
                        body="Kept in this workspace and offered under Custom charts, matched to any result of the same shape."
                        initial={chart.state?.title?.trim() || diveName()}
                        label="Template name"
                        placeholder="Ranked bars, our house style"
                        takenLabel={n =>
                            customNamed(n) ? `Replaces the existing "${customNamed(n)!.name}" template.` : null
                        }
                        onSubmit={saveCustom}
                        onCancel={() => setNamingCustom(false)}
                    />
                ) : null}

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
