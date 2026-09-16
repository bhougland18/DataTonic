// The Vega-Lite spec the Charts step edits, held as DATA rather than as text.
//
// Same move `builder-sql.ts` made for SQL and `chart-shapes.ts` made for the
// contracts: the thing on screen is derived from a small record, so every
// control is a field edit and the result is checkable without a browser.
//
// Two rules the whole module exists to keep:
//
// **Refinement, not construction** (`chart-shape-guidance.md` §7). `checkShape`
// already decided which column goes to which channel — that is what matching a
// variant means — so this starts from `proposeEncoding` and adds only the things
// a person adjusts afterwards: titles, sort, scales, colour, legend, formatting.
// Column-to-channel mapping is NOT written a second time here.
//
// **Shaping happens in SQL** (plan §9). No `fold`, no `aggregate`, no
// `timeUnit`. `bin` — and the `count` it implies — is the one deliberate
// exception, because binning in SQL to draw a histogram throws the raw column
// away.
//
// `readSpec` is the other half and the reason the state is worth having: a spec
// edited by hand or by the AI pane comes BACK into the controls when the GUI can
// model it, and says so honestly when it cannot. A generated artefact that stops
// being editable is a mode, and `query-builder.md` §9 already rejected that for
// SQL.

import type { DiveChart } from '../dives/dive-types';
import {
    proposeEncoding,
    type Channel,
    type ChannelNeed,
    type ChartType,
    type Encoding,
    type Field,
    type Verdict,
    type VlType,
} from './chart-shapes';

/** Pinned to the vega-lite this build bundles, so a hand-edited spec validates. */
export const VL_SCHEMA = 'https://vega.github.io/schema/vega-lite/v6.json';

/**
 * How a discrete axis is ordered.
 *
 * `byValue*` sorts the categories by the OPPOSITE positional measure, which is
 * what "biggest bar first" means and the single most-wanted refinement on a bar
 * chart. Vega-Lite spells it as a channel reference (`sort: '-y'`), so it only
 * applies to `x`/`y`.
 *
 * `queryOrder` exists because of a trap found by rendering, not by reading:
 * Vega-Lite's DEFAULT for a nominal axis is alphabetical, so an `ORDER BY
 * count DESC` in the SQL is silently thrown away by the chart. `sort: null`
 * keeps the order the rows arrived in, and nothing else does.
 */
export type SortOrder =
    | 'queryOrder'
    | 'ascending'
    | 'descending'
    | 'byValueAscending'
    | 'byValueDescending';

export type ScaleType = 'linear' | 'log' | 'sqrt';

/** How a coloured bar or area divides the measure. */
export type StackMode = 'zero' | 'normalize' | 'none';

export const SORT_ORDERS: SortOrder[] = [
    'queryOrder',
    'ascending',
    'descending',
    'byValueAscending',
    'byValueDescending',
];
export const SCALE_TYPES: ScaleType[] = ['linear', 'log', 'sqrt'];
export const STACK_MODES: StackMode[] = ['zero', 'normalize', 'none'];

/**
 * One encoding channel, plus the refinements a person makes to it.
 *
 * Every field beyond `field`/`type` is OPTIONAL and omitted from the built spec
 * when unset, so an untouched chart produces the same three-line spec the
 * matcher proposed. A spec full of explicit defaults is one nobody can read, and
 * reading it by hand is a stated requirement.
 */
export interface ChannelSpec {
    /** Absent only on a `count` channel, which has no column behind it. */
    field?: string;
    type: VlType;
    /**
     * The histogram's binned count (`aggregate: 'count'`).
     *
     * The one aggregate this module emits, and only as the other half of `bin`
     * — see the module header. Not offered anywhere else.
     */
    count?: boolean;
    /** `null` hides the title; `undefined` keeps Vega-Lite's default (the field name). */
    title?: string | null;
    sort?: SortOrder;
    scaleType?: ScaleType;
    /** `false` lets the axis start away from zero. Vega-Lite defaults to true for bars. */
    zero?: boolean;
    /** A d3 format string for the axis or legend labels — `,.0f`, `%b %Y`. */
    format?: string;
    /** Bin a raw quantitative column. Histogram only (plan §9). */
    bin?: boolean;
    /** `false` hides this channel's legend. */
    legend?: boolean;
}

/** The whole editable document: what the chart is, and how it is dressed. */
export interface ChartSpecState {
    chart: ChartType;
    encoding: Partial<Record<Channel, ChannelSpec>>;
    title?: string;
    subtitle?: string;
    /** bar/area with a colour channel. Unset means Vega-Lite's default (`zero`). */
    stack?: StackMode;
    /** A named Vega scheme for the colour channel. Unset keeps the brand range
     *  `VegaChart` supplies, which is why there is no default here. */
    scheme?: string;
    /** line/area: draw a marker at each data point. */
    points?: boolean;
}

// ---------------------------------------------------------------------------
// State -> spec
// ---------------------------------------------------------------------------

/** Which channels carry an axis, so a format string goes to `axis`, not `legend`. */
const POSITIONAL = new Set<Channel>(['x', 'y']);

/**
 * Characters Vega-Lite reads as STRUCTURE inside a field reference.
 *
 * `.` is nested property access and `[` / `]` are array indexing, so the field
 * `count Item.Item` sends Vega-Lite looking for `row['count Item']['Item']`.
 * It finds nothing, reports an infinite extent, and draws an EMPTY chart with
 * correct-looking axes — no error anywhere.
 *
 * This is not a corner case here: the query builder names every aggregate
 * `<agg> <table>.<column>`, so almost every built query with a count in it hits
 * it. Found by running the real thing; `compile()` only warns, and the warning
 * names a field nobody asked for (`count Item.Item_start`).
 */
const FIELD_SPECIALS = /[.[\]]/g;

/**
 * A column name as a Vega-Lite field REFERENCE.
 *
 * The state always holds the real column name — that is what `missingFields`
 * compares against the result and what the AI pane is told — so escaping
 * happens on the way out and `unescapeField` undoes it on the way in.
 */
