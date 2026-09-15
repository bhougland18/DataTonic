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

/**
 * The Vega-Lite spec for this state — no data, no width, no height.
 *
 * All three are RUNTIME concerns, bound where the chart is rendered: rows by
 * `VegaChart`'s named dataset, size by its container. A spec carrying any of
 * them cannot be reused on another surface, and reuse is the property the whole
 * "one spec, many deliverables" claim rests on.
 */
export function buildSpec(state: ChartSpecState): DiveChart {
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
 * reusable; and the multi-view keys (`layer`, `facet`, `concat`, `repeat`),
 * which `chart-shape-guidance.md` §9 put out of scope — the matcher describes
 * ONE mark with its channels.
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
