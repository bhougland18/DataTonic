import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { isWebBackend } from './web-fs';

// First-run guided tour: a spotlight walkthrough of the core surfaces. Anchors
// to [data-tour="..."] markers; if a marker is missing the step degrades to a
// centered card, so the tour never breaks. Dismissal persists to localStorage;
// re-launch by dispatching window event "duckle:start-tour".

// Bumped to v3: the tour is now surface-aware (a step that targets a button only
// the desktop app shows is dropped on the self-hosted web editor, so the step
// count and spotlights always match what is on screen), and gained Save,
// Run-parameters and Trust coverage plus richer how-to copy.
// Bumped to v4: added a Live preview step (the lightning toggle is otherwise
// easy to miss), so prior users who finished v3 see it once.
// Bumped to v5: the tour now covers every capability rather than the editor
// alone, is grouped into chapters, and is walked rather than skipped on a first
// run. Anyone who finished v4 sees the fuller one once.
const SEEN_KEY = 'duckle.tour.v5.done';

/** Fired when the tour finishes or is skipped, so Home can take the screen after it. */
export const TOUR_FINISHED_EVENT = 'duckle:tour-finished';

/**
 * Whether this machine has already been walked through the tour.
 *
 * Exported because Home has to know: on a first run the tour goes first and Home waits for
 * it. Two "here is Duckle" screens competing for the same moment is worse than either of
 * them alone, and the tour is the one that explains what Home is for.
 */
export function tourAlreadySeen(): boolean {
    try {
        return !!localStorage.getItem(SEEN_KEY);
    } catch {
        // Storage off: treat it as seen, so a browser that cannot remember never traps
        // somebody in a tour on every single launch.
        return true;
    }
}

/** The window event that opens a tour. `detail` selects which one and whether it can be skipped. */
export const TOUR_EVENT = 'duckle:start-tour';

/**
 * The localStorage "seen" flag for a tour.
 *
 * The main first-run tour keeps its historical, version-bumped key so nobody re-sees it. Each
 * editor tour gets its own independent key, so opening SQL Studio for the first time fires the
 * SQL tour regardless of whether the main tour was ever finished, and vice versa.
 */
function seenKey(tourId: string): string {
    return tourId === 'main' ? SEEN_KEY : `duckle.tour.${tourId}.v1.done`;
}

/**
 * Fire an editor's first-run tour the first time that editor is opened, once.
 *
 * Called from each editor's open effect. It is a no-op after the first open (its own seen key),
 * and defers a frame so the just-mounted surface has laid out and its anchors are measurable
 * before the always-mounted GuidedTour resolves them. Editor tours open in mandatory mode.
 */
export function maybeStartEditorTour(tourId: string): void {
    try {
        if (localStorage.getItem(seenKey(tourId))) return;
    } catch {
        // No storage: skip rather than risk re-firing on every open.
        return;
    }
    requestAnimationFrame(() => {
        window.dispatchEvent(new CustomEvent(TOUR_EVENT, { detail: { tourId, mandatory: true } }));
    });
}

/**
 * Replay a tour on demand — for the help icon in each editor's toolbar.
 *
 * Unlike {@link maybeStartEditorTour} this ignores the "seen" flag and always fires, and opens
 * in skippable mode (Skip button + backdrop dismiss), since the user asked for it rather than
 * meeting it on a first run. Handy for iterating on tour copy without clearing localStorage.
 */
export function startEditorTour(tourId: string): void {
    requestAnimationFrame(() => {
        window.dispatchEvent(new CustomEvent(TOUR_EVENT, { detail: { tourId, mandatory: false } }));
    });
}

type Placement = 'top' | 'bottom' | 'left' | 'right' | 'center';
// 'both' shows everywhere; 'desktop' only in the Tauri app; 'web' only in the
// self-hosted web editor. Undefined is treated as 'both'.
type Surface = 'both' | 'desktop' | 'web';
interface Step {
    sel: string | null;
    /** Which part of the product this belongs to, shown above the title. */
    chapter?: string;
    title: string;
    body: string;
    placement?: Placement;
    surface?: Surface;
    /**
     * Drop this step when its element is not on screen, instead of degrading to a
     * centered card.
     *
     * The default degrade is right for a step about something that is always there and
     * merely could not be measured. It is wrong for a button the user has switched off in
     * Settings, or one that needs an open workspace: teaching a control that is not there
     * is worse than saying nothing, and on a first run it cannot be skipped past.
     */
    requireAnchor?: boolean;
}