export const escapeField = (name: string): string => name.replace(FIELD_SPECIALS, '\\$&');

/** The column name behind a Vega-Lite field reference. */
export const unescapeField = (name: string): string => name.replace(/\\([.[\]])/g, '$1');

/**
 * Which channel carries the MEASURE, and so the stacking.
 *
 * `bar` and `area` stack up the y axis; `barh` is the transpose and stacks
 * along x. `stack` is a property of the measure's channel in Vega-Lite, so
 * putting it on `y` unconditionally silently did nothing for horizontal bars.
 */
const stackChannel = (chart: ChartType): Channel | null => {
    if (chart === 'bar' || chart === 'area') return 'y';
    if (chart === 'barh') return 'x';
    return null;
};

function markFor(state: ChartSpecState): string | Record<string, unknown> {
    switch (state.chart) {
        // A histogram IS a bar chart whose x is binned, and a horizontal bar
        // chart IS a bar chart with the types swapped between the axes. All
        // three are `mark: 'bar'`; the ENCODING is what tells them apart, which
        // is why `readSpec` has to look there rather than at the mark.
        case 'histogram':
        case 'barh':
            return 'bar';
        case 'point':
            return { type: 'point', filled: true };
        case 'line':
            return state.points ? { type: 'line', point: true } : 'line';
        case 'area':
            return state.points ? { type: 'area', point: true } : 'area';
        default:
            return state.chart;
    }
}

/** Vega-Lite's spelling of a sort order on a positional channel. */
function sortFor(channel: Channel, order: SortOrder): unknown {
    // `null` is the only way to say "leave the rows in the order they came in".
    if (order === 'queryOrder') return null;
    if (order === 'ascending' || order === 'descending') return order;
    // "Sort the categories by the measure on the other axis." Expressed as a
    // channel reference rather than as a field, so it keeps working when the
    // measure is remapped to a different column.
    const other = channel === 'x' ? 'y' : 'x';
    return order === 'byValueAscending' ? other : `-${other}`;
}

function channelDef(
    channel: Channel,
    c: ChannelSpec,
    state: ChartSpecState,
): Record<string, unknown> {
    const def: Record<string, unknown> = {};
    if (c.count) def.aggregate = 'count';
    else if (c.field) def.field = escapeField(c.field);
    def.type = c.type;
    if (c.bin) def.bin = true;

    if (c.title === null) def.title = null;
    else if (c.title != null && c.title.trim()) def.title = c.title.trim();

    if (c.sort && POSITIONAL.has(channel)) def.sort = sortFor(channel, c.sort);

    const scale: Record<string, unknown> = {};
    if (c.scaleType && c.scaleType !== 'linear') scale.type = c.scaleType;
    // `zero` is meaningless on a log scale — a log axis cannot include zero —
    // and Vega-Lite warns and drops it. Caught by compiling the spec rather
    // than by reading the docs, which is why that test exists: the two settings
    // are independently reasonable and only conflict together.
    if (c.zero === false && c.scaleType !== 'log') scale.zero = false;
    if (channel === 'color' && state.scheme) scale.scheme = state.scheme;
    if (Object.keys(scale).length > 0) def.scale = scale;

    if (c.legend === false) def.legend = null;
    else if (c.format && !POSITIONAL.has(channel)) def.legend = { format: c.format };

    if (c.format && POSITIONAL.has(channel)) def.axis = { format: c.format };

    // Stacking is a property of the MEASURE's channel, not of the mark. Emitted
    // only when it differs from Vega-Lite's default, so an untouched chart stays
    // a spec somebody can read.
    if (state.stack && state.stack !== 'zero' && channel === stackChannel(state.chart)) {
        def.stack = state.stack;
    }

    return def;
}

// ---------------------------------------------------------------------------
// The bullet graph
// ---------------------------------------------------------------------------
//
// Stephen Few's design, and the first chart here that is not ONE MARK WITH
// CHANNELS — it is a stack of layers, so it gets its own builder and its own
// reader rather than being forced through `channelDef`.
//
// **Layered, NOT faceted**, which is where this departs from the Vega-Lite
// example (`examples/facet_bullet`). That example facets by title and resolves
// the x scale INDEPENDENTLY, because it is a dashboard: revenue in $thousands
// and satisfaction out of five have no common axis. A block's bullet graph
// comes from ONE query, so every row measures the same thing, and a shared
// scale is not a simplification — it is the whole point. Comparing vendors
// against their targets on separate axes would be a chart that invites a
// comparison it then refuses to support.
//
// It also keeps `VegaChart` working. Vega-Lite will not take a top-level
// `width`/`height` or `autosize: fit` on a faceted spec, and `VegaChart`
// injects all three — a faceted bullet would have warned and drawn at 200px.
// A LAYER spec takes them exactly as a single view does.

/**
 * The qualitative ranges, palest on the outside.
 *
 * Few is specific and worth following: shades of ONE hue, never the red/amber/
 * green that everyone reaches for. Three greys carry "worse to better" without
 * claiming a verdict, and they survive colour-blindness and a black-and-white
 * printer, which traffic lights do not.
 *
 * Slate rather than neutral grey, so they sit in the brand range. The LIGHTNESS
 * is a compromise picked by rendering all three candidates on both themes and
 * looking: `VegaChart` themes the config, not the marks, so one set of values
 * has to serve both. Few's near-whites are right on the light theme and turn
 * into the brightest thing on the dark one, where they out-shout the measure
 * they are supposed to sit behind; a darker slate is right on dark and goes
 * heavy enough on light to compete with the measure instead. This ramp is the
 * middle, and it is legible either way.
 */
const RANGE_FILL = ['#8b95a8', '#adb5c2', '#ccd2dc'];

/** The featured measure: the most salient thing on the graph. */
const MEASURE_FILL = '#2eafff';

/** The comparative measure. Few asks for strong contrast against the measure. */
const TARGET_STROKE = '#ff7a45';

/** Thin, so the ranges read as a backdrop and not as bars in their own right. */
const MEASURE_SIZE = 9;

