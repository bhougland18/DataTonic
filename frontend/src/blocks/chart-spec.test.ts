import { describe, expect, it } from 'vitest';
import { checkShape, shapeFor, type Field } from './chart-shapes';
import {
    assignChannel,
    escapeField,
    unescapeField,
    buildSpec,
    channelOptions,
    encodedChannels,
    missingFields,
    readSpec,
    stateFromEncoding,
    stateFromVerdict,
    VL_SCHEMA,
    type ChartSpecState,
} from './chart-spec';

const f = (name: string, vlType: Field['vlType']): Field => ({ name, vlType });

/** The query the builder work ended on: Vendor (VARCHAR) + count (BIGINT). */
const VENDOR_COUNT = [f('Vendor', 'nominal'), f('count Item.Item', 'quantitative')];
/** `Item.AddedDate` is a real DATE since 2af12706, so this shape is testable. */
const DATE_COUNT = [f('AddedDate', 'temporal'), f('count Item.Item', 'quantitative')];

const bars = (): ChartSpecState => ({
    chart: 'bar',
    encoding: {
        x: { field: 'Vendor', type: 'nominal' },
        y: { field: 'count Item.Item', type: 'quantitative' },
    },
});

describe('buildSpec', () => {
    it('proposes a spec with no data, width or height', () => {
        const spec = buildSpec(bars());
        expect(spec).not.toHaveProperty('data');
        expect(spec).not.toHaveProperty('datasets');
        expect(spec).not.toHaveProperty('width');
        expect(spec).not.toHaveProperty('height');
    });

    it('carries the schema so a hand-edited spec validates', () => {
        expect(buildSpec(bars()).$schema).toBe(VL_SCHEMA);
    });

    it('stays minimal when nothing has been refined', () => {
        expect(buildSpec(bars())).toEqual({
            $schema: VL_SCHEMA,
            mark: 'bar',
            encoding: {
                x: { field: 'Vendor', type: 'nominal' },
                // Escaped, because Vega-Lite reads the dot as nested access.
                // See the "field names Vega-Lite reads as structure" block.
                y: { field: 'count Item\\.Item', type: 'quantitative' },
            },
        });
    });

    it('writes a bare title, and an object only when there is a subtitle', () => {
        expect(buildSpec({ ...bars(), title: 'Items per vendor' }).title).toBe('Items per vendor');
        expect(buildSpec({ ...bars(), title: 'Items per vendor', subtitle: 'FY25' }).title).toEqual({
            text: 'Items per vendor',
            subtitle: 'FY25',
        });
    });

    it('drops a title that is only whitespace', () => {
        expect(buildSpec({ ...bars(), title: '   ' })).not.toHaveProperty('title');
    });

    it('sorts a category axis by the measure on the other axis', () => {
        const state = bars();
        state.encoding.x!.sort = 'byValueDescending';
        expect((buildSpec(state).encoding as Record<string, { sort?: unknown }>).x!.sort).toBe('-y');
        state.encoding.x!.sort = 'byValueAscending';
        expect((buildSpec(state).encoding as Record<string, { sort?: unknown }>).x!.sort).toBe('y');
    });

    it('sorts alphabetically when asked for that instead', () => {
        const state = bars();
        state.encoding.x!.sort = 'ascending';
        expect((buildSpec(state).encoding as Record<string, { sort?: unknown }>).x!.sort).toBe(
            'ascending',
        );
    });

    it('puts a format string on the axis for x/y and on the legend elsewhere', () => {
        const state = bars();
        state.encoding.y!.format = ',.0f';
        state.encoding.color = { field: 'Site', type: 'nominal', format: ',.0f' };
        const enc = buildSpec(state).encoding as Record<string, Record<string, unknown>>;
        expect(enc.y.axis).toEqual({ format: ',.0f' });
        expect(enc.y).not.toHaveProperty('legend');
        expect(enc.color.legend).toEqual({ format: ',.0f' });
        expect(enc.color).not.toHaveProperty('axis');
    });

    it('hides a legend with null, which beats a format string on the same channel', () => {
        const state = bars();
        state.encoding.color = { field: 'Site', type: 'nominal', format: ',.0f', legend: false };
        const enc = buildSpec(state).encoding as Record<string, Record<string, unknown>>;
        expect(enc.color.legend).toBeNull();
    });

    it('emits a scale only for a non-default scale', () => {
        const state = bars();
        state.encoding.y!.scaleType = 'linear';
        expect((buildSpec(state).encoding as Record<string, object>).y).not.toHaveProperty('scale');
        // `sqrt` rather than `log` here: a log axis cannot include zero, so the
        // two together are the one combination `buildSpec` will not write. See
        // the log-and-zero describe below.
        state.encoding.y!.scaleType = 'sqrt';
        state.encoding.y!.zero = false;
        expect((buildSpec(state).encoding as Record<string, Record<string, unknown>>).y.scale).toEqual({
            type: 'sqrt',
            zero: false,
        });
    });

    it('puts the colour scheme on the colour channel only', () => {
        const state: ChartSpecState = {
            ...bars(),
            scheme: 'tableau10',
            encoding: { ...bars().encoding, color: { field: 'Site', type: 'nominal' } },
        };
        const enc = buildSpec(state).encoding as Record<string, Record<string, unknown>>;
        expect(enc.color.scale).toEqual({ scheme: 'tableau10' });
        expect(enc.x).not.toHaveProperty('scale');
    });

    // Stacking is a property of the measure's channel, and `zero` is already
    // Vega-Lite's default — writing it out only makes the spec harder to read.
    it('emits stack only when it differs from the default', () => {
        const state: ChartSpecState = { ...bars(), stack: 'zero' };
        expect((buildSpec(state).encoding as Record<string, object>).y).not.toHaveProperty('stack');
        expect(
            (buildSpec({ ...state, stack: 'normalize' }).encoding as Record<string, Record<string, unknown>>)
                .y.stack,
        ).toBe('normalize');
    });

    it('ignores stack on a chart that cannot stack', () => {
        const state: ChartSpecState = { chart: 'point', encoding: bars().encoding, stack: 'none' };
        expect((buildSpec(state).encoding as Record<string, object>).y).not.toHaveProperty('stack');
    });

    it('draws scatter points filled, and line points only when asked', () => {
        expect(buildSpec({ ...bars(), chart: 'point' }).mark).toEqual({ type: 'point', filled: true });
        expect(buildSpec({ ...bars(), chart: 'line' }).mark).toBe('line');
        expect(buildSpec({ ...bars(), chart: 'line', points: true }).mark).toEqual({
            type: 'line',
            point: true,
        });
    });

    it('skips a channel with neither a field nor a count', () => {
        const state = bars();
        state.encoding.color = { type: 'nominal' };
        expect(Object.keys(buildSpec(state).encoding as object)).toEqual(['x', 'y']);
    });
});

