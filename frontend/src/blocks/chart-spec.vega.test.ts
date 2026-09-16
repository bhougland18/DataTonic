// Every spec this module can produce, put through the REAL vega-lite compiler.
//
// The rest of `chart-spec.test.ts` asserts the shape of the JSON, which only
// ever proves the JSON is what this file meant to write. It cannot catch the
// failure that actually matters: valid-looking JSON that Vega-Lite rejects, or
// accepts with a warning and then draws as an empty panel. `sort: '-y'` on the
// wrong channel and a `stack` on a mark that cannot stack are both of that kind.
//
// So the compiler is the oracle, exactly as `builder-sql.ts`'s generated SQL is
// checked against a real DuckDB rather than against a string. A warning counts
// as a failure here — Vega-Lite warns for "this channel is being ignored",
// which is the silent-empty-chart case.

import { describe, expect, it } from 'vitest';
import { compile } from 'vega-lite';
import * as vega from 'vega';
import {
    CHART_SHAPES,
    checkShape,
    fieldsFromColumns,
    identifierColumns,
    type Field,
} from './chart-shapes';
import { thumbSpec } from './chart-thumbnails';
import { buildSpec, readSpec, stateFromVerdict, type ChartSpecState } from './chart-spec';

const f = (name: string, vlType: Field['vlType']): Field => ({ name, vlType });

/**
 * Columns covering every type, so each chart's contract can be satisfied.
 *
 * Deliberately shaped like a real result rather than minimally: `Item.AddedDate`
 * is a real DATE since `2af12706`, which is what makes the temporal charts
 * testable at all.
 */
const FIELDS = [
    f('Vendor', 'nominal'),
    f('Site', 'nominal'),
    f('AddedDate', 'temporal'),
    f('count Item.Item', 'quantitative'),
    f('UnitCost', 'quantitative'),
];

/** Compile a spec, failing on a warning as well as on an error. */
function compileIssues(spec: Record<string, unknown>): string[] {
    const issues: string[] = [];
    const log = {
        level() {
            return this;
        },
        error(...m: unknown[]) {
            issues.push(`error: ${m.join(' ')}`);
            return this;
        },
        warn(...m: unknown[]) {
            issues.push(`warn: ${m.join(' ')}`);
            return this;
        },
        info() {
            return this;
        },
        debug() {
            return this;
        },
    };
    try {
        // Data is bound by the renderer, and the compiler needs something to
        // bind — an empty array is the honest stand-in. The spec's own `data`
        // WINS when a case supplies rows, so a test that cares about the values
        // is not silently handed an empty array instead.
        compile({ data: { values: [] }, ...spec } as never, { logger: log as never });
    } catch (e) {
        issues.push(`threw: ${String(e)}`);
    }
    return issues;
}

const TYPES = CHART_SHAPES.map(s => s.type);

describe('every proposed chart compiles', () => {
    it.each(TYPES)('%s, as the matcher proposes it', type => {
        const state = stateFromVerdict(checkShape(FIELDS, type));
        // Every chart must fit these columns, or the case below is vacuous.
        expect(state, `${type} did not fit the test columns`).not.toBeNull();
        expect(compileIssues(buildSpec(state!))).toEqual([]);
    });
});

