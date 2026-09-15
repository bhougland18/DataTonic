// Does this result fit that chart — and if not, what is missing?
//
// The whole correctness surface of chart guidance (plan `chart-shape-guidance.md`
// §2), and pure on purpose: no framework, no network, no model call. A chart
// type's data requirement is small, closed and knowable — a set of encoding
// channels, each accepting certain Vega-Lite types — so whether a result suits
// it is DETERMINED by the column types, not a matter of opinion.
//
// Same move `builder-sql.ts` made for SQL. Asking a model "does this data suit a
// bar chart" invites an answer that sounds right and is not checkable; asking
// the types gives an answer that is instant, testable without a browser, and
// cannot invent a requirement that does not exist.

import { isNumericType, isTemporalType } from './builder-types';
import type { SqlStudioColumn } from '../sqleditor/types';

/** Vega-Lite's four measurement types. */
export type VlType = 'nominal' | 'ordinal' | 'quantitative' | 'temporal';

/** The encoding channels the built-in marks need between them. */
export type Channel = 'x' | 'y' | 'color' | 'theta' | 'size';

export type ChartType =
    | 'bar'
    | 'barh'
    | 'line'
    | 'area'
    | 'point'
    | 'arc'
    | 'rect'
    | 'boxplot'
    | 'histogram';

export interface ChannelNeed {
    channel: Channel;
    accepts: VlType[];
    required: boolean;
    /**
     * What to call it when asking for it — "a category", "a number".
     *
     * The message has to name the fix, not the failure. "Wrong shape" tells
     * somebody they are stuck; "needs a number — add a count or a sum" tells
     * them what to click.
     */
    label: string;
}

export interface ShapeVariant {
    id: string;
    /** Shown when this is the variant that matched: "Grouped bars". */
    label: string;
    needs: ChannelNeed[];
}

export interface ChartShape {
    type: ChartType;
    label: string;
    variants: ShapeVariant[];
    /**
     * Summarises the DISTRIBUTION of one measure, discarding everything else.
     *
     * Box plots and histograms answer the same question in different ink, and
     * both need a crowd: quartiles or bins computed from a handful of points
     * describe the handful, not a distribution.
     */
    distribution?: boolean;
}

/**
 * What the matcher knows beyond the column types.
 *
 * Optional throughout: the builder can answer these before a run, a result
 * answers them after one, and hand-written SQL may answer neither. An unknown
 * stays unknown rather than being guessed — the same rule `vlTypeOf` follows
 * for a failed probe.
 */
export interface ShapeContext {
    /** Rows in the result. */
    rowCount?: number;
    /**
     * The measures are GROUP BY aggregates — one row per group.
     *
     * **Window functions are deliberately NOT aggregates by this definition.**
     * `avg(x) OVER (…)` returns a value per ROW and collapses nothing, so the
     * result keeps its raw grain and a distribution of it is a real
     * distribution. `avg(x) … GROUP BY g` returns one value per group, and
     * summarising those summarises summaries.
     *
     * In the builder that distinction holds by construction: `SelectedColumn`
     * only ever carries a GROUP BY aggregate, because the builder has no window
     * functions. Hand-written SQL leaves this undefined rather than guessing —
     * telling the two apart means parsing, and a wrong guess here silently
     * removes a chart somebody wanted.
     */
    aggregated?: boolean;
}

/**
 * How many rows a distribution chart needs before it says anything.
 *
 * Calibrated against two real queries rather than chosen in the abstract, which
 * is what plan §12 asked for: a count over 36 manufacturers was a fair box plot,
 * a count over 7 vendors was not. Twenty puts the line between them with room
 * either side, and leaves every quartile more than a couple of points.
 *
 * Applied only when the row count is KNOWN. Before a run there is nothing to
 * count, and suppressing the chart then would make it flicker into existence on
 * Run for reasons nobody could see.
 */
export const MIN_DISTRIBUTION_ROWS = 20;

/** A result column, already reduced to what the matcher cares about. */
export interface Field {
    name: string;
    vlType: VlType;
}

