// The chart editor's controls: the other half of `useChartEditor`.
//
// REFINEMENT, not construction (`chart-shape-guidance.md` §7). Every control
// here adjusts a proposal the matcher already made — which column sits on which
// channel, what the axes are called, how they sort and scale, where the legend
// goes, how the numbers read. There is no "add a channel and pick a mark"; that
// is the draw-it-and-find-out loop the feature replaces.
//
// Two things it deliberately does NOT offer, both from plan §9: an aggregate,
// and a time unit. Shaping happens in SQL, where it is visible and reusable,
// and a control here would quietly move it into the spec. The histogram's `bin`
// is the one exception and is shown as a fact about the chart rather than as a
// switch.
//
// BUILDER and JSON are two TABS over one document, not a mode with a door. The
// JSON tab is always reachable; the Builder tab is not — a spec the controls
// cannot model STAYS in JSON, because `readSpec` decides which representation
// is honest for it, not a preference. That tab is then disabled and says why.

import { BookmarkPlus, Braces, Check, MousePointerClick, TriangleAlert } from 'lucide-react';
import PanelSection from './PanelSection';
import { missingSummary, shapeFor, type Channel, type ChannelNeed } from './chart-shapes';
import {
    SCALE_TYPES,
    SORT_ORDERS,
    STACK_MODES,
    type ChannelSpec,
    type ScaleType,
    type SortOrder,
    type StackMode,
} from './chart-spec';
import type { ChartEditor } from './useChartEditor';

/** What each channel is called in front of somebody, rather than in Vega-Lite. */
const CHANNEL_LABEL: Record<Channel, string> = {
    x: 'Across (x)',
    y: 'Up (y)',
    color: 'Colour',
    theta: 'Slice size',
    size: 'Point size',
    // The bullet graph. Named for what they MEAN rather than for the layer they
    // become — "Range 2" would be asking somebody to hold the drawing order in
    // their head, and the order is `buildSpec`'s business.
    label: 'Row label',
    measure: 'Measure',
    target: 'Target',
    range1: 'Poor up to',
    range2: 'Fair up to',
    range3: 'Good up to',
};

const SORT_LABEL: Record<SortOrder, string> = {
    queryOrder: 'As the query returned them',
    ascending: 'A to Z',
    descending: 'Z to A',
    byValueAscending: 'Smallest value first',
    byValueDescending: 'Largest value first',
};

const STACK_LABEL: Record<StackMode, string> = {
    zero: 'Stacked',
    normalize: 'Stacked to 100%',
    none: 'Overlaid',
};

/**
 * Colour schemes, split by what the colour channel is FOR.
 *
 * A categorical scheme on a heatmap's measure gives five unrelated hues for
 * five adjacent numbers, which reads as five unrelated things. Offering the
 * wrong family is how a chart ends up lying about its own data, so the list
 * follows the channel's type rather than being one menu of everything.
 */
const CATEGORICAL = ['tableau10', 'category10', 'set2', 'dark2', 'accent'];
const SEQUENTIAL = ['blues', 'viridis', 'magma', 'oranges', 'greys'];

export interface ChartEditorPanelProps {
    editor: ChartEditor;
    /**
     * Keep this spec as a reusable template.
     *
     * The host owns the list, so it owns the naming dialog too. Rendered on the
     * JSON tab ONLY (Ben, 2026-09-14): a chart built from the controls is
     * already one of the gallery's shapes, so saving it as a "custom" chart
     * would be keeping a template of something that is not custom. The
     * hand-written spec is the one the controls cannot rebuild.
     */
    onSaveCustom?: () => void;
}