const ALL_STEPS: Step[] = [
    {
        sel: null,
        title: 'Welcome to Duckle',
        body: 'A studio for building data pipelines on DuckDB. Draw one here and run it on this machine, or deploy the same file to a server you own. No JVM, and nothing is sent anywhere you did not choose. This walks through everything Duckle does, once. You can replay it any time from Settings.',
        placement: 'center',
    },

    // ---- Build -------------------------------------------------------------
    {
        sel: '[data-tour="palette"]',
        chapter: 'Build',
        title: 'Components and your project',
        body: 'This panel has two tabs. Components holds 380+ building blocks: databases, files, cloud and object stores, vector databases, data quality, AI, and code blocks in Python, JavaScript and SQL. Categories start collapsed, so use the search box. Project browses your pipelines, saved connections, contexts and the bundled examples.',
        placement: 'right',
    },
    {
        sel: '[data-tour="canvas"]',
        chapter: 'Build',
        title: 'The canvas',
        body: 'Drag a block on, or just start typing on the canvas to add one by name. Wire them by dragging from one node output to the next node input: source, then transform, then sink. Right-click a node for Run to here. Right-click a pipeline in the Project tab for Schedule, Backfill and Build.',
        placement: 'bottom',
    },
    {
        sel: '[data-tour="properties"]',
        chapter: 'Build',
        title: 'Properties',
        body: 'Select a node to configure it here: the connection, the query, its columns, and the write mode (overwrite, append or upsert). Use ${name} placeholders for anything that changes per environment or per run.',
        placement: 'left',
    },
    {
        sel: '[data-tour="tabs"]',
        chapter: 'Build',
        title: 'Canvas, Plan, Run, History',
        body: 'Four views of the same pipeline. Plan shows the SQL each block compiles to, which is the fastest way to understand what Duckle is actually doing. Run shows the last result with a data preview. History lists every previous run of this pipeline.',
        placement: 'bottom',
        requireAnchor: true,
    },
    {
        sel: '[data-tour="save"]',
        chapter: 'Build',
        title: 'Save, validate, tidy up',
        body: 'Save writes the pipeline to your workspace (Ctrl+S works too). Pipelines are plain JSON on disk, so they diff and version-control cleanly. Beside Save are Validate, which checks the graph without running it, auto-layout, and a menu with import and export.',
        placement: 'bottom',
    },
    {
        sel: '[data-tour="run"]',
        chapter: 'Build',
        title: 'Run it',
        body: 'Runs locally on DuckDB. If the pipeline uses ${...} values nothing has filled in, a dialog asks for them first, so the same pipeline can process one specific month on demand. While a run is going this button becomes Stop.',
        placement: 'bottom',
    },
    {
        sel: '[data-tour="live"]',
        chapter: 'Build',
        title: 'Live preview',
        body: 'Turn this on and selecting a node, or editing its settings, runs the pipeline up to that node and fills its Preview tab automatically. You see the rows without pressing Run. It stays quiet while the pipeline has errors or a run is already going.',
        placement: 'bottom',
    },
    {
        sel: '[data-tour="bottom"]',
        chapter: 'Build',
        title: 'Problems, Output and Console',
        body: 'This panel starts collapsed: click it to open. Problems lists validation errors and carries a count badge, Output is the run log, and Console is the raw engine chatter. When a run fails, this is the first place to look.',
        placement: 'top',
        requireAnchor: true,
    },
    {
        sel: '[data-tour="duckie"]',
        chapter: 'Build',
        title: 'Duckie, the built-in assistant',
        body: 'Describe what you want in plain language and Duckie drafts the pipeline for you, on this machine. Useful for a first draft or for wiring up a connector you have not used before.',
        placement: 'bottom',
        requireAnchor: true,
    },

    // ---- Operate -----------------------------------------------------------
    {
        sel: '[data-tour="home"]',
        chapter: 'Operate',
        title: 'Home is the index of everything',
        body: 'Everything Duckle can do is on this one screen, in three groups: Build, Operate and Govern. Open it any time from here. The next few steps are what lives inside it.',
        placement: 'bottom',
        requireAnchor: true,
    },
    {
        sel: '[data-tour="home"]',
        chapter: 'Operate',
        title: 'Running things on a schedule',
        body: 'Under Operate: Runs is the history of what ran and what failed. Schedules runs one pipeline on a clock, an interval, or a file landing. Plans runs several in the order they have to run, in steps, where a failed step stops the ones after it. Build and Deploy packages a pipeline into one file that runs on a server.',
        placement: 'bottom',
        requireAnchor: true,
    },
    {
        sel: '[data-tour="dashboard"]',
        chapter: 'Operate',
        title: 'The management console',
        body: 'Opens the web console this workspace is served by: every pipeline with its status, run history, schedules, plans, the data catalog, who may sign in, and an audit log. This is what duckle-runner serve hosts on a server you own.',
        placement: 'bottom',
        surface: 'desktop',
        requireAnchor: true,
    },
    {
        sel: '[data-tour="git"]',
        chapter: 'Operate',
        title: 'Version control',
        body: 'Commit, push and pull your workspace without leaving Duckle. Because a pipeline is one JSON file, a change reviews like any other code change.',
        placement: 'bottom',
        requireAnchor: true,
    },
    {
        sel: '[data-tour="context"]',
        chapter: 'Operate',
        title: 'Contexts and environments',
        body: 'A context supplies the values behind those ${...} placeholders, so one pipeline runs against dev, staging or production by switching here rather than by editing it.',
        placement: 'bottom',
        requireAnchor: true,
    },

    // ---- Govern ------------------------------------------------------------
    {
        sel: '[data-tour="lineage"]',
        chapter: 'Govern',
        title: 'Column lineage',
        body: 'Trace any output column back through every transform to the source columns it came from. Worth doing before you change a query somebody else depends on.',
        placement: 'bottom',
    },
    {
        sel: '[data-tour="trust"]',
        chapter: 'Govern',
        title: 'Trust report',
        body: 'A signed run manifest, hashes of the inputs, and schema-drift detection that flags when an upstream source changes its columns or types since the last signed run. Use it to mark a pipeline review-ready.',
        placement: 'bottom',
    },
    {
        sel: '[data-tour="dives"]',
        chapter: 'Govern',
        title: 'Dives',
        body: 'Explore results in live, auto-charting views and pin them into dashboards, all local-first. A quick way to look at what a pipeline produced without leaving Duckle.',
        placement: 'bottom',
        requireAnchor: true,
    },
    {
        sel: '[data-tour="home"]',
        chapter: 'Govern',
        title: 'Catalog and data quality',
        body: 'Also under Govern in Home: the Data Catalog is everything your workspace reads and writes, who owns it, and what is written but never read. Data Quality blocks live in the Components tab and let you assert, mask, reconcile and quarantine rows as part of the pipeline itself.',
        placement: 'bottom',
        requireAnchor: true,
    },
    {
        sel: '[data-tour="topbar"]',
        chapter: 'Govern',
        title: 'Let an AI agent drive Duckle',
        body: 'Connect Claude, Cursor or any MCP client to this workspace. The agent can list components, read and write pipelines, run them and read the logs, with the same permissions you have.',
        placement: 'bottom',
    },

    // ---- Finish ------------------------------------------------------------
    {
        sel: '[data-tour="settings"]',
        chapter: 'Finish',
        title: 'Settings, and how to get this back',
        body: 'Engine, AI, proxy, memory, language and appearance live here. Under First run you can replay this tour, and re-run the setup question about whether you work on your own machine or with a team on a server.',
        placement: 'bottom',
        requireAnchor: true,
    },
    {
        sel: null,
        chapter: 'Finish',
        title: "That is all of it",
        body: 'Open one of the bundled examples from the Project tab to see a working pipeline, or draw your own. Everything here is replayable from Settings, and nothing you just saw needs an account or a cloud.',
        placement: 'center',
    },
];