/** range1 → range3, ascending thresholds. Index matches `RANGE_FILL`. */
const RANGE_CHANNELS: Channel[] = ['range1', 'range2', 'range3'];

/**
 * One layer's x, carrying the axis label EVERY layer has to agree on.
 *
 * Vega-Lite merges the layers' x axes into one, and the merge is not "first
 * wins" — distinct titles are JOINED, so an untouched stack labels its axis
 * `good, fair, poor, actual, target`. Muting the other four with `title: null`
 * fixes that and then breaks the Label control instead: the nulls beat the
 * measure's title and the axis comes out with no name at all, whatever anyone
 * types. Found by compiling and reading `vg.spec.axes`, not by looking at the
 * JSON, which is right either way.
 *
 * So the title is decided ONCE, from the featured measure, and written
 * identically to every layer. Identical titles merge to themselves.
 */
function bulletX(field: string, title: string | null, format?: string): Record<string, unknown> {
    const def: Record<string, unknown> = {
        field: escapeField(field),
        type: 'quantitative',
        title,
    };
    if (format) def.axis = { format };
    return def;
}

/** What the shared x axis is called: the measure's label, or its column name. */
function bulletAxisTitle(measure?: ChannelSpec): string | null {
    if (!measure) return null;
    if (measure.title === null) return null;
    const t = measure.title?.trim();
    return t || measure.field || null;
}

/**
 * The gap between one bullet and the next.
 *
 * Not decoration. Vega-Lite gives a band scale almost no padding by default, so
 * the RANGE bars — which fill their whole band — touch the rows above and below
 * and four bullets read as one striped block. The target ticks are band-height
 * too, so with the bands flush they join into a single rule straight down the
 * chart and stop looking like a per-row marker at all.
 *
 * Found by rendering the thing and looking at it. Every test passed.
 */
const BULLET_PADDING = 0.34;

/** The shared row label. Hoisted to the top level, so every layer inherits it. */
function bulletLabel(c: ChannelSpec): Record<string, unknown> {
    const def: Record<string, unknown> = {
        field: escapeField(c.field as string),
        type: c.type,
        scale: { paddingInner: BULLET_PADDING, paddingOuter: BULLET_PADDING / 2 },
    };
    // `null` — not alphabetical. A bullet graph is read as a LIST, and the
    // order a list is in is a decision somebody made in the SQL. This is the
    // same trap `SortOrder.queryOrder` documents, and it is the default here
    // rather than an option because there is no second axis to rank by.
    def.sort = c.sort === 'ascending' || c.sort === 'descending' ? c.sort : null;
    // The rows are labelled; an axis title above them repeats the column name
    // for no one.
    if (c.title === null || c.title === undefined) def.title = null;
    else if (c.title.trim()) def.title = c.title.trim();
    return def;
}

function bulletSpec(state: ChartSpecState): DiveChart {
    const enc = state.encoding;
    const layers: Record<string, unknown>[] = [];
    const m = enc.measure;
    const axisTitle = bulletAxisTitle(m);
    const format = m?.format;

    // LARGEST first: the bars all start at zero and overlap, so the smallest
    // range has to be painted last to stay visible.
    for (let i = RANGE_CHANNELS.length - 1; i >= 0; i -= 1) {
        const c = enc[RANGE_CHANNELS[i]];
        if (!c?.field) continue;
        layers.push({
            mark: { type: 'bar', color: RANGE_FILL[i] },
            encoding: { x: bulletX(c.field, axisTitle, format) },
        });
    }
    if (m?.field) {
        layers.push({
            mark: { type: 'bar', color: MEASURE_FILL, size: MEASURE_SIZE },
            encoding: { x: bulletX(m.field, axisTitle, format) },
        });
    }
    const t = enc.target;
    if (t?.field) {
        // A TICK, not a bar: the comparative measure is a position on the
        // scale, and a bar from zero would read as a second quantity.
        layers.push({
            mark: { type: 'tick', color: TARGET_STROKE, thickness: 2 },
            encoding: { x: bulletX(t.field, axisTitle, format) },
        });
    }

    const spec: Record<string, unknown> = { $schema: VL_SCHEMA };
    const title = state.title?.trim();
    const subtitle = state.subtitle?.trim();
    if (title) spec.title = subtitle ? { text: title, subtitle } : title;
    if (enc.label?.field) spec.encoding = { y: bulletLabel(enc.label) };
    spec.layer = layers;
    return spec;
}

// ---------------------------------------------------------------------------
// The sparkline table
// ---------------------------------------------------------------------------
//
// Tufte's sparkline in Few's table layout, and the first FACETED spec here.
//
// Faceted where the bullet graph is layered, and for the opposite reason. A
// bullet graph's rows measure one thing and must share a scale; a sparkline
// table is read as a LIST of shapes, one line per category, where the question
// is "which of these is rising" and not "which is biggest". Faceting is what
// gives each row its own panel.
//
// `VegaChart` had to learn this shape before it could be drawn: Vega-Lite
// refuses a top-level `width: 'container'` on a facet, so the renderer now
// measures the chrome and sets the inner `child_width` itself (see
// `fitComposed`). That is why this writes no width — the same invariant every
// other chart here keeps.

/**
 * Height of ONE sparkline row, and the one size a spec here carries.
 *
 * A deliberate exception, on the same footing as the gallery thumbnails. Tufte's
 * point is that a sparkline is word-sized: the row height is not a rendering
 * choice that a bigger panel should stretch, it is what makes a column of them
 * scannable. Three categories in a tall panel should be three thin lines with
 * space under them, not three fat bands.
 *
 * Width is NOT here, and that is the split: the width is genuinely a property
 * of the surface, so `VegaChart` supplies it.
 */
const SPARK_HEIGHT = 22;

/** Gap between rows. Enough to separate, too little to read as separate charts. */
const SPARK_SPACING = 4;

const SPARK_STROKE = '#2eafff';