describe('every refinement compiles', () => {
    const bar = stateFromVerdict(checkShape(FIELDS, 'bar'))!;
    const line = stateFromVerdict(checkShape(FIELDS, 'line'))!;
    const pie = stateFromVerdict(checkShape(FIELDS, 'arc'))!;

    const cases: [string, ChartSpecState][] = [
        ['a title and subtitle', { ...bar, title: 'Items per vendor', subtitle: 'FY25' }],
        [
            'a category axis sorted by the measure',
            { ...bar, encoding: { ...bar.encoding, x: { ...bar.encoding.x!, sort: 'byValueDescending' } } },
        ],
        [
            'a category axis sorted alphabetically',
            { ...bar, encoding: { ...bar.encoding, x: { ...bar.encoding.x!, sort: 'ascending' } } },
        ],
        // These two are each reasonable and conflict only together: a log axis
        // cannot include zero, so Vega-Lite warns and drops the `zero`.
        // `buildSpec` suppresses it rather than emitting a setting with no
        // effect. Exactly the failure only the compiler could find.
        [
            'a log scale off zero',
            {
                ...bar,
                encoding: {
                    ...bar.encoding,
                    y: { ...bar.encoding.y!, scaleType: 'log', zero: false },
                },
            },
        ],
        [
            'a sqrt scale off zero, where the two do not conflict',
            {
                ...bar,
                encoding: {
                    ...bar.encoding,
                    y: { ...bar.encoding.y!, scaleType: 'sqrt', zero: false },
                },
            },
        ],
        [
            'an axis format and a hidden title',
            {
                ...bar,
                encoding: {
                    ...bar.encoding,
                    x: { ...bar.encoding.x!, title: null },
                    y: { ...bar.encoding.y!, format: ',.0f' },
                },
            },
        ],
        [
            'stacked to 100% with a colour and a scheme',
            {
                ...bar,
                stack: 'normalize',
                scheme: 'tableau10',
                encoding: { ...bar.encoding, color: { field: 'Site', type: 'nominal' } },
            },
        ],
        [
            'overlaid bars',
            {
                ...bar,
                stack: 'none',
                encoding: { ...bar.encoding, color: { field: 'Site', type: 'nominal' } },
            },
        ],
        [
            'a hidden legend',
            {
                ...bar,
                encoding: {
                    ...bar.encoding,
                    color: { field: 'Site', type: 'nominal', legend: false },
                },
            },
        ],
        [
            'a legend format',
            {
                ...bar,
                encoding: {
                    ...bar.encoding,
                    color: { field: 'UnitCost', type: 'quantitative', format: ',.1f' },
                },
            },
        ],
        ['a line with its points marked', { ...line, points: true }],
        [
            'a category axis left in query order',
            { ...bar, encoding: { ...bar.encoding, x: { ...bar.encoding.x!, sort: 'queryOrder' } } },
        ],
        [
            'a date axis with a date format',
            { ...line, encoding: { ...line.encoding, x: { ...line.encoding.x!, format: '%b %Y' } } },
        ],
        ['a pie with a scheme', { ...pie, scheme: 'set2' }],
    ];

    it.each(cases)('compiles %s', (_label, state) => {
        expect(compileIssues(buildSpec(state))).toEqual([]);
    });
});

// Compiling was not enough for this one — it only WARNS, and about a field
// nobody wrote (`count Item.Item_start`). So this case goes further and renders,
// then reads the y scale's domain back: an empty domain is the blank chart the
// app actually showed.
describe('a dotted column name still binds its data', () => {
    const ROWS = [
        { VendorName: 'MEDLINE', 'count Item.Item': 137 },
        { VendorName: 'CARDINAL', 'count Item.Item': 92 },
        { VendorName: 'OWENS', 'count Item.Item': 64 },
    ];
    const state: ChartSpecState = {
        chart: 'bar',
        encoding: {
            x: { field: 'VendorName', type: 'nominal' },
            y: { field: 'count Item.Item', type: 'quantitative' },
        },
    };

    it('reaches the values rather than drawing an empty chart', async () => {
        const vg = compile({ ...buildSpec(state), data: { values: ROWS } } as never);
        const view = new vega.View(vega.parse(vg.spec), { renderer: 'none' });
        await view.runAsync();
        // [0, 0] is the failure: Vega-Lite found nothing at `count Item.Item`.
        expect(view.scale('y').domain()).not.toEqual([0, 0]);
        expect((view.scale('y').domain() as number[])[1]).toBeGreaterThanOrEqual(137);
    });

    it('compiles without the infinite-extent warning', () => {
        expect(compileIssues({ ...buildSpec(state), data: { values: ROWS } })).toEqual([]);
    });
});