// The one place an aggregate is allowed, and only because binning in SQL throws
// the raw column away (`chart-shape-guidance.md` §9).
describe('the histogram exception', () => {
    const state = stateFromEncoding('histogram', {
        x: { field: 'UnitCost', type: 'quantitative' },
    });

    it('bins x and counts y', () => {
        expect(state.encoding.x).toEqual({ field: 'UnitCost', type: 'quantitative', bin: true });
        expect(state.encoding.y).toEqual({ count: true, type: 'quantitative' });
    });

    it('builds a bar mark with a binned x and a count y', () => {
        const spec = buildSpec(state);
        expect(spec.mark).toBe('bar');
        expect(spec.encoding).toEqual({
            x: { field: 'UnitCost', type: 'quantitative', bin: true },
            y: { aggregate: 'count', type: 'quantitative' },
        });
    });

    it('reads back as a histogram rather than as a bar chart', () => {
        expect(readSpec(buildSpec(state))?.chart).toBe('histogram');
    });

    it('leaves a plain bar chart alone', () => {
        expect(readSpec(buildSpec(bars()))?.chart).toBe('bar');
    });
});

// Three charts share `mark: 'bar'`, so the ENCODING is what tells them apart.
describe('horizontal bars', () => {
    const barh = () => stateFromVerdict(checkShape(VENDOR_COUNT, 'barh'))!;

    it('puts the category on y and the measure on x', () => {
        expect(barh().encoding.y).toMatchObject({ field: 'Vendor', type: 'nominal' });
        expect(barh().encoding.x).toMatchObject({
            field: 'count Item.Item',
            type: 'quantitative',
        });
    });

    // Ranked is what the sideways form is FOR. Vega-Lite's default would be
    // alphabetical, which is the one ordering a reader of a ranked bar chart is
    // guaranteed not to want.
    it('opens sorted largest first, without being asked', () => {
        expect(barh().encoding.y!.sort).toBe('byValueDescending');
        expect((buildSpec(barh()).encoding as Record<string, { sort?: unknown }>).y!.sort).toBe(
            '-x',
        );
    });

    it('is still a plain sort, so the Order control can change it', () => {
        const state = barh();
        state.encoding.y!.sort = 'ascending';
        expect((buildSpec(state).encoding as Record<string, { sort?: unknown }>).y!.sort).toBe(
            'ascending',
        );
    });

    it('uses the same bar mark as the upright form', () => {
        expect(buildSpec(barh()).mark).toBe('bar');
    });

    it('reads back as barh rather than as bar', () => {
        expect(readSpec(buildSpec(barh()))?.chart).toBe('barh');
        expect(readSpec(buildSpec(barh()))).toEqual(barh());
    });

    // The measure is on x here, and `stack` belongs to the measure's channel.
    // Emitting it on `y` did nothing at all for horizontal bars.
    it('stacks along x, not up y', () => {
        const state: ChartSpecState = {
            ...barh(),
            stack: 'normalize',
            encoding: { ...barh().encoding, color: { field: 'Site', type: 'nominal' } },
        };
        const enc = buildSpec(state).encoding as Record<string, Record<string, unknown>>;
        expect(enc.x.stack).toBe('normalize');
        expect(enc.y).not.toHaveProperty('stack');
    });

    it('does not swallow the upright bar chart or the histogram', () => {
        expect(readSpec(buildSpec(bars()))?.chart).toBe('bar');
        const hist = stateFromEncoding('histogram', {
            x: { field: 'UnitCost', type: 'quantitative' },
        });
        expect(readSpec(buildSpec(hist))?.chart).toBe('histogram');
    });
});