function sparklineSpec(state: ChartSpecState): DiveChart {
    const enc = state.encoding;
    const label = enc.label;
    const x = enc.x;
    const y = enc.y;

    const row: Record<string, unknown> = {
        field: escapeField(label?.field ?? ''),
        type: label?.type ?? 'nominal',
        header: {
            // Left-aligned and upright: these are row LABELS in a table, and a
            // rotated label is the thing that stops a table being scannable.
            labelAngle: 0,
            labelAlign: 'left',
            title: label?.title === null || label?.title === undefined ? null : label.title.trim(),
        },
        // ALPHABETICAL by default, and this is the one chart here that cannot
        // offer query order.
        //
        // `sort: null` — which is how every other chart says "leave the rows
        // alone" — is SILENTLY IGNORED on a facet row. Rendered and checked: a
        // facet with `sort: null` and a facet with no `sort` at all produce the
        // identical alphabetical order. The only thing Vega-Lite accepts for an
        // arbitrary order is an explicit ARRAY of the values, and baking the
        // categories into the spec would tie it to one result — the same
        // failure the custom-template contract exists to avoid.
        //
        // So it is written out rather than left implicit, because an ordering
        // nobody chose should at least be visible in the JSON.
        sort: label?.sort === 'descending' ? 'descending' : 'ascending',
    };

    const inner: Record<string, unknown> = {
        height: SPARK_HEIGHT,
        view: { stroke: null },
        // A LINE, not the filled area the Vega-Lite example uses. An area
        // declares a zero baseline, and a sparkline's y axis is deliberately not
        // zero-based — the whole point is the SHAPE of the variation, which
        // zero-anchoring flattens away. Filling it would draw a quantity claim
        // the chart then refuses to label.
        mark: { type: 'line', color: SPARK_STROKE, strokeWidth: 1.5, interpolate: 'monotone' },
        encoding: {
            // No axes at all. That is what makes it a sparkline rather than a
            // small line chart, and it is why the row label has to carry the
            // naming.
            x: { field: escapeField(x?.field ?? ''), type: x?.type ?? 'temporal', axis: null },
            y: {
                field: escapeField(y?.field ?? ''),
                type: 'quantitative',
                axis: null,
                scale: { zero: false },
            },
        },
    };

    const spec: Record<string, unknown> = { $schema: VL_SCHEMA };
    const title = state.title?.trim();
    const subtitle = state.subtitle?.trim();
    if (title) spec.title = subtitle ? { text: title, subtitle } : title;
    spec.facet = { row };
    spec.spacing = SPARK_SPACING;
    spec.spec = inner;
    // EVERY ROW GETS ITS OWN Y SCALE, and without this the chart is worthless.
    //
    // Vega-Lite shares scales across facets by default, which is right for most
    // small multiples and exactly wrong here. Rendered over five categories
    // spending between 1k and 9k, one shared domain squashed all five into
    // near-flat lines — a table of identical horizontal rules. It looked like a
    // styling problem and was a meaning problem.
    //
    // The opposite call to the bullet graph's shared scale, from the opposite
    // question. A bullet graph asks "did this clear its target", which is a
    // comparison of magnitudes and needs one axis. A sparkline asks "what is
    // this one DOING" — the shape is the content, and a shape you cannot see is
    // not a smaller answer, it is no answer.
    //
    // x stays SHARED: the rows are read down a common timeline, and rows over
    // different periods would be a table that invites a comparison it cannot
    // support.
    spec.resolve = { scale: { y: 'independent' } };
    return spec;
}

/**
 * The Vega-Lite spec for this state — no data, no width, no height.
 *
 * All three are RUNTIME concerns, bound where the chart is rendered: rows by
 * `VegaChart`'s named dataset, size by its container. A spec carrying any of
 * them cannot be reused on another surface, and reuse is the property the whole
 * "one spec, many deliverables" claim rests on.
 */
export function buildSpec(state: ChartSpecState): DiveChart {
    if (state.chart === 'bullet') return bulletSpec(state);
    if (state.chart === 'sparkline') return sparklineSpec(state);

    const encoding: Record<string, unknown> = {};
    for (const ch of Object.keys(state.encoding) as Channel[]) {
        const c = state.encoding[ch];
        if (!c || (!c.field && !c.count)) continue;
        encoding[ch] = channelDef(ch, c, state);
    }

    const spec: Record<string, unknown> = { $schema: VL_SCHEMA, mark: markFor(state) };
    const title = state.title?.trim();
    const subtitle = state.subtitle?.trim();
    if (title) spec.title = subtitle ? { text: title, subtitle } : title;
    spec.encoding = encoding;
    return spec;
}

// ---------------------------------------------------------------------------
// Spec -> state
// ---------------------------------------------------------------------------

/**
 * The only top-level keys these controls own. A WHITELIST, deliberately.
 *
 * A blacklist was the first cut and it was wrong in the quiet direction: a spec
 * carrying `width`, `config` or `autosize` read back cleanly and then lost that
 * key the next time `buildSpec` ran, because `buildSpec` writes these four and
 * nothing else. Listing what is understood means anything else sends the spec
 * to JSON mode, which is the honest answer.
 *
 * The two families this excludes on purpose rather than by omission:
 * `transform`, because plan §9 puts shaping in the SQL where it is visible and
 * reusable; and the multi-view keys (`facet`, `concat`, `repeat`), which
 * `chart-shape-guidance.md` §9 put out of scope — the matcher describes ONE
 * mark with its channels.
 *
 * `layer` is the ONE exception, and it is not handled here: `readSpec` sends a
 * layered spec to `readBullet` before it gets this far. The bullet graph earns
 * that because it is still a small closed record — a label, a measure, a
 * target, three thresholds — that happens to be SPELLED as layers.
 */
const MODELLED_KEYS = ['$schema', 'mark', 'encoding', 'title'];

/** Channel-level keys this state has no field for. */
const UNMODELLED_CHANNEL_KEYS = ['timeUnit', 'condition', 'value', 'datum', 'impute', 'band'];

const CHANNELS: Channel[] = ['x', 'y', 'color', 'theta', 'size'];
const VL_TYPES: VlType[] = ['nominal', 'ordinal', 'quantitative', 'temporal'];

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