// The sort on a horizontal bar chart points at the OTHER axis (`-x` on `y`),
// which is easy to get backwards and impossible to see in the JSON. So this
// renders and reads the y scale's domain: that is the order the bars appear in,
// top to bottom.
describe('horizontal bars really do rank largest first', () => {
    const ROWS = [
        { Vendor: 'AESCULAP', n: 12 },
        { Vendor: 'MEDLINE', n: 137 },
        { Vendor: 'CARDINAL', n: 92 },
    ];

    async function domain(state: ChartSpecState): Promise<unknown[]> {
        const vg = compile({ ...buildSpec(state), data: { values: ROWS } } as never);
        const view = new vega.View(vega.parse(vg.spec), { renderer: 'none' });
        await view.runAsync();
        return view.scale('y').domain() as unknown[];
    }

    const proposed = stateFromVerdict(
        checkShape([f('Vendor', 'nominal'), f('n', 'quantitative')], 'barh'),
    )!;

    it('orders the categories by value, biggest first', async () => {
        expect(await domain(proposed)).toEqual(['MEDLINE', 'CARDINAL', 'AESCULAP']);
    });

    it('still honours an explicit alphabetical order', async () => {
        const alpha: ChartSpecState = {
            ...proposed,
            encoding: { ...proposed.encoding, y: { ...proposed.encoding.y!, sort: 'ascending' } },
        };
        expect(await domain(alpha)).toEqual(['AESCULAP', 'CARDINAL', 'MEDLINE']);
    });

    it('compiles clean, stacked along x', () => {
        const stacked: ChartSpecState = {
            ...proposed,
            stack: 'normalize',
            encoding: { ...proposed.encoding, color: { field: 'Vendor', type: 'nominal' } },
        };
        expect(compileIssues({ ...buildSpec(stacked), data: { values: ROWS } })).toEqual([]);
    });
});

// The gallery's cards are real charts, so one broken thumbnail is a broken card.
describe('every thumbnail compiles', () => {
    it.each(TYPES)('%s', type => {
        const spec = { ...thumbSpec(type) };
        // The thumbnail carries its own rows; the harness supplies the data.
        delete (spec as { data?: unknown }).data;
        expect(compileIssues(spec)).toEqual([]);
    });
});

// The end of the same thread, rendered rather than asserted. The whole point of
// preferring a name over a key is what somebody READS along the bottom of the
// chart, and only a rendered scale domain can say what that is.
//
// Runs the real path: result columns → the joins drawn on the Schema step →
// fields → verdict → state → spec → Vega. A break anywhere in it shows up here.
describe('a bar chart is labelled with names, not IDs', () => {
    const COLUMNS = [
        { name: 'Vendor', type: 'int64' },
        { name: 'VendorName', type: 'string' },
        { name: 'n', type: 'int64' },
    ];
    const ROWS = [
        { Vendor: 4021, VendorName: 'MEDLINE', n: 137 },
        { Vendor: 1180, VendorName: 'CARDINAL', n: 92 },
        { Vendor: 7714, VendorName: 'AESCULAP', n: 64 },
    ];

    async function xDomain(fields: Field[]): Promise<unknown[]> {
        const state = stateFromVerdict(checkShape(fields, 'bar'))!;
        const vg = compile({ ...buildSpec(state), data: { values: ROWS } } as never);
        const view = new vega.View(vega.parse(vg.spec), { renderer: 'none' });
        await view.runAsync();
        return (view.scale('x').domain() as unknown[]).slice().sort();
    }

    it('draws the vendor names when the joins are known', async () => {
        const keys = identifierColumns([{ fromColumn: 'Vendor', toColumn: 'Vendor' }]);
        expect(await xDomain(fieldsFromColumns(COLUMNS, keys))).toEqual([
            'AESCULAP',
            'CARDINAL',
            'MEDLINE',
        ]);
    });

    it('and the heights are the count, not the ID', async () => {
        const keys = identifierColumns([{ fromColumn: 'Vendor', toColumn: 'Vendor' }]);
        const state = stateFromVerdict(checkShape(fieldsFromColumns(COLUMNS, keys), 'bar'))!;
        const vg = compile({ ...buildSpec(state), data: { values: ROWS } } as never);
        const view = new vega.View(vega.parse(vg.spec), { renderer: 'none' });
        await view.runAsync();
        // 137, not 4021: the IDs are an order of magnitude bigger, so a domain
        // that reached them would be unmistakable.
        expect((view.scale('y').domain() as number[])[1]).toBeLessThan(1000);
    });
});