describe('stateFromVerdict', () => {
    it('starts from what the matcher already assigned', () => {
        const state = stateFromVerdict(checkShape(VENDOR_COUNT, 'bar'));
        expect(state).toEqual({
            chart: 'bar',
            encoding: {
                x: { field: 'Vendor', type: 'nominal' },
                y: { field: 'count Item.Item', type: 'quantitative' },
            },
        });
    });

    it('proposes a line over a real DATE column', () => {
        const state = stateFromVerdict(checkShape(DATE_COUNT, 'line'));
        expect(state?.encoding.x).toEqual({ field: 'AddedDate', type: 'temporal' });
    });

    // Anything short of `fits` has no encoding to propose — the step opens on
    // the picker, not on a half-built chart.
    it('returns null for a verdict that is not a fit', () => {
        expect(stateFromVerdict(checkShape([f('Vendor', 'nominal')], 'bar'))).toBeNull();
        expect(stateFromVerdict(checkShape(DATE_COUNT, 'rect'))).toBeNull();
    });
});

describe('readSpec round-trips what the controls model', () => {
    const cases: [string, ChartSpecState][] = [
        ['plain bars', bars()],
        ['a titled chart', { ...bars(), title: 'Items per vendor', subtitle: 'FY25' }],
        [
            'every channel refinement at once',
            {
                chart: 'bar',
                title: 'Items per vendor',
                stack: 'normalize',
                scheme: 'tableau10',
                encoding: {
                    x: { field: 'Vendor', type: 'nominal', sort: 'byValueDescending', title: 'Vendor' },
                    y: {
                        field: 'count Item.Item',
                        type: 'quantitative',
                        title: null,
                        // `sqrt`, because `log` + `zero: false` is deliberately
                        // not representable — a log axis never includes zero,
                        // so it cannot round-trip and should not.
                        scaleType: 'sqrt',
                        zero: false,
                        format: ',.0f',
                    },
                    color: { field: 'Site', type: 'nominal', legend: false },
                },
            },
        ],
        [
            'a scatter with size',
            {
                chart: 'point',
                encoding: {
                    x: { field: 'UnitCost', type: 'quantitative' },
                    y: { field: 'OnHand', type: 'quantitative' },
                    size: { field: 'OnHand', type: 'quantitative', format: ',.0f' },
                },
            },
        ],
        [
            'a pie chart',
            {
                chart: 'arc',
                encoding: {
                    theta: { field: 'count Item.Item', type: 'quantitative' },
                    color: { field: 'Vendor', type: 'nominal' },
                },
            },
        ],
        ['a line with points', { ...bars(), chart: 'line', points: true }],
        [
            'a box plot',
            { chart: 'boxplot', encoding: { y: { field: 'UnitCost', type: 'quantitative' } } },
        ],
    ];

    it.each(cases)('round-trips %s', (_label, state) => {
        expect(readSpec(buildSpec(state))).toEqual(state);
    });
});