// Keep only the steps that apply to the current surface, so the step count and
// the spotlights always match what is actually on screen. The desktop-only
// dashboard button, for example, is not rendered in the web editor, so its step
// is dropped there rather than degrading to an anchorless centered card.
const onWeb = isWebBackend();
const forThisSurface: Step[] = ALL_STEPS.filter((s) => {
    const surface = s.surface ?? 'both';
    return surface === 'both' || (surface === 'desktop' && !onWeb) || (surface === 'web' && onWeb);
});

/**
 * The steps to actually walk, decided when the tour opens rather than at import.
 *
 * Surface is known at build time, but a great deal is not: the Dives button can be switched
 * off in Settings, the console button needs an open workspace, the context switcher only
 * appears once a context exists. Those are decided by the state of the app at the moment
 * somebody opens the tour, so the list is built then.
 *
 * A step marked `requireAnchor` whose element is absent is dropped. Everything else keeps
 * the old forgiving behaviour: a missing anchor degrades to a centered card rather than
 * breaking the tour.
 */
function stepsOnScreen(base: Step[]): Step[] {
    return base.filter((s) => {
        if (!s.requireAnchor || !s.sel) return true;
        const el = document.querySelector(s.sel) as HTMLElement | null;
        if (!el) return false;
        // Present in the DOM but not shown: a display:none ancestor gives a zero box, and
        // spotlighting it would dim the screen around nothing.
        const r = el.getBoundingClientRect();
        return r.width > 0 || r.height > 0;
    });
}

