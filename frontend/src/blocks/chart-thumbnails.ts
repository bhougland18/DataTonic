// The gallery's chart thumbnails — real Vega-Lite specs over CANNED data.
//
// `DAA.100` asked for this rather than image assets, and the reason holds up:
// an asset is a picture of what the renderer used to do. A thumbnail drawn by
// the same `VegaChart` the chart itself uses picks up the brand palette, the
// light/dark config and any future mark styling automatically, and can never
// depict a chart this build cannot draw.
//
// These are the ONE place a spec legitimately carries `data`, `width` and
// `height`. A thumbnail is decoration with a fixed size and no query behind it,
// which is the exact opposite of `chart-spec.ts`'s documents — those stay free
// of all three so they can be re-rendered at any size against live rows. Do not
// read these as an example of how to write a block's chart.

import type { DiveChart } from '../dives/dive-types';
import type { ChartType } from './chart-shapes';

const W = 76;
const H = 46;

/** Five categories with uneven values, so a bar chart reads as one at 46px. */
const CATEGORIES = [
    { c: 'A', v: 8 },
    { c: 'B', v: 5 },
    { c: 'C', v: 13 },
    { c: 'D', v: 3 },
    { c: 'E', v: 9 },
];

/** A short monthly series. Rising then dipping, so a line has a shape. */
const SERIES = [
    { t: '2026-01-01', v: 4 },
    { t: '2026-02-01', v: 9 },
    { t: '2026-03-01', v: 6 },
    { t: '2026-04-01', v: 12 },
    { t: '2026-05-01', v: 10 },
];

const POINTS = [
    { x: 1, y: 3 },
    { x: 2, y: 6 },
    { x: 3, y: 4 },
    { x: 4, y: 9 },
    { x: 5, y: 7 },
    { x: 6, y: 11 },
];

/** Right-skewed, so the bins are visibly uneven and the box is off-centre. */
const SPREAD = [1, 2, 2, 3, 3, 3, 3, 4, 4, 5, 5, 7, 9, 12, 14].map(v => ({ v }));

const GRID = ['A', 'B', 'C'].flatMap((a, i) =>
    ['X', 'Y', 'Z'].map((b, j) => ({ a, b, v: (i + 1) * (j + 2) })),
);

/**
 * Two bullets, one over target and one well under.
 *
 * Both states on the card, because "did it clear the mark" is the only question
 * a bullet graph answers and a thumbnail showing two passes does not say so.
 */
const BULLETS = [
    { c: 'A', r1: 4, r2: 8, r3: 12, v: 10, t: 8 },
    { c: 'B', r1: 4, r2: 8, r3: 12, v: 5, t: 9 },
];

/** Three short series with visibly different SHAPES — rising, dipping, flat-ish. */
const SPARKS = ['A', 'B', 'C'].flatMap((c, i) =>
    [0, 1, 2, 3, 4, 5, 6].map(t => ({
        c,
        t,
        v: [t * t, 20 - t * 2 + (t % 2) * 5, 8 + ((t * 5) % 7)][i],
    })),
);

/** No axes, no legend, no frame: at this size every one of them is noise. */
const BARE = { axis: null };

const bulletThumbX = (field: string) => ({ field, type: 'quantitative', ...BARE });

function thumb(
    values: Record<string, unknown>[],
    mark: DiveChart['mark'],
    encoding: Record<string, unknown>,
): DiveChart {
    return {
        data: { values },
        mark,
        encoding,
        width: W,
        height: H,
        padding: 2,
        // `view.stroke` again rather than relying on `VegaChart`'s config: the
        // thumbnails also render inside the gallery's own buttons, and a stray
        // 1px frame around every card is the kind of thing that reads as a bug.
        config: { view: { stroke: null } },
    };
}

/**
 * The thumbnail for one chart type.
 *
 * Built fresh on each call rather than held in a frozen table, because
 * `VegaChart` spreads the spec and vega-embed is free to mutate what it is
 * given — a shared object would accumulate whatever the renderer left behind.
 */