// `null` is the honest answer, not a failure: the JSON is doing something the
// controls would silently flatten, so the JSON stays the source of truth.
describe('readSpec refuses what the controls would flatten', () => {
    it.each([
        ['a transform', { mark: 'bar', transform: [{ fold: ['a', 'b'] }], encoding: {} }],
        ['a layered spec', { layer: [{ mark: 'bar' }], encoding: {} }],
        // Owned by the renderer, not the spec — and a blacklist let these
        // round-trip and then silently dropped them.
        ['a baked-in width', { mark: 'bar', width: 400, encoding: {} }],
        ['a config block', { mark: 'bar', config: { bar: { fill: 'red' } }, encoding: {} }],
        ['a faceted spec', { mark: 'bar', facet: { field: 'Site' }, spec: {} }],
        ['no mark at all', { encoding: { x: { field: 'a', type: 'nominal' } } }],
        ['an unknown mark', { mark: 'geoshape', encoding: {} }],
        ['no encoding', { mark: 'bar' }],
        [
            'an unknown channel',
            { mark: 'bar', encoding: { x: { field: 'a', type: 'nominal' }, row: { field: 'b' } } },
        ],
        [
            'a timeUnit',
            { mark: 'line', encoding: { x: { field: 'd', type: 'temporal', timeUnit: 'month' } } },
        ],
        [
            'an aggregate other than count',
            { mark: 'bar', encoding: { y: { field: 'c', type: 'quantitative', aggregate: 'sum' } } },
        ],
        [
            'a conditional encoding',
            { mark: 'bar', encoding: { color: { condition: { test: 'x', value: 'red' } } } },
        ],
        ['a binned channel with options', { mark: 'bar', encoding: { x: { field: 'c', type: 'quantitative', bin: { maxbins: 40 } } } }],
        [
            'a sort by a third field',
            { mark: 'bar', encoding: { x: { field: 'a', type: 'nominal', sort: { field: 'z' } } } },
        ],
        [
            'an axis setting with no control',
            { mark: 'bar', encoding: { x: { field: 'a', type: 'nominal', axis: { labelAngle: 45 } } } },
        ],
        [
            'a scale setting with no control',
            {
                mark: 'bar',
                encoding: { y: { field: 'c', type: 'quantitative', scale: { domain: [0, 10] } } },
            },
        ],
        [
            'a mark property with no control',
            { mark: { type: 'bar', cornerRadius: 4 }, encoding: {} },
        ],
        ['a missing channel type', { mark: 'bar', encoding: { x: { field: 'a' } } }],
        ['a channel with no field', { mark: 'bar', encoding: { x: { type: 'nominal' } } }],
    ])('refuses %s', (_label, spec) => {
        expect(readSpec(spec as Record<string, unknown>)).toBeNull();
    });

    it('reads a filled circle as a scatter plot rather than refusing it', () => {
        const state = readSpec({
            mark: { type: 'circle', filled: true },
            encoding: {
                x: { field: 'UnitCost', type: 'quantitative' },
                y: { field: 'OnHand', type: 'quantitative' },
            },
        });
        expect(state?.chart).toBe('point');
    });
});

describe('missingFields', () => {
    // The query was edited after the chart was built. Vega-Lite renders that as
    // an empty chart rather than an error, so somebody has nothing to read.
    it('names the columns the result no longer has', () => {
        expect(missingFields(bars(), [f('Vendor', 'nominal')])).toEqual(['count Item.Item']);
    });

    it('says nothing when every channel resolves', () => {
        expect(missingFields(bars(), VENDOR_COUNT)).toEqual([]);
    });

    // A histogram's count channel has no column behind it, so it can never be
    // missing — reporting it would be a permanent false alarm.
    it('ignores a count channel', () => {
        const state = stateFromEncoding('histogram', { x: { field: 'UnitCost', type: 'quantitative' } });
        expect(missingFields(state, [f('UnitCost', 'quantitative')])).toEqual([]);
    });
});

describe('encodedChannels', () => {
    it('lists only the channels that will be drawn', () => {
        const state = bars();
        state.encoding.color = { type: 'nominal' };
        expect(encodedChannels(state)).toEqual(['x', 'y']);
    });
});