export default function ChartEditorPanel({ editor, onSaveCustom }: ChartEditorPanelProps) {
    const { state, verdict, needs, missing } = editor;

    if (editor.mode === 'json') return <JsonEditor editor={editor} onSaveCustom={onSaveCustom} />;
    if (!state) return null;

    const shape = shapeFor(state.chart);
    const hasColor = !!state.encoding.color;
    // `barh` stacks along x rather than up y, but that is `buildSpec`'s
    // business — here it is simply another chart that can stack.
    const canStack =
        (state.chart === 'bar' || state.chart === 'barh' || state.chart === 'area') && hasColor;
    const canPoint = state.chart === 'line' || state.chart === 'area';

    return (
        <div className="blk-ced">
            <Tabs editor={editor} />
            <div className="blk-ced-head">
                <span className="blk-ced-title">
                    {shape?.label ?? state.chart}
                    {verdict?.kind === 'fits' ? <small>{verdict.variant.label}</small> : null}
                </span>
                {/* No Template button here (Ben, 2026-09-14): a chart built from
                    the controls is already one of the gallery's shapes, so
                    keeping it as a "custom" chart would be saving a template of
                    something that is not custom. It lives on the JSON tab, where
                    the spec is the thing the controls cannot rebuild.

                    No Change chart either — that moved to the Charts bar, beside
                    Save as dive, where the other whole-chart actions are. */}
            </div>

            {/* The query was edited after the chart was built. Vega-Lite draws
                that as an EMPTY chart rather than an error, so without this
                somebody is left staring at a blank panel. */}
            {missing.length > 0 ? (
                <div className="blk-note blk-note--warn">
                    <TriangleAlert size={14} />
                    <span>
                        The result no longer has <strong>{missing.join(', ')}</strong>. Put another
                        column on that channel, or bring the column back in the SQL step.
                    </span>
                </div>
            ) : null}

            {verdict && verdict.kind !== 'fits' ? (
                <div className="blk-note blk-note--warn">
                    <TriangleAlert size={14} />
                    <span>
                        This result {missingSummary(verdict)}.
                    </span>
                </div>
            ) : null}

            <PanelSection title="Titles" storageKey="duckle.chart.titles">
                <label className="blk-ced-field">
                    <span>Title</span>
                    <input
                        value={state.title ?? ''}
                        placeholder="Untitled chart"
                        onChange={e => editor.setTitle(e.target.value)}
                    />
                </label>
                <label className="blk-ced-field">
                    <span>Subtitle</span>
                    <input
                        value={state.subtitle ?? ''}
                        placeholder="Optional"
                        onChange={e => editor.setSubtitle(e.target.value)}
                    />
                </label>
            </PanelSection>

            <PanelSection
                title="Channels"
                storageKey="duckle.chart.channels"
                badge={needs.filter(n => !!state.encoding[n.channel]).length}
            >
                {needs.map(need => (
                    <ChannelRow key={need.channel} need={need} editor={editor} />
                ))}
            </PanelSection>

            {canStack || hasColor || canPoint ? (
                <PanelSection title="Chart options" storageKey="duckle.chart.options">
                    {canStack ? (
                        <label className="blk-ced-field">
                            <span>Bars</span>
                            <select
                                value={state.stack ?? 'zero'}
                                onChange={e => editor.setStack(e.target.value as StackMode)}
                            >
                                {STACK_MODES.map(m => (
                                    <option key={m} value={m}>
                                        {STACK_LABEL[m]}
                                    </option>
                                ))}
                            </select>
                        </label>
                    ) : null}
                    {hasColor ? (
                        <label className="blk-ced-field">
                            <span>Colours</span>
                            <select
                                value={state.scheme ?? ''}
                                onChange={e => editor.setScheme(e.target.value || undefined)}
                            >
                                <option value="">Duckle palette</option>
                                {(state.encoding.color?.type === 'quantitative'
                                    ? SEQUENTIAL
                                    : CATEGORICAL
                                ).map(s => (
                                    <option key={s} value={s}>
                                        {s}
                                    </option>
                                ))}
                            </select>
                        </label>
                    ) : null}
                    {canPoint ? (
                        <label className="blk-ced-check">
                            <input
                                type="checkbox"
                                checked={!!state.points}
                                onChange={e => editor.setPoints(e.target.checked)}
                            />
                            <span>Mark each data point</span>
                        </label>
                    ) : null}
                </PanelSection>
            ) : null}
        </div>
    );
}