/** The mark's type, whether it is a bare string or an object. */
export function markType(spec: DiveChart): string | null {
    const m = spec.mark;
    if (typeof m === 'string') return m;
    if (isRecord(m) && typeof m.type === 'string') return m.type;
    return null;
}

/** Is this channel def a category rather than a measure? */
const isCategorical = (def: unknown): boolean =>
    isRecord(def) && (def.type === 'nominal' || def.type === 'ordinal');

function chartTypeFor(mark: string, encoding: Record<string, unknown>): ChartType | null {
    switch (mark) {
        case 'bar': {
            // Three charts share `mark: 'bar'`, so the encoding decides which.
            // A binned x is a histogram; a CATEGORY on y with a measure on x is
            // the horizontal form; anything else is an upright bar chart.
            const x = encoding.x;
            if (isRecord(x) && x.bin) return 'histogram';
            if (isCategorical(encoding.y) && !isCategorical(x)) return 'barh';
            return 'bar';
        }
        case 'line':
            return 'line';
        case 'area':
            return 'area';
        case 'point':
        // A filled circle and a filled square are a scatter plot drawn with a
        // different pen. Reading them as `point` keeps the controls available
        // rather than dropping somebody into JSON over a cosmetic choice.
        case 'circle':
        case 'square':
            return 'point';
        case 'arc':
            return 'arc';
        case 'rect':
            return 'rect';
        case 'boxplot':
            return 'boxplot';
        default:
            return null;
    }
}

/**
 * A sort this state cannot express.
 *
 * A SYMBOL rather than `null`, because `sort: null` is now a real and
 * meaningful value — "leave the rows alone" — so it can no longer double as
 * "cannot model this".
 */
const UNREADABLE = Symbol('unreadable sort');

function readSort(channel: Channel, raw: unknown): SortOrder | undefined | typeof UNREADABLE {
    if (raw === undefined) return undefined;
    if (raw === null) return 'queryOrder';
    if (raw === 'ascending' || raw === 'descending') return raw;
    const other = channel === 'x' ? 'y' : 'x';
    if (raw === other) return 'byValueAscending';
    if (raw === `-${other}`) return 'byValueDescending';
    // A sort by some third field, or a full sort object: real Vega-Lite, and
    // not something these controls can round-trip.
    return UNREADABLE;
}

function readChannel(channel: Channel, raw: unknown): ChannelSpec | null {
    if (!isRecord(raw)) return null;
    if (UNMODELLED_CHANNEL_KEYS.some(k => k in raw)) return null;

    const aggregate = raw.aggregate;
    const count = aggregate === 'count';
    // Any other aggregate belongs in the SQL (plan §9), so a spec carrying one
    // is not something these controls should claim to own.
    if (aggregate !== undefined && !count) return null;

    const field = typeof raw.field === 'string' ? raw.field : undefined;
    if (!field && !count) return null;

    const type = raw.type;
    if (typeof type !== 'string' || !VL_TYPES.includes(type as VlType)) return null;

    const c: ChannelSpec = { type: type as VlType };
    if (count) c.count = true;
    // Back to the real column name: the state is compared against the result's
    // columns, so a `\.` in it would report every dotted column as missing.
    else c.field = unescapeField(field as string);

    if (raw.bin !== undefined) {
        // `bin: {maxbins: 40}` is a real refinement with no control here.
        if (raw.bin !== true) return null;
        c.bin = true;
    }

    if (raw.title !== undefined) {
        if (raw.title === null) c.title = null;
        else if (typeof raw.title === 'string') c.title = raw.title;
        else return null;
    }

    const sort = readSort(channel, raw.sort);
    if (sort === UNREADABLE) return null;
    if (sort) c.sort = sort;

    if (raw.scale !== undefined) {
        if (!isRecord(raw.scale)) return null;
        for (const k of Object.keys(raw.scale)) {
            if (k !== 'type' && k !== 'zero' && k !== 'scheme') return null;
        }
        const st = raw.scale.type;
        if (st !== undefined) {
            if (typeof st !== 'string' || !SCALE_TYPES.includes(st as ScaleType)) return null;
            c.scaleType = st as ScaleType;
        }
        if (raw.scale.zero !== undefined) {
            if (typeof raw.scale.zero !== 'boolean') return null;
            c.zero = raw.scale.zero;
        }
    }

    if (raw.legend !== undefined) {
        if (raw.legend === null) c.legend = false;
        else if (isRecord(raw.legend)) {
            if (Object.keys(raw.legend).some(k => k !== 'format')) return null;
            if (typeof raw.legend.format === 'string') c.format = raw.legend.format;
        } else return null;
    }

    if (raw.axis !== undefined) {
        if (!isRecord(raw.axis)) return null;
        if (Object.keys(raw.axis).some(k => k !== 'format')) return null;
        if (typeof raw.axis.format === 'string') c.format = raw.axis.format;
    }

    if (raw.stack !== undefined) {
        // Read at the top level by `readSpec`; rejected here only when it is
        // not a mode these controls offer.
        if (typeof raw.stack !== 'string' || !STACK_MODES.includes(raw.stack as StackMode)) {
            return null;
        }
    }

    return c;
}

/** The top-level keys a bullet graph is allowed to carry. */
const BULLET_KEYS = ['$schema', 'encoding', 'layer', 'title'];

/**
 * One bullet layer back to (channel, field), or null if it is not one of ours.
 *
 * The title and the format are returned ALONGSIDE the channel rather than put
 * on it. They describe the shared axis and are written to every layer, so
 * reading each layer's copy onto its own channel would relabel the ranges
 * "actual" and then write those labels back out on the next save.
 */