// Where the remapping rules live, and why they are here rather than in the
// hook: a rule in a hook is a rule that needs a browser to check. Same split
// `builder-ops.ts` has from `useQueryBuilder`.
describe('channelOptions', () => {
    const bar = shapeFor('bar')!.variants[0];
    const need = (channel: string) => bar.needs.find(n => n.channel === channel)!;
    const FIELDS = [
        f('Vendor', 'nominal'),
        f('Site', 'nominal'),
        f('count Item.Item', 'quantitative'),
        f('AddedDate', 'temporal'),
    ];

    it('offers only columns the channel accepts', () => {
        expect(channelOptions(bars(), need('x'), FIELDS).map(o => o.field)).toEqual([
            'Vendor',
            'Site',
        ]);
        expect(channelOptions(bars(), need('y'), FIELDS).map(o => o.field)).toEqual([
            'count Item.Item',
        ]);
    });

    // Swapping two channels is ordinary, so a taken column stays offered —
    // it is labelled, not withheld.
    it('marks a column that is already on another channel', () => {
        const state = bars();
        state.encoding.color = { field: 'Site', type: 'nominal' };
        const opts = channelOptions(state, need('x'), FIELDS);
        expect(opts).toEqual([{ field: 'Vendor' }, { field: 'Site', taken: 'color' }]);
    });

    it('does not mark a column as taken by the channel it is being picked for', () => {
        expect(channelOptions(bars(), need('x'), FIELDS)[0]).toEqual({ field: 'Vendor' });
    });
});

describe('assignChannel', () => {
    const bar = shapeFor('bar')!.variants[0];
    const need = (channel: string) => bar.needs.find(n => n.channel === channel)!;
    const FIELDS = [
        f('Vendor', 'nominal'),
        f('Site', 'nominal'),
        f('count Item.Item', 'quantitative'),
    ];

    it('moves a column onto a channel', () => {
        const next = assignChannel(bars(), need('x'), FIELDS, 'Site');
        expect(next.encoding.x).toEqual({ field: 'Site', type: 'nominal' });
    });

    // The title and the sort describe the CHANNEL. Losing them on every remap
    // would make trying a different column cost the refinement done to it.
    it('keeps the channel refinements through a remap', () => {
        const state = bars();
        state.encoding.x = {
            field: 'Vendor',
            type: 'nominal',
            title: 'Supplier',
            sort: 'byValueDescending',
        };
        const next = assignChannel(state, need('x'), FIELDS, 'Site');
        expect(next.encoding.x).toEqual({
            field: 'Site',
            type: 'nominal',
            title: 'Supplier',
            sort: 'byValueDescending',
        });
    });

    it('adds an optional channel that was not there', () => {
        const next = assignChannel(bars(), need('color'), FIELDS, 'Site');
        expect(next.encoding.color).toEqual({ field: 'Site', type: 'nominal' });
    });

    it('clears an optional channel', () => {
        const state = assignChannel(bars(), need('color'), FIELDS, 'Site');
        expect(assignChannel(state, need('color'), FIELDS, null).encoding.color).toBeUndefined();
    });

    // A remap cannot turn a fitting chart into a broken one, which is what
    // makes the picker safe to offer at all.
    it('refuses a column of a type the channel does not accept', () => {
        const state = bars();
        expect(assignChannel(state, need('x'), FIELDS, 'count Item.Item')).toBe(state);
    });

    it('refuses a column that is not in the result', () => {
        const state = bars();
        expect(assignChannel(state, need('x'), FIELDS, 'Ghost')).toBe(state);
    });

    // There is no empty state for a required channel that still draws anything.
    it('refuses to clear a required channel', () => {
        const state = bars();
        expect(assignChannel(state, need('x'), FIELDS, null)).toBe(state);
    });

    // A count is the ABSENCE of a column, so putting one on drops it — left
    // behind, `buildSpec` would emit both a field and an aggregate.
    it('drops the count when a column is put on that channel', () => {
        const hist = stateFromEncoding('histogram', {
            x: { field: 'UnitCost', type: 'quantitative' },
        });
        const yNeed = { channel: 'y' as const, accepts: ['quantitative' as const], required: true, label: 'a number' };
        const next = assignChannel(hist, yNeed, [f('UnitCost', 'quantitative')], 'UnitCost');
        expect(next.encoding.y).toEqual({ field: 'UnitCost', type: 'quantitative' });
        expect(next.encoding.y).not.toHaveProperty('count');
    });
});