// ---- Per-editor first-run tours -------------------------------------------
// Each custom node editor gets its own short walkthrough, keyed to `data-tour`
// markers that live only inside that editor. Steps carry requireAnchor so that
// if an anchor is not on screen (e.g. an Infor editor opened before sign-in, a
// collapsed panel on replay) the step is dropped rather than floating a card
// over nothing. All five editors share one always-mounted GuidedTour instance;
// only the active surface's anchors are measurable, so the markers are
// namespaced per editor to avoid resolving to a hidden sibling.

const SQL_STUDIO_STEPS: Step[] = [
    {
        sel: null,
        chapter: 'SQL Studio',
        title: 'Write the query for this node',
        body: 'SQL Studio is a read-only DuckDB workbench for one code node. Draft and preview SQL here against the tables wired into the node, then push it back to the pipeline.',
        placement: 'center',
    },
    {
        sel: '[data-tour="sqlstudio-catalog"]',
        chapter: 'SQL Studio',
        title: 'Upstream tables',
        body: 'Every table wired into this node shows here with its columns. Reference them by name in your query. Collapse the panel with the arrow when you need more room.',
        placement: 'right',
        requireAnchor: true,
    },
    {
        sel: '[data-tour="sqlstudio-editor"]',
        chapter: 'SQL Studio',
        title: 'The editor',
        body: 'Type your SELECT here and use Format to tidy it. Runs are read-only — you are previewing rows, never mutating the working database.',
        placement: 'top',
        requireAnchor: true,
    },
    {
        sel: '[data-tour="sqlstudio-askai"]',
        chapter: 'SQL Studio',
        title: 'Ask AI',
        body: 'Describe what you want in plain language and the assistant drafts SQL in a split view, aware of the upstream tables. Review its draft before you keep it.',
        placement: 'bottom',
        requireAnchor: true,
    },
    {
        sel: '[data-tour="sqlstudio-apply"]',
        chapter: 'SQL Studio',
        title: 'Apply to node',
        body: 'When the query is right, Apply to node writes it back to the pipeline node. Nothing leaves the studio until you do.',
        placement: 'bottom',
        requireAnchor: true,
    },
];

