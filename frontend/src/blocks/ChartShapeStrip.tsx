// What you could chart with this result, sitting under the result itself.
//
// Placement is the point (plan `chart-shape-guidance.md` §6). A judgement about
// the data belongs beside the data, where somebody looking at a grid of numbers
// sees it without remembering that a tab exists. The chart-type PICKER lives in
// the right-hand pane; this is only the verdict.
//
// Above the grid rather than below it: "under the results" in the plan meant
// "with the results", and below a scrolling grid is a place you have to go
// looking for. One line, so it costs almost nothing to keep on screen.
//
// Works on ANY result — hand-written SQL, an AI draft, a built query — because
// it reads `SqlRunResult.columns` and nothing else. That is why it ships before
// the pane work: no new surface, and it is useful the moment it exists.

import {
    ChartArea,
    ChartCandlestick,
    ChartColumn,
    ChartColumnBig,
    ChartLine,
    ChartPie,
    ChartScatter,
    Grid3x3,
    type LucideIcon,
} from 'lucide-react';
import type { SqlStudioColumn } from '../sqleditor/types';
import {
    checkShape,
    fieldsFromColumns,
    missingSummary,
    shapeFor,
    suggestCharts,
    type ChartType,
    type ShapeContext,
    type Verdict,
} from './chart-shapes';

const ICONS: Record<ChartType, LucideIcon> = {
    bar: ChartColumn,
    histogram: ChartColumnBig,
    line: ChartLine,
    area: ChartArea,
    point: ChartScatter,
    arc: ChartPie,
    // A candlestick is the closest thing lucide has to a box plot, and it reads
    // as one at 13px — boxes on a scale.
    boxplot: ChartCandlestick,
    rect: Grid3x3,
};

/** How many near misses to show. Past two it stops being advice and becomes a list. */
const MAX_NEAR = 2;

export interface ChartShapeStripProps {
    columns: SqlStudioColumn[];
    /**
     * Rows in the result.
     *
     * Not decoration: a box plot or histogram over a handful of rows renders
     * fine and reports quartiles computed from two points each, so the count is
     * part of whether the chart is worth offering at all.
     */
    rowCount?: number;
    /**
     * The result is one row per group — a GROUP BY, not a window function.
     *
     * Undefined for hand-written SQL, where telling the two apart would mean
     * parsing; unknown stays unknown rather than being guessed.
     */
    aggregated?: boolean;
    /** Once a chart type is chosen, judge that one instead of listing. */
    chart?: ChartType;
    /** Wired by the picker. Without it the chips are labels, not controls. */
    onPick?: (chart: ChartType) => void;
}

export default function ChartShapeStrip({
    columns,
    rowCount,
    aggregated,
    chart,
    onPick,
}: ChartShapeStripProps) {
    const fields = fieldsFromColumns(columns);
    const ctx = { rowCount, aggregated };

    if (fields.length === 0) {
        return (
            <div className="blk-shape">
                <span className="blk-shape-lbl">Available charts</span>
                <span className="blk-shape-none">
                    {columns.length === 0
                        ? 'No columns to plot.'
                        : 'No column here can go on a chart.'}
                </span>
            </div>
        );
    }

    if (chart) return <ChosenChart fields={fields} chart={chart} ctx={ctx} />;

    const suggestions = suggestCharts(fields, true, ctx);
    const fits = suggestions.filter(v => v.kind === 'fits');
    const near = suggestions.filter(v => v.kind === 'close').slice(0, MAX_NEAR);

    return (
        <div className="blk-shape">
            <span className="blk-shape-lbl">Available charts</span>
            {fits.length === 0 ? (
                <span className="blk-shape-none">Nothing fits this shape yet.</span>
            ) : (
                fits.map(v => <Chip key={v.chart} verdict={v} onPick={onPick} />)
            )}
            {near.map(v => (
                <span key={v.chart} className="blk-shape-near">
                    {shapeFor(v.chart)?.label} {missingSummary(v)}
                </span>
            ))}
        </div>
    );
}

function Chip({ verdict, onPick }: { verdict: Verdict; onPick?: (c: ChartType) => void }) {
    const Icon = ICONS[verdict.chart];
    const label = shapeFor(verdict.chart)?.label ?? verdict.chart;
    // The variant is what actually matched, so it is what the tooltip should
    // say — "Bars per category" tells you more than "Bar chart" about why this
    // is being offered.
    const title =
        verdict.kind === 'fits'
            ? `${verdict.variant.label}${
                  verdict.unused.length > 0
                      ? ` · not shown: ${verdict.unused.join(', ')}`
                      : ''
              }`
            : label;

    const body = (
        <>
            <Icon size={13} strokeWidth={1.9} />
            {label}
        </>
    );

    return onPick ? (
        <button
            type="button"
            className="blk-shape-chip"
            onClick={() => onPick(verdict.chart)}
            title={title}
        >
            {body}
        </button>
    ) : (
        <span className="blk-shape-chip" title={title}>
            {body}
        </span>
    );
}

/** The verdict for one chosen chart: does this result fit it, and if not, why. */
function ChosenChart({
    fields,
    chart,
    ctx,
}: {
    fields: ReturnType<typeof fieldsFromColumns>;
    chart: ChartType;
    ctx?: ShapeContext;
}) {
    const v = checkShape(fields, chart, ctx);
    const label = shapeFor(chart)?.label ?? chart;
    const Icon = ICONS[chart];

    if (v.kind === 'fits') {
        const used = Object.entries(v.encoding).map(([ch, e]) => `${ch}: ${e.field}`);
        return (
            <div className="blk-shape">
                <span className="blk-shape-lbl">Available charts</span>
                <span className="blk-shape-ok">
                    <Icon size={13} strokeWidth={1.9} /> {label} · {v.variant.label}
                </span>
                <span className="blk-shape-enc">{used.join('  ·  ')}</span>
                {v.unused.length > 0 ? (
                    <span className="blk-shape-near">not shown: {v.unused.join(', ')}</span>
                ) : null}
            </div>
        );
    }

    // Name the fix, never just the failure. "Wrong shape" tells somebody they
    // are stuck; "needs a number" tells them what to add.
    return (
        <div className="blk-shape">
            <span className="blk-shape-lbl">Available charts</span>
            <span className="blk-shape-bad">
                <Icon size={13} strokeWidth={1.9} /> {label} {missingSummary(v)}
            </span>
        </div>
    );
}