/** One channel: which column is on it, and how that axis or legend reads. */
function ChannelRow({ need, editor }: { need: ChannelNeed; editor: ChartEditor }) {
    const c: ChannelSpec | undefined = editor.state?.encoding[need.channel];
    const options = editor.optionsFor(need.channel);
    const positional = need.channel === 'x' || need.channel === 'y';
    const sortable = positional && (c?.type === 'nominal' || c?.type === 'ordinal');
    const scalable = positional && c?.type === 'quantitative';
    const legendable = need.channel === 'color' || need.channel === 'size';

    const set = (patch: Partial<ChannelSpec>) => editor.setChannelOption(need.channel, patch);

    return (
        <div className={`blk-ced-ch${c ? '' : ' blk-ced-ch--empty'}`}>
            <div className="blk-ced-field">
                <span>
                    {CHANNEL_LABEL[need.channel]}
                    {need.required ? null : <small> optional</small>}
                </span>
                {/* A count has no column behind it, so there is nothing to pick.
                    Said rather than shown as an empty select. */}
                {c?.count ? (
                    <span className="blk-ced-fixed">
                        number of rows in each bin
                        <small>binned by the spec, not by the SQL</small>
                    </span>
                ) : (
                    <select
                        value={c?.field ?? ''}
                        onChange={e => editor.setChannel(need.channel, e.target.value || null)}
                    >
                        {/* Only for an optional channel: a required one has no
                            empty state that still draws anything. */}
                        {need.required ? null : <option value="">— none —</option>}
                        {c?.field && !options.some(o => o.field === c.field) ? (
                            // The column has gone from the result. Kept in the
                            // list so the select shows what the spec still says
                            // rather than silently reading as the first option.
                            <option value={c.field}>{c.field} (missing)</option>
                        ) : null}
                        {options.map(o => (
                            <option key={o.field} value={o.field}>
                                {o.field}
                                {o.taken ? ` (on ${o.taken})` : ''}
                            </option>
                        ))}
                    </select>
                )}
            </div>

            {!c ? (
                <p className="blk-ced-hint">Add {need.label}.</p>
            ) : (
                <div className="blk-ced-opts">
                    <label className="blk-ced-field">
                        <span>Label</span>
                        <input
                            value={c.title ?? ''}
                            placeholder={c.count ? 'Count' : (c.field ?? '')}
                            disabled={c.title === null}
                            onChange={e => set({ title: e.target.value })}
                        />
                    </label>
                    <label className="blk-ced-check">
                        <input
                            type="checkbox"
                            checked={c.title === null}
                            onChange={e => set({ title: e.target.checked ? null : undefined })}
                        />
                        <span>Hide label</span>
                    </label>

                    {sortable ? (
                        <label className="blk-ced-field">
                            <span>Order</span>
                            <select
                                value={c.sort ?? ''}
                                onChange={e =>
                                    set({ sort: (e.target.value || undefined) as SortOrder })
                                }
                            >
                                {/* Vega-Lite's default for a category axis is
                                    alphabetical, NOT the order the rows came
                                    in — so an ORDER BY in the SQL is thrown
                                    away unless "As the query returned them" is
                                    chosen. Labelled honestly rather than as
                                    "default", which read as "unchanged". */}
                                <option value="">Alphabetical (Vega-Lite default)</option>
                                {SORT_ORDERS.map(s => (
                                    <option key={s} value={s}>
                                        {SORT_LABEL[s]}
                                    </option>
                                ))}
                            </select>
                        </label>
                    ) : null}

                    {scalable ? (
                        <>
                            <label className="blk-ced-field">
                                <span>Scale</span>
                                <select
                                    value={c.scaleType ?? 'linear'}
                                    onChange={e => set({ scaleType: e.target.value as ScaleType })}
                                >
                                    {SCALE_TYPES.map(s => (
                                        <option key={s} value={s}>
                                            {s}
                                        </option>
                                    ))}
                                </select>
                            </label>
                            {/* A log axis cannot include zero, so the choice
                                does not exist there. Offering it would be a
                                control whose only effect is a Vega-Lite warning
                                — see `chart-spec.vega.test.ts`. */}
                            {c.scaleType === 'log' ? (
                                <p className="blk-ced-hint">A log axis never starts at zero.</p>
                            ) : (
                                <label className="blk-ced-check">
                                    <input
                                        type="checkbox"
                                        checked={c.zero !== false}
                                        onChange={e =>
                                            set({ zero: e.target.checked ? undefined : false })
                                        }
                                    />
                                    <span>Start the axis at zero</span>
                                </label>
                            )}
                        </>
                    ) : null}

                    <label className="blk-ced-field">
                        <span>Number format</span>
                        <input
                            value={c.format ?? ''}
                            // The two formats somebody actually wants, by type:
                            // thousands separators on a measure, a readable
                            // month on a date.
                            placeholder={c.type === 'temporal' ? '%b %Y' : ',.0f'}
                            onChange={e => set({ format: e.target.value || undefined })}
                        />
                    </label>

                    {legendable ? (
                        <label className="blk-ced-check">
                            <input
                                type="checkbox"
                                checked={c.legend !== false}
                                onChange={e => set({ legend: e.target.checked ? undefined : false })}
                            />
                            <span>Show the legend</span>
                        </label>
                    ) : null}
                </div>
            )}
        </div>
    );
}