/** Channel → field, ready to become a Vega-Lite `encoding` block. */
export type Encoding = Partial<Record<Channel, { field: string; type: VlType }>>;

/**
 * Whether a result fits, nearly fits, or does not fit a chart.
 *
 * `close` is a DISTINCT verdict rather than a flavour of `wrong`, because "you
 * have the category, now add a count" is the single most useful thing this can
 * say and it is not the same message as "this cannot be a bar chart". One
 * missing required channel is close; more than one is wrong.
 */
export type Verdict =
    | {
          kind: 'fits';
          chart: ChartType;
          variant: ShapeVariant;
          encoding: Encoding;
          /** Columns the chart will not show. Not a problem, but worth saying. */
          unused: string[];
      }
    | { kind: 'close'; chart: ChartType; variant: ShapeVariant; missing: ChannelNeed[] }
    | { kind: 'wrong'; chart: ChartType; nearest: ShapeVariant; missing: ChannelNeed[] }
    /**
     * The columns fit, but the chart would not mean anything.
     *
     * A separate verdict from `wrong` because it is a different statement: not
     * "your data cannot make this chart" but "it can, and the result would be
     * misleading". A box plot of seven numbers renders perfectly and reports
     * quartiles computed from two points each.
     */
    | { kind: 'unsuitable'; chart: ChartType; variant: ShapeVariant; reason: string };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Composite types have no single value to put on an axis. */
