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
import { CHART_SHAPES, checkShape, type Field } from './chart-shapes';
import { thumbSpec } from './chart-thumbnails';
import { buildSpec, stateFromVerdict, type ChartSpecState } from './chart-spec';

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
