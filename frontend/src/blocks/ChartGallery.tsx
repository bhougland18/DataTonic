// The chart gallery: every mark, drawn, with what each one needs.
//
// `DAA.100`. Cards rather than a dropdown because the question it answers is
// visual — somebody who cannot say "grouped bar chart" can still point at one —
// and because the alternative was a list of names beside a chart nobody has
// seen yet.
//
// THE PERSON PICKS. Nothing here selects a chart on arrival, which is the
// decision `chart-editor-handoff.md` §3 records: Duckle's older behaviour of
// taking the first shape that fits and drawing it is the thing being replaced.
// A chart that appears without being asked for is a claim about what the data
// means, and that claim is the user's to make.
//
// Charts that do NOT fit stay on the wall, greyed, saying what they still want.
// That is the whole reason `checkShape` has four verdicts rather than two: "you
// have the category, now add a count" is the most useful thing this feature can
// say, and it can only be said next to the bar chart it is about.

import { useMemo } from 'react';
import { Braces, Check, Trash2 } from 'lucide-react';
import { VegaChart } from '../dives/VegaChart';
import { missingSummary, shapeFor, type ChartType, type Verdict } from './chart-shapes';
import { thumbSpec } from './chart-thumbnails';
import {
    customSummary,
    customThumb,
    type CustomChart,
    type CustomVerdict,
} from './custom-charts';

export interface ChartGalleryProps {
    /** Every chart with its verdict, best first — `useChartEditor`'s `charts`. */
    charts: Verdict[];
    /** The chart being edited, so its card reads as chosen. */
    chosen?: ChartType | null;
    onPick: (chart: ChartType) => void;
    theme?: 'light' | 'dark';
    /** Said once, above the wall, rather than once per card. */
    note?: string;
    /** Saved templates, shown BELOW the built-ins in their own area. */
    customs?: CustomVerdict[];
    onPickCustom?: (custom: CustomChart) => void;
    onDeleteCustom?: (id: string) => void;
    /** Author one from scratch, in the JSON editor. */
    onNewCustom?: () => void;
}

export default function ChartGallery({
    charts,
    chosen,
    onPick,
    theme = 'dark',
    note,
    customs,
    onPickCustom,
    onDeleteCustom,
    onNewCustom,
}: ChartGalleryProps) {
    const fits = useMemo(() => charts.filter(v => v.kind === 'fits').length, [charts]);

    return (
        <div className="blk-gal">
            <div className="blk-gal-head">
                <span className="blk-gal-lbl">
                    {fits === 0
                        ? 'No chart fits this result yet'
                        : `${fits} chart${fits === 1 ? '' : 's'} fit this result`}
                </span>
                {note ? <span className="blk-gal-note">{note}</span> : null}
            </div>
            <div className="blk-gal-grid">
                {charts.map(v => (
                    <Card
                        key={v.chart}
                        verdict={v}
                        chosen={v.chart === chosen}
                        onPick={onPick}
                        theme={theme}
                    />
                ))}
            </div>

            {/* BELOW the built-ins, in their own area — where Ben asked for
                them. Kept a separate section rather than mixed into the grid
                because the two are not the same kind of offer: the built-ins
                are a closed set this build understands, and these are whatever
                somebody saved. */}
            {onNewCustom || (customs && customs.length > 0) ? (
                <>
                    <div className="blk-gal-head blk-gal-head--sub">
                        <span className="blk-gal-lbl">Custom charts</span>
                        <span className="blk-gal-note">
                            {customs && customs.length > 0
                                ? 'Your saved specs, matched to this result by shape rather than by column name.'
                                : 'Write Vega-Lite by hand when none of the above is the picture you want.'}
                        </span>
                    </div>
                    {onNewCustom ? (
                        <div className="blk-gal-new">
                            <button
                                type="button"
                                className="erd-btn"
                                onClick={onNewCustom}
                                title="Write a Vega-Lite spec by hand, seeded with this result's columns"
                            >
                                <Braces size={14} /> Custom Chart
                            </button>
                        </div>
                    ) : null}
                    {customs && customs.length > 0 && onPickCustom ? (
                        <div className="blk-gal-grid">
                            {customs.map(v => (
                                <CustomCard
                                    key={v.custom.id}
                                    verdict={v}
                                    onPick={onPickCustom}
                                    onDelete={onDeleteCustom}
                                    theme={theme}
                                />
                            ))}
                        </div>
                    ) : null}
                </>
            ) : null}
        </div>
    );
}