function readBulletLayer(
    raw: unknown,
): { channel: Channel; spec: ChannelSpec; title: unknown; format?: string } | null {
    if (!isRecord(raw)) return null;
    if (Object.keys(raw).some(k => k !== 'mark' && k !== 'encoding')) return null;
    const mark = raw.mark;
    if (!isRecord(mark) || typeof mark.color !== 'string') return null;
    const enc = raw.encoding;
    if (!isRecord(enc) || Object.keys(enc).some(k => k !== 'x')) return null;

    const x = enc.x;
    if (!isRecord(x) || typeof x.field !== 'string' || x.type !== 'quantitative') return null;
    if (Object.keys(x).some(k => k !== 'field' && k !== 'type' && k !== 'title' && k !== 'axis')) {
        return null;
    }
    if (x.title !== null && typeof x.title !== 'string') return null;

    const spec: ChannelSpec = { field: unescapeField(x.field), type: 'quantitative' };
    let format: string | undefined;
    if (x.axis !== undefined) {
        if (!isRecord(x.axis)) return null;
        if (Object.keys(x.axis).some(k => k !== 'format')) return null;
        if (typeof x.axis.format !== 'string') return null;
        format = x.axis.format;
    }
    const out = { spec, title: x.title, format };

    if (mark.type === 'tick') {
        if (mark.color !== TARGET_STROKE) return null;
        if (Object.keys(mark).some(k => !['type', 'color', 'thickness'].includes(k))) return null;
        return { ...out, channel: 'target' };
    }
    if (mark.type !== 'bar') return null;
    if (Object.keys(mark).some(k => !['type', 'color', 'size'].includes(k))) return null;
    if (mark.color === MEASURE_FILL) return { ...out, channel: 'measure' };
    const i = RANGE_FILL.indexOf(mark.color);
    return i < 0 ? null : { ...out, channel: RANGE_CHANNELS[i] };
}

/**
 * A bullet graph back as state, or `null` for any other layered spec.
 *
 * Matched STRICTLY — the layer order, the mark colours, the keys on each
 * channel def. That is deliberately unforgiving: a layered spec is the one
 * shape a person is most likely to have hand-built into something these
 * controls would quietly flatten, and the mark colours are what tell our bullet
 * graph from somebody else's bar-and-tick stack. Change a colour in the JSON
 * tab and the spec stays in JSON, which is the same bargain `MODELLED_KEYS`
 * already strikes for the single-mark charts.
 */
function readBullet(spec: Record<string, unknown>): ChartSpecState | null {
    if (Object.keys(spec).some(k => !BULLET_KEYS.includes(k))) return null;
    const layers = spec.layer;
    if (!Array.isArray(layers) || layers.length < 2) return null;

    const encoding: Partial<Record<Channel, ChannelSpec>> = {};
    let lastRange = RANGE_CHANNELS.length;
    let axis: { title: unknown; format?: string } | null = null;
    for (let i = 0; i < layers.length; i += 1) {
        const read = readBulletLayer(layers[i]);
        if (!read) return null;
        if (read.channel in encoding) return null;
        // Every layer carries the same axis label and format, because that is
        // the only way Vega-Lite's axis merge keeps either. A spec where they
        // differ was not written here.
        if (axis === null) axis = { title: read.title, format: read.format };
        else if (axis.title !== read.title || axis.format !== read.format) return null;
        // The ranges come largest first, and the measure and the target come
        // after all of them. Anything else is a spec `bulletSpec` would not
        // have written, so reading it as one would reorder the layers on save.
        if (RANGE_CHANNELS.includes(read.channel)) {
            const at = RANGE_CHANNELS.indexOf(read.channel);
            if (at >= lastRange) return null;
            lastRange = at;
        } else if (read.channel === 'measure') {
            if (i !== layers.length - 2) return null;
        } else if (i !== layers.length - 1) return null;
        encoding[read.channel] = read.spec;
    }
    if (!encoding.measure || !encoding.target || !axis) return null;

    // The axis belongs to the featured measure — that is where the Label and
    // the number format are edited. `bulletAxisTitle` DEFAULTS the label to the
    // measure's column name, so reading that back as an explicit title would
    // fill the Label box in by itself on every reopen.
    if (axis.title !== null && axis.title !== encoding.measure.field) {
        encoding.measure.title = axis.title as string;
    } else if (axis.title === null) {
        encoding.measure.title = null;
    }
    if (axis.format) encoding.measure.format = axis.format;

    const encRaw = spec.encoding;
    if (!isRecord(encRaw) || Object.keys(encRaw).some(k => k !== 'y')) return null;
    const y = encRaw.y;
    if (!isRecord(y) || typeof y.field !== 'string') return null;
    if (Object.keys(y).some(k => !['field', 'type', 'sort', 'title', 'scale'].includes(k))) {
        return null;
    }
    if (typeof y.type !== 'string' || !VL_TYPES.includes(y.type as VlType)) return null;
    if (y.sort !== null && y.sort !== 'ascending' && y.sort !== 'descending') return null;
    // The row padding is fixed, not a refinement — a spec with a different one
    // is not a spec these controls wrote, and owning it would overwrite it.
    if (!isRecord(y.scale)) return null;
    if (y.scale.paddingInner !== BULLET_PADDING) return null;

    const label: ChannelSpec = { field: unescapeField(y.field), type: y.type as VlType };
    if (y.sort === 'ascending' || y.sort === 'descending') label.sort = y.sort;
    if (typeof y.title === 'string') label.title = y.title;
    else if (y.title !== null) return null;
    encoding.label = label;

    const state: ChartSpecState = { chart: 'bullet', encoding };
    const title = spec.title;
    if (typeof title === 'string') state.title = title;
    else if (isRecord(title)) {
        if (Object.keys(title).some(k => k !== 'text' && k !== 'subtitle')) return null;
        if (typeof title.text === 'string') state.title = title.text;
        if (typeof title.subtitle === 'string') state.subtitle = title.subtitle;
    } else if (title !== undefined) return null;
    return state;
}

/** The top-level keys a sparkline table is allowed to carry. */
const SPARK_KEYS = ['$schema', 'facet', 'spacing', 'spec', 'resolve', 'title'];

/**
 * A sparkline table back as state, or `null` for any other faceted spec.
 *
 * Matched as strictly as `readBullet`, and for the same reason: everything
 * outside the three fields is a constant `sparklineSpec` wrote, so a spec where
 * one of them differs is not ours, and owning it would quietly overwrite the
 * difference on the next save.
 */