// The bullet graph, through the compiler AND the renderer.
//
// It needs both more than any chart here. The sweep above only ever sees the
// encoding the MATCHER proposes, and a bullet graph's ranges are deliberately
// never auto-filled — so the sweep compiles a two-layer bullet and the
// five-layer one nobody had checked is the one people will draw.
//
// And a layered spec is the silent-failure shape: five marks sharing two scales,
// where a wrong field binding or a lost layer still produces a chart that looks
// like a chart.
describe('the bullet graph compiles and draws', () => {
    const ROWS = [
        { Region: 'North', actual: 270, target: 250, poor: 150, fair: 225, good: 300 },
        { Region: 'South', actual: 180, target: 250, poor: 150, fair: 225, good: 300 },
        { Region: 'East', actual: 305, target: 250, poor: 150, fair: 225, good: 300 },
    ];

    const state: ChartSpecState = {
        chart: 'bullet',
        encoding: {
            label: { field: 'Region', type: 'nominal' },
            measure: { field: 'actual', type: 'quantitative' },
            target: { field: 'target', type: 'quantitative' },
            range1: { field: 'poor', type: 'quantitative' },
            range2: { field: 'fair', type: 'quantitative' },
            range3: { field: 'good', type: 'quantitative' },
        },
    };

    async function view(s: ChartSpecState) {
        const vg = compile({ ...buildSpec(s), data: { values: ROWS } } as never);
        const v = new vega.View(vega.parse(vg.spec), { renderer: 'none' });
        await v.runAsync();
        return v;
    }

    it('compiles clean with all five layers', () => {
        expect(compileIssues({ ...buildSpec(state), data: { values: ROWS } })).toEqual([]);
    });

    // `VegaChart` injects these three at render time, and Vega-Lite REFUSES them
    // on a faceted spec — which is why this is layered rather than a copy of the
    // `facet_bullet` example. If that ever changes, every bullet silently drops
    // to 200px wide.
    it('takes the size and data VegaChart injects, as a single view would', () => {
        expect(
            compileIssues({
                ...buildSpec(state),
                data: { values: ROWS },
                width: 400,
                height: 120,
                autosize: { type: 'fit', contains: 'padding' },
            }),
        ).toEqual([]);
    });

    // The scale has to reach the widest RANGE, not just the measure — that is
    // what makes the ranges a backdrop the measure sits inside rather than three
    // bars in their own right.
    it('shares one x scale across the layers, spanning the widest range', () => {
        return view(state).then(v => {
            const domain = v.scale('x').domain() as number[];
            expect(domain[0]).toBe(0);
            expect(domain[1]).toBeGreaterThanOrEqual(305);
        });
    });

    // Alphabetical would be North, South, East → East, North, South.
    it('keeps the rows in query order rather than sorting them alphabetically', async () => {
        const v = await view(state);
        expect(v.scale('y').domain()).toEqual(['North', 'South', 'East']);
    });

    it('sorts them when asked to', async () => {
        const v = await view({
            ...state,
            encoding: { ...state.encoding, label: { ...state.encoding.label!, sort: 'ascending' } },
        });
        expect(v.scale('y').domain()).toEqual(['East', 'North', 'South']);
    });

    // Five layers in, five marks out. A layer whose field did not bind still
    // produces a mark group, so this counts the ITEMS each one drew: three rows
    // each, or the layer found nothing.
    it('binds data in every layer, not just the ones that set the scale', async () => {
        const v = await view(state);
        type Group = { marktype?: string; items?: unknown[] };
        const root = v.scenegraph() as unknown as { root: { items: Group[] } };
        const counts = (root.root.items[0] as unknown as { items: Group[] }).items
            .filter(g => g.marktype === 'rect' || g.marktype === 'rule')
            .map(g => g.items?.length);
        expect(counts).toEqual([3, 3, 3, 3, 3]);
    });

    // The axis title is what the layer merge gets wrong, in BOTH directions, and
    // neither shows up in the spec JSON — only in `vg.spec.axes` after a compile.
    //
    // Leave the layers' titles alone and Vega-Lite JOINS them: the axis reads
    // `good, fair, poor, actual, target`. Mute the other four with `title: null`
    // to stop that, and the nulls beat the measure — the axis loses its name
    // entirely and the Label control does nothing, whatever anyone types.
    describe('the shared axis label', () => {
        const titles = (s: ChartSpecState) => {
            const vg = compile({ ...buildSpec(s), data: { values: ROWS } } as never);
            const axes = (vg.spec as unknown as { axes: { scale: string; title?: unknown }[] }).axes;
            return axes.filter(a => a.scale === 'x').map(a => a.title);
        };

        it('names the measure, once, and never joins the layers', () => {
            expect(titles(state)).toEqual([undefined, 'actual']);
        });

        it('takes the label somebody typed', () => {
            const named = {
                ...state,
                encoding: {
                    ...state.encoding,
                    measure: { ...state.encoding.measure!, title: 'Actual spend' },
                },
            };
            expect(titles(named)).toEqual([undefined, 'Actual spend']);
            // And it survives the round trip rather than being read back onto
            // whichever layer happened to be first.
            expect(readSpec(buildSpec(named))).toEqual(named);
        });

        it('can be hidden', () => {
            const hidden = {
                ...state,
                encoding: {
                    ...state.encoding,
                    measure: { ...state.encoding.measure!, title: null },
                },
            };
            // Vega-Lite drops a null title rather than carrying it through, so
            // the compiled axis simply has none — which is what hiding it means.
            expect(titles(hidden)).toEqual([undefined, undefined]);
            expect(readSpec(buildSpec(hidden))).toEqual(hidden);
        });
    });

    it('still compiles clean with no ranges at all', () => {
        const { range1: _1, range2: _2, range3: _3, ...encoding } = state.encoding;
        expect(
            compileIssues({ ...buildSpec({ chart: 'bullet', encoding }), data: { values: ROWS } }),
        ).toEqual([]);
    });
});