// Found by compiling the spec, not by reading the schema: the two settings are
// independently reasonable and only conflict together.
describe('a log scale and a zero baseline', () => {
    it('drops zero on a log scale, which Vega-Lite would warn about', () => {
        const state = bars();
        state.encoding.y = { ...state.encoding.y!, scaleType: 'log', zero: false };
        expect(
            (buildSpec(state).encoding as Record<string, Record<string, unknown>>).y.scale,
        ).toEqual({ type: 'log' });
    });

    it('keeps zero on a sqrt scale, where there is no conflict', () => {
        const state = bars();
        state.encoding.y = { ...state.encoding.y!, scaleType: 'sqrt', zero: false };
        expect(
            (buildSpec(state).encoding as Record<string, Record<string, unknown>>).y.scale,
        ).toEqual({ type: 'sqrt', zero: false });
    });
});

// Found by RENDERING, not by reading the schema: Vega-Lite's default for a
// nominal axis is alphabetical, so an `ORDER BY count DESC` in the SQL is
// silently discarded by the chart. `sort: null` is the only way to keep it.
describe('query order', () => {
    it('emits sort: null, which is what preserves the row order', () => {
        const state = bars();
        state.encoding.x!.sort = 'queryOrder';
        expect((buildSpec(state).encoding as Record<string, { sort?: unknown }>).x!.sort).toBeNull();
    });

    it('reads sort: null back as query order', () => {
        const state = bars();
        state.encoding.x!.sort = 'queryOrder';
        expect(readSpec(buildSpec(state))?.encoding.x?.sort).toBe('queryOrder');
    });

    // `sort: null` used to double as "cannot model this", which would have made
    // every query-ordered chart fall into JSON mode.
    it('is not mistaken for a sort the controls cannot model', () => {
        expect(readSpec({ mark: 'bar', encoding: { x: { field: 'a', type: 'nominal', sort: null } } })).not.toBeNull();
        expect(
            readSpec({ mark: 'bar', encoding: { x: { field: 'a', type: 'nominal', sort: { field: 'z' } } } }),
        ).toBeNull();
    });
});


// The bug that only running the real app could find, and the one most likely to
// recur. Vega-Lite reads `.` in a field reference as NESTED ACCESS, so the
// builder's own `count Item.Item` sent it looking for
// `row['count Item']['Item']`. It drew correct-looking axes over no data and
// reported nothing an operator would see — `compile()` warns, but about a field
// called `count Item.Item_start` that nobody wrote.
//
// Not a corner case: the builder names EVERY aggregate `<agg> <table>.<column>`,
// so nearly every built query with a count in it produced a blank chart.
describe('field names Vega-Lite reads as structure', () => {
    const dotted = (): ChartSpecState => ({
        chart: 'bar',
        encoding: {
            x: { field: 'VendorName', type: 'nominal' },
            y: { field: 'count Item.Item', type: 'quantitative' },
        },
    });

    it('escapes a dot in the built spec', () => {
        const enc = buildSpec(dotted()).encoding as Record<string, { field?: string }>;
        expect(enc.y.field).toBe('count Item\\.Item');
    });

    it('escapes brackets too, since those are array indexing', () => {
        expect(escapeField('tags[0].name')).toBe('tags\\[0\\]\\.name');
    });

    it('leaves a name with nothing special in it alone', () => {
        expect(escapeField('VendorName')).toBe('VendorName');
    });

    // The STATE holds the real column name — that is what `missingFields`
    // compares against the result and what the AI pane is told. Escaping is a
    // property of the reference, not of the column.
    it('keeps the real column name in the state, and round-trips', () => {
        expect(dotted().encoding.y!.field).toBe('count Item.Item');
        expect(readSpec(buildSpec(dotted()))).toEqual(dotted());
    });

    it('does not report a dotted column as missing', () => {
        expect(
            missingFields(dotted(), [
                f('VendorName', 'nominal'),
                f('count Item.Item', 'quantitative'),
            ]),
        ).toEqual([]);
    });

    it('unescapes back to the column name', () => {
        expect(unescapeField('count Item\\.Item')).toBe('count Item.Item');
        expect(unescapeField('tags\\[0\\]\\.name')).toBe('tags[0].name');
        expect(unescapeField('plain')).toBe('plain');
    });
});