const REGEX_STEPS: Step[] = [
    {
        sel: null,
        chapter: 'Regex Studio',
        title: 'Build a regex against real data',
        body: 'Regex Studio uses RE2 — the same engine DuckDB runs — so a pattern that validates here works in the pipeline. Match, extract or replace on a column, tested against live values.',
        placement: 'center',
    },
    {
        sel: '[data-tour="regex-pattern"]',
        chapter: 'Regex Studio',
        title: 'Column, pattern and description',
        body: 'Make sure a column is selected, then either type your RE2 pattern or leave it blank if you want the AI to draft one. The title and short description feed the AI extra context — and are what you fill in when you plan to save the pattern to the library.',
        placement: 'bottom',
        requireAnchor: true,
    },
    {
        sel: '[data-tour="regex-column"]',
        chapter: 'Regex Studio',
        title: 'Find records to test',
        body: 'These are real values from the column. Use the search to narrow them, then pin the records you want to try your pattern against — pinned records jump into the test area on the right.',
        placement: 'top',
        requireAnchor: true,
    },
    {
        sel: '[data-tour="regex-expected"]',
        chapter: 'Regex Studio',
        title: 'Set expected outcomes',
        body: 'Each pinned record has an expected-outcome field. Fill it in and Regex Studio checks your pattern against it live (✓ meets / ✗ differs) — and sends it to the AI as extra context, so its suggestions aim at what you actually want.',
        placement: 'top',
        requireAnchor: true,
    },
    {
        sel: '[data-tour="regex-chat"]',
        chapter: 'Regex Studio',
        title: 'Let the AI help',
        body: 'The AI chat sees your column samples, the current pattern, and every pinned test with its expected outcome. Describe what you want in the box below and it proposes a pattern with a “Use this pattern” button to apply it. Once you’ve set expected outcomes, a one-click “Draft to pass my tests” button also appears above the input — it drafts a pattern and auto-verifies it against them.',
        placement: 'left',
        requireAnchor: true,
    },
    {
        sel: '[data-tour="regex-library"]',
        chapter: 'Regex Studio',
        title: 'Pattern library',
        body: 'Save a working pattern to this workspace or globally, and reuse it later. Import and export the library as JSON to share it.',
        placement: 'right',
        requireAnchor: true,
    },
    {
        sel: '[data-tour="regex-apply"]',
        chapter: 'Regex Studio',
        title: 'Apply to node',
        body: 'Apply to node writes the validated pattern back to the pipeline node. It stays disabled until the pattern is valid and a column is chosen.',
        placement: 'bottom',
        requireAnchor: true,
    },
];

const INFOR_SRC_STEPS: Step[] = [
    {
        sel: null,
        chapter: 'Infor source',
        title: 'Build an Infor query',
        body: 'This is the API Playground for an Infor source node: sign in, pick a business class, choose fields and a filter, preview the rows, then apply the query to the node.',
        placement: 'center',
    },
    {
        sel: '[data-tour="infor-src-connect"]',
        chapter: 'Infor source',
        title: 'Connect first',
        body: 'Sign in with a saved connection or new credentials here. The query builder below only appears once you are signed in.',
        placement: 'right',
        requireAnchor: true,
    },
    {
        sel: '[data-tour="infor-src-class"]',
        chapter: 'Infor source',
        title: 'Business class',
        body: 'Search the data area for the business class to read from. The list is cached after the first download; Refresh re-pulls it.',
        placement: 'right',
        requireAnchor: true,
    },
    {
        sel: '[data-tour="infor-src-fields"]',
        chapter: 'Infor source',
        title: 'Fields and filter',
        body: 'Tick the fields you want (they map to _fields) and build a filter below (it compiles to _lplFilter, shown as a preview). Leaving fields unticked returns nothing, so pick at least one.',
        placement: 'right',
        requireAnchor: true,
    },
    {
        sel: '[data-tour="infor-src-run"]',
        chapter: 'Infor source',
        title: 'Run, then apply',
        body: 'Run query previews rows on the right against a limit. When the query is right, Apply to node writes the class, fields and filter back to the pipeline node.',
        placement: 'top',
        requireAnchor: true,
    },
];