// The sparkline table's one load-bearing claim, checked against the COMPILER
// rather than against the JSON this module wrote.
//
// "Every row gets its own y scale" is not visible in the spec — `resolve` is
// four words — and getting it wrong does not error, warn, or draw an empty
// chart. It draws five horizontal rules that look like a styling problem. So
// the assertion is on where Vega-Lite PUT the scale: inside the facet cell is
// per-row, at the top level is shared.
describe('a sparkline table gives every row its own scale', () => {
    const state = stateFromVerdict(
        checkShape(
            [f('Category', 'nominal'), f('Month', 'temporal'), f('Spend', 'quantitative')],
            'sparkline',
        ),
    )!;

    const scalePlaces = (spec: Record<string, unknown>) => {
        const vg = compile({ ...spec, data: { values: [] } } as never);
        const out = vg.spec as unknown as {
            scales?: { name: string }[];
            marks?: { name?: string; scales?: { name: string }[] }[];
        };
        return {
            top: (out.scales ?? []).map(s => s.name),
            cell: (out.marks ?? []).flatMap(m => (m.scales ?? []).map(s => s.name)),
        };
    };

    it('compiles clean', () => {
        expect(compileIssues(buildSpec(state))).toEqual([]);
    });

    it('puts y inside the facet cell, and keeps x shared', () => {
        const { top, cell } = scalePlaces(buildSpec(state));
        // x shared: the rows are read down a common timeline.
        expect(top).toContain('x');
        expect(top).not.toContain('y');
        expect(cell).toContain('child_y');
    });

    // The contrast, so the assertion above is not just describing whatever the
    // compiler happens to do: without `resolve`, y lands at the top level and is
    // one domain for every row.
    it('would share one y domain without the resolve — the flat-lines bug', () => {
        const shared = buildSpec(state);
        delete shared.resolve;
        const { top, cell } = scalePlaces(shared);
        expect(top).toContain('y');
        expect(cell).not.toContain('child_y');
    });

    // `VegaChart` sets this signal to fit the container, having measured the
    // chrome around it. If the compiled name ever changes, the sparkline
    // silently stops resizing.
    it('exposes the inner width as child_width, which is what VegaChart drives', () => {
        const vg = compile({ ...buildSpec(state), data: { values: [] } } as never);
        const names = ((vg.spec as unknown as { signals?: { name: string }[] }).signals ?? []).map(
            s => s.name,
        );
        expect(names).toContain('child_width');
    });

    // And it must stay drawable at the size the renderer will give it.
    it('compiles clean with the numeric inner width VegaChart injects', () => {
        const sized = buildSpec(state);
        (sized.spec as Record<string, unknown>).width = 520;
        expect(compileIssues(sized)).toEqual([]);
    });
});