export function thumbSpec(chart: ChartType): DiveChart {
    switch (chart) {
        case 'bar':
            return thumb(CATEGORIES, 'bar', {
                x: { field: 'c', type: 'nominal', ...BARE },
                y: { field: 'v', type: 'quantitative', ...BARE },
            });
        case 'barh':
            // Sorted on the card too. The thumbnail is how somebody recognises
            // the chart, and "ranked" is the recognisable part — an unsorted
            // sideways bar chart looks like a bar chart that fell over.
            return thumb(CATEGORIES, 'bar', {
                y: { field: 'c', type: 'nominal', sort: '-x', ...BARE },
                x: { field: 'v', type: 'quantitative', ...BARE },
            });
        case 'histogram':
            return thumb(SPREAD, 'bar', {
                x: { field: 'v', type: 'quantitative', bin: { maxbins: 6 }, ...BARE },
                y: { aggregate: 'count', type: 'quantitative', ...BARE },
            });
        case 'line':
            return thumb(SERIES, 'line', {
                x: { field: 't', type: 'temporal', ...BARE },
                y: { field: 'v', type: 'quantitative', ...BARE },
            });
        case 'area':
            return thumb(SERIES, 'area', {
                x: { field: 't', type: 'temporal', ...BARE },
                y: { field: 'v', type: 'quantitative', ...BARE },
            });
        case 'point':
            return thumb(POINTS, { type: 'point', filled: true, size: 22 }, {
                x: { field: 'x', type: 'quantitative', ...BARE },
                y: { field: 'y', type: 'quantitative', ...BARE },
            });
        case 'arc':
            return thumb(CATEGORIES, 'arc', {
                theta: { field: 'v', type: 'quantitative' },
                color: { field: 'c', type: 'nominal', legend: null },
            });
        case 'rect':
            return thumb(GRID, 'rect', {
                x: { field: 'a', type: 'nominal', ...BARE },
                y: { field: 'b', type: 'nominal', ...BARE },
                color: { field: 'v', type: 'quantitative', legend: null },
            });
        case 'boxplot':
            return thumb(SPREAD, { type: 'boxplot', size: 16 }, {
                y: { field: 'v', type: 'quantitative', ...BARE },
            });
        case 'bullet':
            // The only LAYERED thumbnail, so it cannot go through `thumb`. Kept
            // in step with `bulletSpec`'s colours by `chart-spec.test.ts`, which
            // is the honest way to share them — exporting the constants would
            // invite a second builder.
            return {
                data: { values: BULLETS },
                encoding: { y: { field: 'c', type: 'nominal', sort: null, ...BARE } },
                layer: [
                    { mark: { type: 'bar', color: '#ccd2dc' }, encoding: { x: bulletThumbX('r3') } },
                    { mark: { type: 'bar', color: '#adb5c2' }, encoding: { x: bulletThumbX('r2') } },
                    { mark: { type: 'bar', color: '#8b95a8' }, encoding: { x: bulletThumbX('r1') } },
                    {
                        mark: { type: 'bar', color: '#2eafff', size: 4 },
                        encoding: { x: bulletThumbX('v') },
                    },
                    {
                        mark: { type: 'tick', color: '#ff7a45', thickness: 2 },
                        encoding: { x: bulletThumbX('t') },
                    },
                ],
                width: W,
                height: H,
                padding: 2,
                config: { view: { stroke: null } },
            };
        case 'sparkline':
            // The only FACETED thumbnail. Three rows at 10px rather than the
            // real 22 — the card has 46px to say "a stack of little lines",
            // and two rows would read as a comparison instead of a list.
            return {
                data: { values: SPARKS },
                facet: { row: { field: 'c', type: 'nominal', header: null, sort: null } },
                spacing: 2,
                spec: {
                    width: W,
                    height: 10,
                    view: { stroke: null },
                    mark: {
                        type: 'line',
                        color: '#2eafff',
                        strokeWidth: 1.5,
                        interpolate: 'monotone',
                    },
                    encoding: {
                        x: { field: 't', type: 'quantitative', axis: null },
                        y: { field: 'v', type: 'quantitative', axis: null, scale: { zero: false } },
                    },
                },
                padding: 2,
                config: { view: { stroke: null } },
            };
    }
}