const INFOR_SINK_STEPS: Step[] = [
    {
        sel: null,
        chapter: 'Infor sink',
        title: 'Upload rows to Infor',
        body: 'This configures an Infor upload node: sign in, choose the target business class and action, map your dataset columns to its fields, then apply the setup to the node.',
        placement: 'center',
    },
    {
        sel: '[data-tour="infor-sink-connect"]',
        chapter: 'Infor sink',
        title: 'Connect first',
        body: 'Sign in here. The upload target and field map appear only once you are signed in.',
        placement: 'right',
        requireAnchor: true,
    },
    {
        sel: '[data-tour="infor-sink-class"]',
        chapter: 'Infor sink',
        title: 'Target business class',
        body: 'Pick the data area and the business class you are writing into. This drives the set of actions and fields below.',
        placement: 'right',
        requireAnchor: true,
    },
    {
        sel: '[data-tour="infor-sink-action"]',
        chapter: 'Infor sink',
        title: 'Action',
        body: 'Choose the action to run for each record — typically a create or update. The field map is built from the action you select.',
        placement: 'right',
        requireAnchor: true,
    },
    {
        sel: '[data-tour="infor-sink-map"]',
        chapter: 'Infor sink',
        title: 'Map fields, then apply',
        body: 'Match each Infor field to a dataset column (Auto-map does the obvious ones). Apply to node then saves the class, action and mapping back to the pipeline node.',
        placement: 'right',
        requireAnchor: true,
    },
];

const ERD_STEPS: Step[] = [
    {
        sel: null,
        chapter: 'ER Model',
        title: 'Model the working database',
        body: 'This editor captures the relationships between the tables in a Working DB node — the foreign keys that queries and lineage rely on. Draw them, or let Duckle infer them.',
        placement: 'center',
    },
    {
        sel: '[data-tour="erd-diagram"]',
        chapter: 'ER Model',
        title: 'The diagram',
        body: 'Every upstream table is shown here. Drag between columns to draw a relationship, or click a link to select its pair. This canvas and the side panel are two views of the same model.',
        placement: 'top',
        requireAnchor: true,
    },
    {
        sel: '[data-tour="erd-infer"]',
        chapter: 'ER Model',
        title: 'Auto-infer',
        body: 'Auto-infer all guesses relationships from matching column names and types. A fast starting point you can then correct by hand.',
        placement: 'bottom',
        requireAnchor: true,
    },
    {
        sel: '[data-tour="erd-side"]',
        chapter: 'ER Model',
        title: 'Add and review',
        body: 'Add a relationship by hand here and review the full list, grouped by table pair. Filter it when there are many.',
        placement: 'left',
        requireAnchor: true,
    },
    {
        sel: '[data-tour="erd-save"]',
        chapter: 'ER Model',
        title: 'Save to node',
        body: 'Save to node persists the model back to the Working DB node. From there the relationships are passed downstream as context to nodes that can use them — the SQL Studio node, for instance, sees these joins when you write a query or ask its AI for one.',
        placement: 'bottom',
        requireAnchor: true,
    },
];

/** Editor tours by id. The main first-run tour is `forThisSurface`; these are keyed by editor. */
const EDITOR_TOURS: Record<string, Step[]> = {
    sql: SQL_STUDIO_STEPS,
    regex: REGEX_STEPS,
    'infor-src': INFOR_SRC_STEPS,
    'infor-sink': INFOR_SINK_STEPS,
    erd: ERD_STEPS,
};

function stepsForTour(tourId: string): Step[] {
    return tourId === 'main' ? forThisSurface : (EDITOR_TOURS[tourId] ?? []);
}

interface Box {
    top: number;
    left: number;
    width: number;
    height: number;
}

type TourProps = {
    /**
     * Whether the app is past its startup screens and the workspace is really usable.
     *
     * The tour used to work this out by looking for known overlay classes, and that was
     * wrong twice: first the Home launcher, then the account dialog, each a class it had
     * never heard of, each ending with a tour spotlighting things behind a screen somebody
     * was still filling in. App is the only thing that knows which gates are open, so it
     * says so, and the guesswork is gone.
     */
    ready?: boolean;
};