function readSparkline(spec: Record<string, unknown>): ChartSpecState | null {
    if (Object.keys(spec).some(k => !SPARK_KEYS.includes(k))) return null;
    if (spec.spacing !== SPARK_SPACING) return null;
    // Independent y is what makes it a sparkline rather than five flat lines,
    // so a spec without it is not one of ours — and quietly re-adding it would
    // change what somebody's hand-edited chart says.
    const resolve = spec.resolve;
    if (!isRecord(resolve) || Object.keys(resolve).some(k => k !== 'scale')) return null;
    if (!isRecord(resolve.scale) || Object.keys(resolve.scale).some(k => k !== 'y')) return null;
    if (resolve.scale.y !== 'independent') return null;

    const facet = spec.facet;
    if (!isRecord(facet) || Object.keys(facet).some(k => k !== 'row')) return null;
    const row = facet.row;
    if (!isRecord(row)) return null;
    if (Object.keys(row).some(k => !['field', 'type', 'header', 'sort'].includes(k))) return null;
    if (typeof row.field !== 'string') return null;
    if (typeof row.type !== 'string' || !VL_TYPES.includes(row.type as VlType)) return null;
    if (row.sort !== 'ascending' && row.sort !== 'descending') return null;
    const header = row.header;
    if (!isRecord(header)) return null;
    if (header.labelAngle !== 0 || header.labelAlign !== 'left') return null;
    if (header.title !== null && typeof header.title !== 'string') return null;

    const inner = spec.spec;
    if (!isRecord(inner)) return null;
    if (Object.keys(inner).some(k => !['height', 'view', 'mark', 'encoding'].includes(k))) {
        return null;
    }
    // The row height is the design, not a refinement — see `SPARK_HEIGHT`. A
    // different one is somebody's own chart. And a WIDTH means the spec was
    // saved with a size baked in, which is the thing every chart here avoids.
    if (inner.height !== SPARK_HEIGHT) return null;
    const mark = inner.mark;
    if (!isRecord(mark)) return null;
    if (mark.type !== 'line' || mark.color !== SPARK_STROKE) return null;
    if (mark.interpolate !== 'monotone') return null;

    const encRaw = inner.encoding;
    if (!isRecord(encRaw) || Object.keys(encRaw).some(k => k !== 'x' && k !== 'y')) return null;
    const rawX = encRaw.x;
    const rawY = encRaw.y;
    if (!isRecord(rawX) || !isRecord(rawY)) return null;
    if (rawX.axis !== null || rawY.axis !== null) return null;
    if (typeof rawX.field !== 'string' || typeof rawY.field !== 'string') return null;
    if (typeof rawX.type !== 'string' || !VL_TYPES.includes(rawX.type as VlType)) return null;
    if (rawY.type !== 'quantitative') return null;

    const label: ChannelSpec = {
        field: unescapeField(row.field),
        type: row.type as VlType,
    };
    // `ascending` is what `sparklineSpec` writes when nothing was chosen, so
    // reading it back as a choice would fill the Order control in by itself.
    if (row.sort === 'descending') label.sort = 'descending';
    if (typeof header.title === 'string') label.title = header.title;

    const state: ChartSpecState = {
        chart: 'sparkline',
        encoding: {
            label,
            x: { field: unescapeField(rawX.field), type: rawX.type as VlType },
            y: { field: unescapeField(rawY.field), type: 'quantitative' },
        },
    };

    const title = spec.title;
    if (typeof title === 'string') state.title = title;
    else if (isRecord(title)) {
        if (Object.keys(title).some(k => k !== 'text' && k !== 'subtitle')) return null;
        if (typeof title.text === 'string') state.title = title.text;
        if (typeof title.subtitle === 'string') state.subtitle = title.subtitle;
    } else if (title !== undefined) return null;
    return state;
}

/**
 * A spec back as editable state, or `null` when these controls cannot model it.
 *
 * `null` is a real answer rather than a failure: a layered spec, a `transform`,
 * a `timeUnit` or an aggregate other than the histogram's count is valid
 * Vega-Lite that this GUI would silently flatten. Reporting it keeps the JSON
 * the source of truth in exactly the cases where the JSON is doing something
 * the controls do not know about.
 */
export function readSpec(spec: DiveChart): ChartSpecState | null {
    if (!isRecord(spec)) return null;
    // The two multi-view shapes these controls own. Every other layered or
    // faceted spec still falls through to `null` and stays in JSON, as before.
    if ('layer' in spec) return readBullet(spec);
    if ('facet' in spec) return readSparkline(spec);
    if (Object.keys(spec).some(k => !MODELLED_KEYS.includes(k))) return null;

    const mark = markType(spec);
    if (!mark) return null;
    const encRaw = spec.encoding;
    if (!isRecord(encRaw)) return null;
    // An unknown channel — `row`, `column`, `tooltip`, `opacity` — would be
    // dropped by `buildSpec`, so owning this spec would delete it.
    if (Object.keys(encRaw).some(k => !CHANNELS.includes(k as Channel))) return null;

    const chart = chartTypeFor(mark, encRaw);
    if (!chart) return null;

    const encoding: Partial<Record<Channel, ChannelSpec>> = {};
    for (const ch of CHANNELS) {
        if (!(ch in encRaw)) continue;
        const c = readChannel(ch, encRaw[ch]);
        if (!c) return null;
        encoding[ch] = c;
    }

    const state: ChartSpecState = { chart, encoding };

    const title = spec.title;
    if (typeof title === 'string') state.title = title;
    else if (isRecord(title)) {
        if (Object.keys(title).some(k => k !== 'text' && k !== 'subtitle')) return null;
        if (typeof title.text === 'string') state.title = title.text;
        if (typeof title.subtitle === 'string') state.subtitle = title.subtitle;
    } else if (title !== undefined) return null;

    // The scheme lives on the colour channel's scale in the spec and at the
    // state's top level, because it is ONE choice — asking for it per channel
    // would imply there is more than one place it could apply.
    const color = encRaw.color;
    if (isRecord(color) && isRecord(color.scale) && typeof color.scale.scheme === 'string') {
        state.scheme = color.scale.scheme;
    }

    const stack = isRecord(encRaw.y) ? encRaw.y.stack : undefined;
    if (typeof stack === 'string') state.stack = stack as StackMode;

    const m = spec.mark;
    if (isRecord(m)) {
        const allowed = ['type', 'filled', 'point'];
        if (Object.keys(m).some(k => !allowed.includes(k))) return null;
        if (m.point === true) state.points = true;
        else if (m.point !== undefined) return null;
    }

    return state;
}