const COMPOSITE = /^\s*(struct|map|union)\s*\(/i;

const BOOLEAN = /^\s*bool(ean)?\s*$/i;

/**
 * A DuckDB type as Vega-Lite sees it, or `null` when it cannot be plotted.
 *
 * Two judgement calls, both recorded in plan §4:
 *
 * **An unknown type is `nominal`, not `quantitative`.** Same reasoning as
 * `aggregatesFor`: a probe that failed must not manufacture a capability. A
 * wrong `nominal` draws an ugly chart; a wrong `quantitative` draws a chart
 * that silently means nothing.
 *
 * **`BOOLEAN` is `nominal`.** Two categories, not a measure — averaging it is
 * a thing somebody might want, but plotting it as a magnitude is not what a
 * true/false column means.
 */
export function vlTypeOf(duckdbType?: string): VlType | null {
    if (!duckdbType) return 'nominal';
    const t = duckdbType.trim();
    if (!t) return 'nominal';
    // Lists (`INTEGER[]`) and structs before anything else: `INTEGER[]` would
    // otherwise read as numeric, and a list of numbers is not a number.
    if (t.endsWith('[]') || COMPOSITE.test(t)) return null;
    if (isTemporalType(t)) return 'temporal';
    if (BOOLEAN.test(t)) return 'nominal';
    if (isNumericType(t)) return 'quantitative';
    return 'nominal';
}

/**
 * Result columns as matcher fields, dropping what cannot be plotted.
 *
 * Column ORDER is preserved and load-bearing: where several columns share a
 * type, the matcher takes the first, which is the order the person put them in.
 *
 * `identifiers` names the columns that are KEYS rather than measures. Nothing
 * in a column's type can say that — see the note on the parameter — so the
 * caller supplies it from what the workspace already records.
 */
export function fieldsFromColumns(
    columns: SqlStudioColumn[],
    /**
     * Columns that identify a row rather than measure it.
     *
     * A foreign key is an integer, so `vlTypeOf` calls it `quantitative` and
     * every chart wanting a number accepts it. The damage that did was not
     * subtle: over `Vendor`(int64) / `VendorName` / `count`, a LINE CHART
     * ranked first with vendor ID NUMBERS along the x axis — and the bar chart,
     * which was right, was offered with the ID as its bar heights, because
     * `Vendor` precedes `count` among the quantitative columns.
     *
     * Retyped `nominal`, not dropped: counting by vendor ID is a real chart,
     * and an ID makes a perfectly good category. What it is not is a magnitude.
     *
     * OPTIONAL, and unknown stays unknown — the same rule `aggregated` follows.
     * The SQL Editor node has no ER model to ask, so it passes nothing and
     * behaves exactly as before rather than guessing from column names.
     */
    identifiers?: ReadonlySet<string>,
): Field[] {
    const out: Field[] = [];
    for (const c of columns) {
        const vlType = vlTypeOf(c.type);
        if (!vlType) continue;
        // Only a NUMERIC key needs retyping; a text key is already a category,
        // and a temporal one is a date somebody joined on and still a date.
        const isKey = vlType === 'quantitative' && identifiers?.has(c.name);
        out.push({ name: c.name, vlType: isKey ? 'nominal' : vlType });
    }
    return out;
}

/**
 * The key columns an ER model and a probe between them declare.
 *
 * Both halves are RECORDED FACTS rather than inference: a relationship is a
 * join somebody drew (or confirmed), and a primary key comes from the probe.
 * That is the same standard `builder-sql.ts` holds itself to, and it is why
 * this can be trusted enough to change a chart's verdict — a heuristic on
 * column names would be wrong often enough to make the whole matcher
 * ignorable.
 *
 * Matched by column NAME, because that is all a result carries. A column
 * called `Vendor` in an unrelated query is therefore also read as a key, which
 * is the right answer nearly always and a harmless one otherwise: it becomes a
 * category instead of a measure.
 */
export function identifierColumns(
    relationships: { fromColumn: string; toColumn: string }[],
    columns: SqlStudioColumn[] = [],
): Set<string> {
    const keys = new Set<string>();
    for (const r of relationships) {
        if (r.fromColumn) keys.add(r.fromColumn);
        if (r.toColumn) keys.add(r.toColumn);
    }
    for (const c of columns) if (c.primaryKey) keys.add(c.name);
    return keys;
}

// ---------------------------------------------------------------------------
// The contracts
// ---------------------------------------------------------------------------

const category = (channel: Channel, required = true, label = 'a category'): ChannelNeed => ({
    channel,
    accepts: ['nominal', 'ordinal'],
    required,
    label,
});

const measure = (channel: Channel, required = true, label = 'a number'): ChannelNeed => ({
    channel,
    accepts: ['quantitative'],
    required,
    label,
});

/**
 * The built-in shapes, and why each accepts what it does.
 *
 * Variants, not one shape per chart (plan §3) — the biggest correctness risk in
 * the whole feature. A contract naming only the simple case tells somebody
 * holding a perfectly good grouped-bar result that their data is wrong, and a
 * validator that is wrong even occasionally gets ignored permanently.
 *
 * Grouped and stacked bars are the OPTIONAL `color` on `bars`, not a second
 * variant. Two variants that both match the same data would make "which one did
 * it pick" a question nobody asked.
 */
export const CHART_SHAPES: ChartShape[] = [
    {
        type: 'bar',
        label: 'Bar chart',
        variants: [
            {
                id: 'bars',
                label: 'Bars per category',
                needs: [
                    category('x'),
                    measure('y'),
                    category('color', false, 'a second category to split by'),
                ],
            },
        ],
    },
    {
        type: 'barh',
        label: 'Horizontal bars',
        variants: [
            {
                id: 'barsh',
                label: 'Ranked categories',
                // The MEASURE is on x and the CATEGORY on y — the transpose of
                // `bar`, not a styling flag on it, because which channel holds
                // which type is the whole contract.
                //
                // Worth its own card rather than a variant of the bar chart:
                // the gallery is visual, and a person choosing between upright
                // and sideways bars is choosing a picture, not a setting. It
                // also earns its place — long category names are unreadable
                // rotated under an upright axis, which is the usual reason to
                // turn a bar chart on its side.
                needs: [
                    category('y'),
                    measure('x'),
                    category('color', false, 'a second category to split by'),
                ],
            },
        ],
    },
    {
        type: 'histogram',
        label: 'Histogram',
        distribution: true,
        variants: [
            {
                id: 'histogram',
                label: 'Binned counts',
                // The one deliberate exception to "shaping happens in SQL"
                // (plan §9): binning in SQL to draw a histogram is worse than
                // letting the spec bin, and it throws away the raw column.
                needs: [measure('x', true, 'a number to bin')],
            },
        ],
    },
    {
        type: 'line',
        label: 'Line chart',
        variants: [
            {
                id: 'line',
                label: 'A line over time',
                needs: [
                    // Deliberately NOT nominal. A line implies the x axis has
                    // an order, and accepting categories would make `line` fit
                    // every result a bar chart fits — which makes the
                    // suggestion list noise instead of a recommendation.
                    {
                        channel: 'x',
                        accepts: ['temporal', 'quantitative'],
                        required: true,
                        label: 'a date or a number for the axis',
                    },
                    measure('y'),
                    category('color', false, 'a category to draw one line each'),
                ],
            },
        ],
    },
    {
        type: 'area',
        label: 'Area chart',
        variants: [
            {
                id: 'area',
                label: 'Filled area over time',
                needs: [
                    {
                        channel: 'x',
                        accepts: ['temporal', 'quantitative'],
                        required: true,
                        label: 'a date or a number for the axis',
                    },
                    measure('y'),
                    category('color', false, 'a category to stack by'),
                ],
            },
        ],
    },
    {
        type: 'point',
        label: 'Scatter plot',
        variants: [
            {
                id: 'scatter',
                label: 'One point per row',
                needs: [
                    {
                        channel: 'x',
                        accepts: ['quantitative', 'temporal'],
                        required: true,
                        label: 'a number for the x axis',
                    },
                    measure('y', true, 'a number for the y axis'),
                    category('color', false, 'a category to colour by'),
                    measure('size', false, 'a number to size the points by'),
                ],
            },
        ],
    },
    {
        type: 'arc',
        label: 'Pie chart',
        variants: [
            {
                id: 'pie',
                label: 'Slices of a whole',
                needs: [
                    measure('theta', true, 'a number to size the slices'),
                    category('color'),
                ],
            },
        ],
    },
    {
        type: 'rect',
        label: 'Heatmap',
        variants: [
            {
                id: 'heatmap',
                label: 'A grid coloured by value',
                needs: [
                    {
                        channel: 'x',
                        accepts: ['nominal', 'ordinal', 'temporal'],
                        required: true,
                        label: 'a category or date across',
                    },
                    category('y', true, 'a category down'),
                    measure('color', true, 'a number to colour by'),
                ],
            },
        ],
    },
    {
        type: 'boxplot',
        label: 'Box plot',
        distribution: true,
        variants: [
            {
                id: 'spread',
                label: 'Spread of one measure',
                // NO category channel, and that is the whole point.
                //
                // A box plot summarises the y values WITHIN each x group, so
                // splitting by a category needs many rows per category. Against
                // an aggregated result — `GROUP BY Manufacturer`, one row each —
                // every box is built from a single number and comes out as a
                // flat tick. It renders, it means nothing, and it looked like a
                // fit.
                //
                // GRAIN is what the contract cannot see: row multiplicity is not
                // visible in a column's type, which is all the matcher gets.
                // Until it is (from builder state, or from distinct counts in
                // the result), the honest offer is the ungrouped form — one box
                // over the measure, which is a real answer to "how are these
                // counts distributed".
                needs: [measure('y', true, 'a number to summarise')],
            },
        ],
    },
];

export const shapeFor = (type: ChartType): ChartShape | undefined =>
    CHART_SHAPES.find(s => s.type === type);

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

type Counts = Record<VlType, number>;

const emptyCounts = (): Counts => ({
    nominal: 0,
    ordinal: 0,
    quantitative: 0,
    temporal: 0,
});

function countByType(fields: Field[]): Counts {
    const counts = emptyCounts();
    for (const f of fields) counts[f.vlType] += 1;
    return counts;
}

/** Which need took which TYPE. Concrete columns are chosen afterwards. */
type Plan = (VlType | null)[];

/**
 * The best way to satisfy a variant's needs from the types available.
 *
 * Searches over TYPE COUNTS rather than over individual columns, which is what
 * keeps this exact and still cheap. A greedy left-to-right assignment is
 * subtly wrong — needs `x: nominal|quantitative` then `y: nominal` against one
 * of each would hand the nominal to `x` and then report `y` unfillable, when
 * swapping them satisfies both. Backtracking over concrete columns would fix
 * that but costs O(columns^needs); backtracking over the four types costs at
 * most 4^needs, because two columns of the same type are interchangeable here.
 *
 * Ranked by required-needs-filled first, then optional — a variant that seats
 * every required channel always beats one that trades a required for two
 * optionals.
 */
function bestPlan(needs: ChannelNeed[], fields: Field[]): Plan {
    let best: Plan | null = null;
    let bestScore = [-1, -1];

    const score = (plan: Plan): [number, number] => {
        let req = 0;
        let opt = 0;
        plan.forEach((t, i) => {
            if (!t) return;
            if (needs[i].required) req += 1;
            else opt += 1;
        });
        return [req, opt];
    };

    const walk = (i: number, left: Counts, acc: Plan) => {
        if (i === needs.length) {
            const s = score(acc);
            if (s[0] > bestScore[0] || (s[0] === bestScore[0] && s[1] > bestScore[1])) {
                bestScore = s;
                best = [...acc];
            }
            return;
        }
        for (const t of needs[i].accepts) {
            if (left[t] > 0) {
                left[t] -= 1;
                acc.push(t);
                walk(i + 1, left, acc);
                acc.pop();
                left[t] += 1;
            }
        }
        // Leaving a need unfilled is always a branch: an optional channel is
        // often better left empty, and a required one has to be reportable as
        // missing rather than making the whole variant unmatchable.
        acc.push(null);
        walk(i + 1, left, acc);
        acc.pop();
    };

    walk(0, countByType(fields), []);
    return best ?? needs.map(() => null);
}

/** Turn a type plan into real columns, first unused of each type, in order. */
function materialise(needs: ChannelNeed[], fields: Field[], plan: Plan): Encoding {
    const used = new Set<number>();
    const encoding: Encoding = {};
    plan.forEach((t, i) => {
        if (!t) return;
        const idx = fields.findIndex((f, j) => !used.has(j) && f.vlType === t);
        if (idx < 0) return;
        used.add(idx);
        encoding[needs[i].channel] = { field: fields[idx].name, type: t };
    });
    return encoding;
}

/**
 * Assign columns to a bare list of channel needs.
 *
 * Exported because a saved CUSTOM chart is matched by exactly this logic: its
 * encoding is a contract too, just one written by a person rather than by
 * `CHART_SHAPES`. Sharing the assignment is what gives a custom template the
 * same honest verdict as a built-in — "needs a number", rather than a chart
 * that silently draws nothing because its field names came from another query.
 */
export function matchNeeds(
    needs: ChannelNeed[],
    fields: Field[],
): { encoding: Encoding; missing: ChannelNeed[] } {
    const plan = bestPlan(needs, fields);
    return {
        encoding: materialise(needs, fields, plan),
        missing: needs.filter((n, i) => n.required && !plan[i]),
    };
}

function checkVariant(chart: ChartType, variant: ShapeVariant, fields: Field[]): Verdict {
    const plan = bestPlan(variant.needs, fields);
    const missing = variant.needs.filter((n, i) => n.required && !plan[i]);

    if (missing.length === 0) {
        const encoding = materialise(variant.needs, fields, plan);
        const taken = new Set(Object.values(encoding).map(e => e.field));
        return {
            kind: 'fits',
            chart,
            variant,
            encoding,
            unused: fields.filter(f => !taken.has(f.name)).map(f => f.name),
        };
    }
    if (missing.length === 1) return { kind: 'close', chart, variant, missing };
    return { kind: 'wrong', chart, nearest: variant, missing };
}

const RANK = { fits: 0, close: 1, unsuitable: 2, wrong: 3 } as const;

/** Fewer unused columns is a tighter fit; fewer missing needs is a nearer miss. */
function verdictScore(v: Verdict): [number, number] {
    if (v.kind === 'fits') return [RANK.fits, v.unused.length];
    if (v.kind === 'close') return [RANK.close, v.missing.length];
    if (v.kind === 'unsuitable') return [RANK.unsuitable, 0];
    return [RANK.wrong, v.missing.length];
}

const better = (a: Verdict, b: Verdict): Verdict => {
    const [ar, au] = verdictScore(a);
    const [br, bu] = verdictScore(b);
    if (ar !== br) return ar < br ? a : b;
    return au <= bu ? a : b;
};

/**
 * Does this result fit this chart?
 *
 * Returns the best of the chart's variants, so a grouped bar result is judged
 * as grouped bars rather than measured against the simple case and failed.
 */
export function checkShape(fields: Field[], chart: ChartType, ctx?: ShapeContext): Verdict {
    const shape = shapeFor(chart);
    if (!shape || shape.variants.length === 0) {
        return { kind: 'wrong', chart, nearest: { id: 'none', label: '', needs: [] }, missing: [] };
    }
    const best = shape.variants.map(v => checkVariant(chart, v, fields)).reduce(better);

    // The columns can be right and the chart still meaningless. Checked AFTER
    // matching so the verdict can name the variant it would have been, and only
    // against a fit — telling somebody their box plot needs more rows when it
    // also has no number to plot buries the thing they can act on.
    if (best.kind === 'fits' && shape.distribution) {
        // Grain first, because it is the stronger statement: no number of rows
        // rescues a distribution drawn over one value per group.
        if (ctx?.aggregated) {
            return {
                kind: 'unsuitable',
                chart,
                variant: best.variant,
                reason: 'needs raw rows — this is already one value per group',
            };
        }
        if (ctx?.rowCount != null && ctx.rowCount < MIN_DISTRIBUTION_ROWS) {
            return {
                kind: 'unsuitable',
                chart,
                variant: best.variant,
                reason: `needs more rows — ${ctx.rowCount} is too few to show a distribution`,
            };
        }
    }
    return best;
}

/**
 * What could I chart with this? — every chart type, best first.
 *
 * The reverse of `checkShape` and the more useful direction for somebody who
 * cannot yet say what shape they need. Nearly free: the matcher already answers
 * it per chart type, so this is a map and a sort. Plan §8 filed this under
 * "where a model earns its place" — it does not, the matcher settles it, and a
 * model would only ever add the phrasing.
 *
 * `close` results are kept on purpose. "A bar chart, if you add a count" is a
 * suggestion; dropping it would leave somebody one click from a chart with
 * nothing on screen telling them so.
 */
export function suggestCharts(
    fields: Field[],
    includeClose = true,
    ctx?: ShapeContext,
): Verdict[] {
    // `unsuitable` is dropped alongside `wrong`. It is a real answer to "can I
    // chart this", but this list is a RECOMMENDATION, and a chart that would
    // mislead does not belong in one.
    return allCharts(fields, ctx).filter(v =>
        includeClose ? v.kind === 'fits' || v.kind === 'close' : v.kind === 'fits',
    );
}

/**
 * Every chart with its verdict, best first — including the ones that do not fit.
 *
 * What the gallery needs and `suggestCharts` deliberately will not give it. A
 * gallery is a PICKER, not a recommendation: it shows every mark and says
 * what each one still wants, which is the difference between "your data is
 * wrong" and "add a count and this becomes a bar chart". Keeping both behind
 * one sort means the strip and the gallery can never disagree about which
 * chart is the better fit.
 */
export function allCharts(fields: Field[], ctx?: ShapeContext): Verdict[] {
    return CHART_SHAPES.map(s => checkShape(fields, s.type, ctx)).sort((a, b) => {
        const [ar, au] = verdictScore(a);
        const [br, bu] = verdictScore(b);
        return ar - br || au - bu;
    });
}

/** The encoding a fitting verdict implies, or null when it does not fit. */
export function proposeEncoding(verdict: Verdict): Encoding | null {
    return verdict.kind === 'fits' ? verdict.encoding : null;
}

/** "needs a number to bin" — the phrase a verdict puts in front of somebody. */
export function missingSummary(verdict: Verdict): string | null {
    if (verdict.kind === 'fits') return null;
    if (verdict.kind === 'unsuitable') return verdict.reason;
    return `needs ${verdict.missing.map(m => m.label).join(', and ')}`;
}