function Card({
    verdict,
    chosen,
    onPick,
    theme,
}: {
    verdict: Verdict;
    chosen: boolean;
    onPick: (chart: ChartType) => void;
    theme: 'light' | 'dark';
}) {
    const label = shapeFor(verdict.chart)?.label ?? verdict.chart;
    // A fit is what carries the column-to-channel assignment, so it is also
    // what makes a card pickable: the Charts step refines a proposal, it does
    // not hand-assemble an encoding for data that cannot support the chart.
    const fits = verdict.kind === 'fits';
    // The variant is what actually matched, so it is what to say — "Bars per
    // category" tells you more about why this is being offered than "Bar chart".
    const detail = fits ? verdict.variant.label : missingSummary(verdict);
    const spec = useMemo(() => thumbSpec(verdict.chart), [verdict.chart]);

    return (
        <button
            type="button"
            className={`blk-gal-card${fits ? '' : ' blk-gal-card--off'}${
                chosen ? ' blk-gal-card--on' : ''
            }`}
            onClick={() => fits && onPick(verdict.chart)}
            disabled={!fits}
            title={fits ? `${label} — ${detail}` : `${label} ${detail ?? ''}`}
            aria-pressed={chosen}
        >
            <span className="blk-gal-thumb">
                {/* No rows: a thumbnail is a spec over canned data, and binding
                    the result's rows here would draw the user's data once per card
                    at 46px. See `chart-thumbnails.ts`. */}
                <VegaChart spec={spec} theme={theme} className="blk-gal-vega" />
            </span>
            <span className="blk-gal-name">
                {label}
                {chosen ? <Check size={12} strokeWidth={2.4} /> : null}
            </span>
            <span className="blk-gal-why">{detail}</span>
        </button>
    );
}

/**
 * One saved template.
 *
 * Pickable even when it does not fit, which is the opposite of the built-in
 * cards and deliberately so. A built-in that does not fit has nothing to offer
 * — there is no encoding to propose. A template always has its own field names,
 * so loading it and correcting them by hand is a real route, and it is the only
 * route for a layered spec with no contract to read. The card says which it is.
 */
function CustomCard({
    verdict,
    onPick,
    onDelete,
    theme,
}: {
    verdict: CustomVerdict;
    onPick: (custom: CustomChart) => void;
    onDelete?: (id: string) => void;
    theme: 'light' | 'dark';
}) {
    const { custom } = verdict;
    const fits = verdict.kind === 'fits';
    const detail = fits ? 'Ready for this result' : customSummary(verdict);
    // Drawn from the template itself over invented rows, so the card shows the
    // chart rather than its name. Null when there is no contract to invent rows
    // for — a layered spec — and the card then falls back to a label.
    const thumb = useMemo(() => customThumb(custom.spec), [custom.spec]);

    return (
        <div
            className={`blk-gal-card blk-gal-card--custom${
                fits ? '' : ' blk-gal-card--warn'
            }`}
        >
            <button
                type="button"
                className="blk-gal-pick"
                onClick={() => onPick(custom)}
                title={
                    fits
                        ? `${custom.name} — ${detail}`
                        : `${custom.name} — ${detail}. Loads anyway, so the columns can be set by hand.`
                }
            >
                <span className="blk-gal-thumb">
                    {thumb ? (
                        <VegaChart spec={thumb} theme={theme} className="blk-gal-vega" />
                    ) : (
                        <span className="blk-gal-noThumb">spec</span>
                    )}
                </span>
                <span className="blk-gal-name">{custom.name}</span>
                <span className="blk-gal-why">{detail}</span>
            </button>
            {onDelete ? (
                <button
                    type="button"
                    className="blk-gal-del"
                    onClick={() => onDelete(custom.id)}
                    title={`Delete the "${custom.name}" template`}
                    aria-label={`Delete ${custom.name}`}
                >
                    <Trash2 size={12} />
                </button>
            ) : null}
        </div>
    );
}