// ---------------------------------------------------------------------------
// Starting points and checks
// ---------------------------------------------------------------------------

/**
 * The state a chart type and a column-to-channel mapping imply.
 *
 * The histogram's `bin` and its count are added HERE rather than asked of the
 * matcher, because the matcher's job ends at "this quantitative column can go
 * on x" — how a histogram is spelled in Vega-Lite is this module's business.
 */
export function stateFromEncoding(chart: ChartType, encoding: Encoding): ChartSpecState {
    const enc: Partial<Record<Channel, ChannelSpec>> = {};
    for (const ch of Object.keys(encoding) as Channel[]) {
        const e = encoding[ch];
        if (e) enc[ch] = { field: e.field, type: e.type };
    }
    if (chart === 'histogram') {
        if (enc.x) enc.x.bin = true;
        enc.y = { count: true, type: 'quantitative' };
    }
    // Horizontal bars open RANKED, largest first.
    //
    // The one place a chart arrives with a refinement already applied, and it
    // is not an exception to "the person picks" — that rule is about which
    // CHART gets drawn, not about its defaults. Ranked categories are what the
    // sideways form is FOR: Vega-Lite would otherwise order them
    // alphabetically, which is the one ordering a reader of a ranked bar chart
    // is guaranteed not to want. Still a plain `sort` on the channel, so the
    // Order control shows "Largest value first" and can be changed.
    if (chart === 'barh' && enc.y) enc.y.sort = 'byValueDescending';
    return { chart, encoding: enc };
}

/** The state a `fits` verdict proposes, or null for any other verdict. */
export function stateFromVerdict(verdict: Verdict): ChartSpecState | null {
    const encoding = proposeEncoding(verdict);
    return encoding ? stateFromEncoding(verdict.chart, encoding) : null;
}

/**
 * Channels pointing at columns the result does not have.
 *
 * The failure this catches is ordinary and otherwise invisible: the chart was
 * built, the query was then edited, and the spec still names a column that has
 * gone. Vega-Lite renders that as an EMPTY chart rather than an error, so
 * somebody is left staring at a blank panel with nothing to read.
 */
export function missingFields(state: ChartSpecState, fields: Field[]): string[] {
    const have = new Set(fields.map(f => f.name));
    const out: string[] = [];
    for (const ch of Object.keys(state.encoding) as Channel[]) {
        const f = state.encoding[ch]?.field;
        if (f && !have.has(f)) out.push(f);
    }
    return out;
}

/** Channels the built spec actually encodes, in channel order. */
export function encodedChannels(state: ChartSpecState): Channel[] {
    return (Object.keys(state.encoding) as Channel[]).filter(ch => {
        const c = state.encoding[ch];
        return !!c && (!!c.field || !!c.count);
    });
}

// ---------------------------------------------------------------------------
// Remapping a channel
// ---------------------------------------------------------------------------
//
// Pure, for the same reason `builder-ops.ts` is: this is where the rules live,
// and rules in a hook are rules that need a browser to check. `useChartEditor`
// is a thin wrapper over these two.

/** One option in a channel's column picker. */
export interface ChannelOption {
    field: string;
    /** Already on another channel. Offered anyway — swapping is normal. */
    taken?: Channel;
}

/**
 * The columns a channel may hold, by its own contract.
 *
 * Filtered by `need.accepts`, which is what makes remapping SAFE: a fitting
 * chart cannot be turned into a broken one by moving columns around, because
 * the only columns offered are ones the channel accepts. That is the same
 * guarantee the query builder gets from only offering reachable tables.
 */
export function channelOptions(
    state: ChartSpecState,
    need: ChannelNeed,
    fields: Field[],
): ChannelOption[] {
    const owner = new Map<string, Channel>();
    for (const ch of Object.keys(state.encoding) as Channel[]) {
        const f = state.encoding[ch]?.field;
        if (f) owner.set(f, ch);
    }
    return fields
        .filter(f => need.accepts.includes(f.vlType))
        .map(f => {
            const taken = owner.get(f.name);
            return taken && taken !== need.channel ? { field: f.name, taken } : { field: f.name };
        });
}

/**
 * Put a column on a channel, or clear an optional one.
 *
 * Returns the state UNCHANGED for anything the contract forbids — a column of
 * the wrong type, a column that is not in the result, or clearing a required
 * channel. Refusing rather than throwing because this is called from a picker
 * that should not be able to produce an invalid chart in the first place; a
 * silent no-op is the behaviour of a control that was never really offered.
 */
export function assignChannel(
    state: ChartSpecState,
    need: ChannelNeed,
    fields: Field[],
    field: string | null,
): ChartSpecState {
    const encoding = { ...state.encoding };
    if (field === null) {
        // A required channel has no empty state that still draws anything.
        if (need.required) return state;
        if (!(need.channel in encoding)) return state;
        delete encoding[need.channel];
        return { ...state, encoding };
    }
    const f = fields.find(x => x.name === field);
    if (!f || !need.accepts.includes(f.vlType)) return state;
    // Refinements survive a remap: an axis title and a sort order describe the
    // CHANNEL, not the column that happens to be on it. `count` does not — it
    // is the absence of a column, which is what this call undoes.
    const { count: _count, ...prev } = encoding[need.channel] ?? { type: f.vlType };
    encoding[need.channel] = { ...prev, field: f.name, type: f.vlType };
    return { ...state, encoding };
}