/**
 * The spec as text.
 *
 * Reachable at any time and not a one-way door: `Use these controls` tries to
 * read the JSON back, and says plainly when it cannot rather than flattening
 * what it does not understand.
 */
function JsonEditor({
    editor,
    onSaveCustom,
}: {
    editor: ChartEditor;
    onSaveCustom?: () => void;
}) {
    return (
        <div className="blk-ced">
            <Tabs editor={editor} />
            <div className="blk-ced-head">
                <span className="blk-ced-title">
                    Vega-Lite spec
                    <small>{editor.jsonOnly ? 'beyond the controls' : 'edited by hand'}</small>
                </span>
                <span className="blk-bar-spacer" />
                {/* Template lives ONLY on this tab. A chart built from the
                    controls is already one of the gallery's shapes; a
                    hand-written spec is the one the controls cannot rebuild,
                    and so the only one worth keeping as a custom chart. */}
                {onSaveCustom ? (
                    <button
                        type="button"
                        className="erd-btn"
                        onClick={onSaveCustom}
                        title="Keep this spec as a custom chart, reusable over any result of the same shape"
                    >
                        <BookmarkPlus size={14} /> Template
                    </button>
                ) : null}
                <button
                    type="button"
                    className="erd-btn erd-btn--accent"
                    onClick={() => editor.applyJson()}
                    title="Use this spec, and open it in the controls if they can model it"
                >
                    <Check size={14} /> Apply
                </button>
            </div>

            {editor.jsonError ? (
                <div className="blk-note blk-note--warn">
                    <TriangleAlert size={14} />
                    <span>{editor.jsonError}</span>
                </div>
            ) : editor.jsonOnly ? (
                <div className="blk-note">
                    <MousePointerClick size={14} />
                    <span>
                        This spec does something the controls do not model — a transform, a layer,
                        or an encoding they would drop. It stays here, where nothing is lost.
                    </span>
                </div>
            ) : null}

            <textarea
                className="blk-ced-json"
                value={editor.json}
                spellCheck={false}
                onChange={e => editor.setJson(e.target.value)}
                placeholder="{ }"
            />
        </div>
    );
}

/**
 * Builder | JSON, as tabs.
 *
 * Ben asked for tabs (2026-09-14), and they are better than the button pair
 * they replace for a reason worth stating: with a "JSON" button, LEAVING was a
 * different gesture from arriving and had to be discovered — and the moment you
 * most want to leave is when the spec is broken and Apply refuses. As tabs,
 * going back is the same click that got you there, so the earlier
 * "Back to controls" button is gone; this is that door, better placed.
 *
 * The JSON tab is always available; the BUILDER tab is not. A spec the controls
 * cannot model has no other representation — `cancelJson` is null then — so the
 * tab is disabled and says why, rather than throwing the spec away to show an
 * empty form.
 */
function Tabs({ editor }: { editor: ChartEditor }) {
    const gui = editor.mode === 'gui';
    return (
        <div className="blk-ced-tabs" role="tablist">
            <button
                type="button"
                role="tab"
                aria-selected={gui}
                className={`blk-ced-tab${gui ? ' blk-ced-tab--on' : ''}`}
                onClick={editor.cancelJson ?? undefined}
                disabled={gui || !editor.cancelJson}
                title={
                    gui || editor.cancelJson
                        ? 'Adjust the chart with controls'
                        : editor.jsonOnly
                          ? 'This spec does something the controls cannot model, so there is no form for it'
                          : // A spec nobody has applied yet — a fresh custom
                            // chart. Saying "the controls cannot model it" here
                            // would be a claim about a spec that has not been
                            // read, and it might model perfectly well.
                            'Apply this spec first — the controls open on it if they can model it'
                }
            >
                <MousePointerClick size={13} /> Builder
            </button>
            <button
                type="button"
                role="tab"
                aria-selected={!gui}
                className={`blk-ced-tab${gui ? '' : ' blk-ced-tab--on'}`}
                onClick={editor.editAsJson}
                disabled={!gui}
                title="Edit the Vega-Lite spec directly"
            >
                <Braces size={13} /> JSON
            </button>
        </div>
    );
}