export function GuidedTour({ ready = true }: TourProps) {
    const [active, setActive] = useState(false);
    // Whether this is the first run rather than a replay.
    //
    // On a first run the tour has to be walked: it is the only moment we know somebody is
    // looking, and a product with this much in it is not discoverable by clicking around.
    // Replaying it from Settings is a different situation - they already know what it is and
    // asked for it - so there the Skip button comes back and the dimmed backdrop closes it.
    const [mandatory, setMandatory] = useState(false);
    const [i, setI] = useState(0);
    const [box, setBox] = useState<Box | null>(null);
    const [steps, setSteps] = useState<Step[]>(forThisSurface);
    // Which tour is showing: 'main' for the first-run walkthrough, or an editor id
    // ('sql', 'regex', 'infor-src', 'infor-sink', 'erd'). Decides which "seen" key
    // close() writes and whether Home is handed the screen afterwards.
    const [tourId, setTourId] = useState('main');
    // A live mirror of `active` for the start listener, which is registered once and
    // would otherwise close over a stale value; used to ignore a second tour arriving
    // while one is already open.
    const activeRef = useRef(false);

    // Open on first run, once the app says its startup screens are done AND the workspace
    // UI is really mounted (poll for the canvas anchor).
    //
    // `ready` is the important half. Anything still owning the screen - engine setup, the
    // account dialog, the workspace picker, the local-or-server question, Home - keeps it
    // false, and none of them have to be recognised by class here. The canvas poll stays
    // because "App thinks it is ready" and "the canvas has actually painted" are different
    // moments, and the spotlight needs the second one.
    useEffect(() => {
        if (!ready) return;
        if (localStorage.getItem(SEEN_KEY)) return;
        let tries = 0;
        const iv = setInterval(() => {
            // Any other modal opened by hand still defers, and does not burn the timeout.
            if (document.querySelector('.modal-backdrop')) return;
            tries += 1;
            if (document.querySelector('[data-tour="canvas"]')) {
                clearInterval(iv);
                setTourId('main');
                setSteps(stepsOnScreen(forThisSurface));
                setMandatory(true);
                setActive(true);
            } else if (tries > 40) {
                clearInterval(iv);
            }
        }, 600);
        return () => clearInterval(iv);
    }, [ready]);
    useEffect(() => {
        activeRef.current = active;
    }, [active]);
    useEffect(() => {
        const start = (e: Event) => {
            // Don't stack a second tour on top of one that is already open.
            if (activeRef.current) return;
            const detail = (e as CustomEvent).detail as
                | { tourId?: string; mandatory?: boolean }
                | undefined;
            // No detail is the historical replay path (Settings) → the main tour, skippable.
            const id = detail?.tourId ?? 'main';
            const isMandatory = detail?.mandatory ?? false;
            const base = stepsForTour(id);
            const on = stepsOnScreen(base);
            if (on.length === 0) return;
            // On the automatic first-run launch, an editor tour whose anchored steps are all
            // off screen (e.g. an Infor editor opened before sign-in, when only the intro
            // card would survive) is deferred: we return without opening, so close() never
            // marks it seen and it still gets its first real showing on a later open. A
            // manual replay from the help icon is exempt — the user asked for it, it does not
            // touch the seen flag, so we always show whatever is there.
            if (
                isMandatory &&
                id !== 'main' &&
                base.some((s) => s.requireAnchor) &&
                !on.some((s) => s.requireAnchor)
            ) {
                return;
            }
            setTourId(id);
            setI(0);
            setSteps(on);
            setMandatory(isMandatory);
            setActive(true);
        };
        window.addEventListener(TOUR_EVENT, start);
        return () => window.removeEventListener(TOUR_EVENT, start);
    }, []);

    const measure = useCallback(() => {
        const step = steps[i];
        if (!step?.sel) {
            setBox(null);
            return;
        }
        const el = document.querySelector(step.sel) as HTMLElement | null;
        if (!el) {
            setBox(null);
            return;
        }
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) {
            setBox(null);
            return;
        }
        setBox({ top: r.top, left: r.left, width: r.width, height: r.height });
    }, [i]);

    useLayoutEffect(() => {
        if (!active) return;
        measure();
        window.addEventListener('resize', measure);
        window.addEventListener('scroll', measure, true);
        return () => {
            window.removeEventListener('resize', measure);
            window.removeEventListener('scroll', measure, true);
        };
    }, [active, measure]);

    if (!active) return null;

    const step = steps[i];
    const last = i === steps.length - 1;
    const close = () => {
        try {
            localStorage.setItem(seenKey(tourId), '1');
        } catch {
            // Storage off: it will re-fire next time, which is better than throwing here.
        }
        setActive(false);
        // Home held back for the main first-run tour. Telling it we are done is what lets a
        // first run be tour-then-Home rather than the two arriving together. Editor tours
        // open from an already-running workspace, so they must not trigger the Home handoff.
        if (tourId === 'main') {
            window.dispatchEvent(new Event(TOUR_FINISHED_EVENT));
        }
    };
    const next = () => (last ? close() : setI((n) => n + 1));
    const back = () => setI((n) => Math.max(0, n - 1));

    // Tooltip position: anchored beside the spotlight, then ALWAYS clamped into
    // the viewport so the card (and its Skip/Back/Next buttons) is reachable even
    // when the target fills the screen (e.g. the canvas). Very large targets get
    // a centered card since "beside" has no room.
    const PAD = 10;
    const TIP_W = 340;
    const TIP_H = 280; // generous estimate used only for clamping
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    let tipStyle: React.CSSProperties;
    const big = !!box && box.height > vh * 0.7 && box.width > vw * 0.45;
    if (!box || big) {
        tipStyle = { top: '50%', left: '50%', transform: 'translate(-50%,-50%)' };
    } else {
        const place = step.placement ?? 'bottom';
        let top: number;
        let left: number;
        if (place === 'right' && box.left + box.width + TIP_W + 24 < vw) {
            left = box.left + box.width + PAD;
            top = box.top;
        } else if (place === 'left' && box.left - TIP_W - 24 > 0) {
            left = box.left - TIP_W - PAD;
            top = box.top;
        } else if (place === 'top' && box.top - TIP_H - PAD > 0) {
            top = box.top - TIP_H - PAD;
            left = box.left;
        } else {
            // bottom (default); if it would overflow, flip above the target
            top = box.top + box.height + PAD;
            left = box.left;
            if (top + TIP_H + 12 > vh && box.top - TIP_H - PAD > 0) {
                top = box.top - TIP_H - PAD;
            }
        }
        // Final guard: keep the whole card on screen.
        top = Math.max(12, Math.min(top, vh - TIP_H - 12));
        left = Math.max(12, Math.min(left, vw - TIP_W - 12));
        tipStyle = { top, left };
    }

    return (
        <div className="tour-root" role="dialog" aria-modal="true" aria-label="Duckle guided tour">
            {/* Spotlight: a transparent box with a huge shadow dims everything else. */}
            {box ? (
                <div
                    className="tour-spotlight"
                    style={{
                        top: box.top - PAD,
                        left: box.left - PAD,
                        width: box.width + PAD * 2,
                        height: box.height + PAD * 2,
                    }}
                />
            ) : (
                // A click outside closes a replay, but not the first run: there is no Skip
                // there, and a stray click on the dimmed area must not become one.
                <div className="tour-dim" onClick={mandatory ? undefined : close} />
            )}
            <div className="tour-tip" style={{ ...tipStyle, width: TIP_W }}>
                <div className="tour-progress">
                    {step.chapter ? <span className="tour-chapter">{step.chapter}</span> : null}
                    Step {i + 1} of {steps.length}
                </div>
                <h3 className="tour-title">{step.title}</h3>
                <p className="tour-body">{step.body}</p>
                <div className="tour-dots">
                    {steps.map((_, n) => (
                        <span key={n} className={n === i ? 'tour-dot on' : 'tour-dot'} />
                    ))}
                </div>
                <div className="tour-actions">
                    {mandatory ? (
                        // Says how much is left, so walking it feels finite rather than
                        // open-ended. It replaces Skip rather than sitting beside it, which
                        // keeps the row's layout identical either way.
                        <span className="tour-remaining">
                            {last ? 'Last one' : `${steps.length - i - 1} to go`}
                        </span>
                    ) : (
                        <button type="button" className="tour-skip" onClick={close}>
                            Skip tour
                        </button>
                    )}
                    <div className="tour-nav">
                        {i > 0 ? (
                            <button type="button" className="tour-btn" onClick={back}>
                                Back
                            </button>
                        ) : null}
                        <button type="button" className="tour-btn primary" onClick={next}>
                            {last ? 'Get started' : 'Next'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
