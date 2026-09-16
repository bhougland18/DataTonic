import { describe, expect, it } from 'vitest';
import {
    CHART_SHAPES,
    allCharts,
    identifierColumns,
    checkShape,
    fieldsFromColumns,
    missingSummary,
    proposeEncoding,
    suggestCharts,
    vlTypeOf,
    type Field,
    type Verdict,
} from './chart-shapes';

const f = (name: string, vlType: Field['vlType']): Field => ({ name, vlType });

/** The query the builder work ended on: Vendor (VARCHAR) + count (BIGINT). */
const VENDOR_COUNT = [f('Vendor', 'nominal'), f('count Item.Item', 'quantitative')];

describe('vlTypeOf', () => {
    it.each([
        ['VARCHAR', 'nominal'],
        ['BIGINT', 'quantitative'],
        ['INTEGER', 'quantitative'],
        ['DECIMAL(18,3)', 'quantitative'],
        ['DOUBLE', 'quantitative'],
        ['DATE', 'temporal'],
        ['TIMESTAMP', 'temporal'],
        ['TIMESTAMP WITH TIME ZONE', 'temporal'],
        ['BOOLEAN', 'nominal'],
    ] as const)('maps %s to %s', (duck, vl) => {
        expect(vlTypeOf(duck)).toBe(vl);
    });

    // A DESCRIBE gives SQL spellings; a RUN's preview gives Duckle's own names
    // (`crates/metadata` serializes them), and this matcher reads results from
    // both. `float64` used to fall through to `nominal`, so a DOUBLE measure was
    // reported as a category and every chart wanting a number said it was
    // missing one.
    it.each([
        ['int32', 'quantitative'],
        ['int64', 'quantitative'],
        ['float32', 'quantitative'],
        ['float64', 'quantitative'],
        ['decimal', 'quantitative'],
        ['string', 'nominal'],
        ['bool', 'nominal'],
        ['date', 'temporal'],
        ['timestamp', 'temporal'],
    ] as const)('maps the run-reported %s to %s', (duck, vl) => {
        expect(vlTypeOf(duck)).toBe(vl);
    });

    // A list of numbers is not a number, and `INTEGER[]` contains "integer".
    it.each(['INTEGER[]', 'VARCHAR[]', 'STRUCT(a INTEGER)', 'MAP(VARCHAR, INTEGER)'])(
        'refuses %s',
        t => {
            expect(vlTypeOf(t)).toBeNull();
        },
    );

    // A failed probe must not manufacture a capability — the same rule
    // `aggregatesFor` follows.
    it('treats an unknown type as nominal, never quantitative', () => {
        expect(vlTypeOf(undefined)).toBe('nominal');
        expect(vlTypeOf('')).toBe('nominal');
        expect(vlTypeOf('SOMETHING_NEW')).toBe('nominal');
    });

    it('drops unchartable columns when building fields', () => {
        const fields = fieldsFromColumns([
            { name: 'Vendor', type: 'VARCHAR' },
            { name: 'tags', type: 'VARCHAR[]' },
            { name: 'n', type: 'BIGINT' },
        ]);
        expect(fields.map(x => x.name)).toEqual(['Vendor', 'n']);
    });
});

describe('checkShape — the happy case', () => {
    it('fits Vendor + count to a bar chart', () => {
        const v = checkShape(VENDOR_COUNT, 'bar');
        expect(v.kind).toBe('fits');
        expect(proposeEncoding(v)).toEqual({
            x: { field: 'Vendor', type: 'nominal' },
            y: { field: 'count Item.Item', type: 'quantitative' },
        });
    });

    it('leaves the optional colour channel empty rather than forcing it', () => {
        const v = checkShape(VENDOR_COUNT, 'bar');
        expect(v.kind === 'fits' && v.encoding.color).toBeUndefined();
    });

    it('reports columns the chart will not show', () => {
        const v = checkShape([...VENDOR_COUNT, f('Description', 'nominal')], 'bar');
        // Description lands in the optional colour channel, so nothing is unused.
        expect(v.kind === 'fits' && v.encoding.color?.field).toBe('Description');
        expect(v.kind === 'fits' && v.unused).toEqual([]);
    });
});

describe('checkShape — variants', () => {
    // The stated top risk: one rigid shape per chart type reports a perfectly
    // good grouped-bar result as wrong.
    it('fits a grouped bar result — two categories and a measure', () => {
        const v = checkShape(
            [f('Vendor', 'nominal'), f('Region', 'nominal'), f('n', 'quantitative')],
            'bar',
        );
        expect(v.kind).toBe('fits');
        expect(v.kind === 'fits' && v.encoding.color?.field).toBe('Region');
    });

    it('fits a lone number to a histogram', () => {
        const v = checkShape([f('UnitCost', 'quantitative')], 'histogram');
        expect(v.kind).toBe('fits');
        expect(v.kind === 'fits' && v.encoding.x?.field).toBe('UnitCost');
    });
});

describe('box plots and grain', () => {
    // The bug Ben caught on a real query: `GROUP BY Manufacturer` gives one row
    // per manufacturer, so a box plot split by manufacturer summarises a single
    // number per box — 36 flat ticks. It rendered, so it read as a fit.
    it('never puts a category on a box plot axis', () => {
        const v = checkShape(VENDOR_COUNT, 'boxplot');
        expect(v.kind).toBe('fits');
        expect(v.kind === 'fits' && v.encoding.x).toBeUndefined();
        expect(v.kind === 'fits' && v.encoding.y?.field).toBe('count Item.Item');
    });

    // The ungrouped form is a real answer — "how are these counts distributed" —
    // so the fix is not to drop box plots, only to stop them grabbing a category.
    it('still offers a box plot over a lone measure', () => {
        const v = checkShape([f('UnitCost', 'quantitative')], 'boxplot');
        expect(v.kind).toBe('fits');
    });

    it('names the category as unused rather than silently dropping it', () => {
        const v = checkShape(VENDOR_COUNT, 'boxplot');
        expect(v.kind === 'fits' && v.unused).toEqual(['Vendor']);
    });
});

describe('distribution charts need a crowd', () => {
    // Ben's second real case: 7 vendors, one count each. The box plot renders
    // and reports quartiles computed from two points apiece.
    const SEVEN = { rowCount: 7 };
    const MANY = { rowCount: 200 };

    it.each(['boxplot', 'histogram'] as const)('calls %s unsuitable over 7 rows', chart => {
        const v = checkShape(VENDOR_COUNT, chart, SEVEN);
        expect(v.kind).toBe('unsuitable');
        expect(missingSummary(v)).toContain('7 is too few');
    });

    it.each(['boxplot', 'histogram'] as const)('allows %s once there are enough', chart => {
        expect(checkShape(VENDOR_COUNT, chart, MANY).kind).toBe('fits');
    });

    it('keeps them out of the suggestion list when there are too few rows', () => {
        const charts = suggestCharts(VENDOR_COUNT, true, SEVEN).map(v => v.chart);
        expect(charts).not.toContain('boxplot');
        expect(charts).not.toContain('histogram');
        // The chart that actually answers the question is still there.
        expect(charts).toContain('bar');
    });

    // Before a run there is nothing to count. Suppressing then would make the
    // chart flicker into existence on Run for reasons nobody could see.
    it('does not judge row count when it is unknown', () => {
        expect(checkShape(VENDOR_COUNT, 'boxplot').kind).toBe('fits');
        expect(checkShape(VENDOR_COUNT, 'boxplot', {}).kind).toBe('fits');
    });

    it('leaves charts that are not about distribution alone', () => {
        expect(checkShape(VENDOR_COUNT, 'bar', SEVEN).kind).toBe('fits');
        expect(checkShape(VENDOR_COUNT, 'arc', SEVEN).kind).toBe('fits');
    });

    // "Too few rows" must not mask "no number to plot" — the second is the one
    // the user can act on.
    it('reports the missing column ahead of the row count', () => {
        const v = checkShape([f('Vendor', 'nominal')], 'boxplot', SEVEN);
        expect(v.kind).toBe('close');
        expect(missingSummary(v)).toBe('needs a number to summarise');
    });

    it('never proposes an encoding for an unsuitable chart', () => {
        expect(proposeEncoding(checkShape(VENDOR_COUNT, 'boxplot', SEVEN))).toBeNull();
    });
});

describe('distribution charts and grain', () => {
    // Ben's rule: a box plot of a GROUP BY aggregate summarises summaries. No
    // row count rescues it — 500 groups is still one value per group.
    const AGGREGATED = { rowCount: 500, aggregated: true };

    it.each(['boxplot', 'histogram'] as const)('refuses %s over an aggregate', chart => {
        const v = checkShape(VENDOR_COUNT, chart, AGGREGATED);
        expect(v.kind).toBe('unsuitable');
        expect(missingSummary(v)).toContain('already one value per group');
    });

    it('prefers the grain reason over the row-count one', () => {
        const v = checkShape(VENDOR_COUNT, 'boxplot', { rowCount: 3, aggregated: true });
        expect(missingSummary(v)).toContain('already one value per group');
    });

    /**
     * The exclusion Ben asked for. A window function returns a value per ROW,
     * so the result keeps its raw grain — `aggregated` is false and the chart
     * stands. In the builder this holds by construction: `SelectedColumn` only
     * carries GROUP BY aggregates.
     */
    it('allows a distribution over a window function result', () => {
        expect(checkShape(VENDOR_COUNT, 'boxplot', { rowCount: 500, aggregated: false }).kind)
            .toBe('fits');
    });

    it('does not judge grain when it is unknown', () => {
        expect(checkShape(VENDOR_COUNT, 'boxplot', { rowCount: 500 }).kind).toBe('fits');
    });

    it('leaves charts that are not about distribution alone', () => {
        expect(checkShape(VENDOR_COUNT, 'bar', AGGREGATED).kind).toBe('fits');
        expect(checkShape(VENDOR_COUNT, 'arc', AGGREGATED).kind).toBe('fits');
    });

    it('keeps them out of the suggestion list', () => {
        const charts = suggestCharts(VENDOR_COUNT, true, AGGREGATED).map(v => v.chart);
        expect(charts).not.toContain('boxplot');
        expect(charts).not.toContain('histogram');
        expect(charts).toContain('bar');
    });
});

describe('checkShape — near misses', () => {
    it('calls a category with no measure close, and names the fix', () => {
        const v = checkShape([f('Vendor', 'nominal')], 'bar');
        expect(v.kind).toBe('close');
        expect(missingSummary(v)).toBe('needs a number');
    });

    it('calls two missing channels wrong, not close', () => {
        const v = checkShape([f('Vendor', 'nominal')], 'rect');
        expect(v.kind).toBe('wrong');
        expect(v.kind === 'wrong' && v.missing.length).toBe(2);
    });

    it('never reports a fitting chart as missing anything', () => {
        expect(missingSummary(checkShape(VENDOR_COUNT, 'bar'))).toBeNull();
    });
});

describe('bestPlan — assignment, not greed', () => {
    // The case a left-to-right greedy assignment gets wrong. A heatmap wants
    // x: nominal|ordinal|temporal, y: nominal|ordinal, color: quantitative.
    // Greedy would hand the only date to x... which is right here; the real
    // trap is the reverse, below.
    it('seats a date on the axis that accepts one', () => {
        const v = checkShape(
            [f('Month', 'temporal'), f('Vendor', 'nominal'), f('n', 'quantitative')],
            'rect',
        );
        expect(v.kind).toBe('fits');
        expect(v.kind === 'fits' && v.encoding.x?.field).toBe('Month');
        expect(v.kind === 'fits' && v.encoding.y?.field).toBe('Vendor');
    });

    // Greedy fails here: scatter's x accepts quantitative OR temporal and y
    // accepts only quantitative. Given a date and one number, x must take the
    // date so y can have the number.
    it('gives the flexible channel the type the strict one cannot use', () => {
        const v = checkShape([f('n', 'quantitative'), f('Day', 'temporal')], 'point');
        expect(v.kind).toBe('fits');
        expect(v.kind === 'fits' && v.encoding.x?.field).toBe('Day');
        expect(v.kind === 'fits' && v.encoding.y?.field).toBe('n');
    });

    it('prefers filling a required channel over two optional ones', () => {
        // Scatter: x and y required, colour and size optional. One number and
        // two categories cannot fill both required channels, so it is close,
        // not a fit that quietly dropped y.
        const v = checkShape(
            [f('a', 'nominal'), f('b', 'nominal'), f('n', 'quantitative')],
            'point',
        );
        expect(v.kind).toBe('close');
    });

    it('takes same-typed columns in the order they were selected', () => {
        const v = checkShape(
            [f('first', 'nominal'), f('second', 'nominal'), f('n', 'quantitative')],
            'bar',
        );
        expect(v.kind === 'fits' && v.encoding.x?.field).toBe('first');
        expect(v.kind === 'fits' && v.encoding.color?.field).toBe('second');
    });
});

describe('suggestCharts', () => {
    it('puts bar and pie ahead of the rest for a category and a count', () => {
        const kinds = suggestCharts(VENDOR_COUNT);
        const fits = kinds.filter(v => v.kind === 'fits').map(v => v.chart);
        expect(fits).toContain('bar');
        expect(fits).toContain('arc');
        expect(fits).toContain('boxplot');
    });

    // The reason `line` does not accept a nominal x: it would fit everything a
    // bar chart fits, and a suggestion list that always suggests everything is
    // not a suggestion.
    it('does not offer a line chart over bare categories', () => {
        const fits = suggestCharts(VENDOR_COUNT)
            .filter(v => v.kind === 'fits')
            .map(v => v.chart);
        expect(fits).not.toContain('line');
    });

    it('offers a line chart once the axis is a date', () => {
        const fits = suggestCharts([f('Month', 'temporal'), f('n', 'quantitative')])
            .filter(v => v.kind === 'fits')
            .map(v => v.chart);
        expect(fits).toContain('line');
        expect(fits).toContain('area');
    });

    it('ranks every fit above every near miss', () => {
        const order = suggestCharts(VENDOR_COUNT).map(v => v.kind);
        expect(order.indexOf('close') === -1 || order.lastIndexOf('fits') < order.indexOf('close'))
            .toBe(true);
    });

    it('can be asked for fits only', () => {
        expect(suggestCharts(VENDOR_COUNT, false).every(v => v.kind === 'fits')).toBe(true);
    });

    it('suggests nothing that fits when there is nothing to plot', () => {
        expect(suggestCharts([], false)).toEqual([]);
    });
});

describe('the contract table itself', () => {
    it('gives every chart at least one variant with a required channel', () => {
        for (const shape of CHART_SHAPES) {
            expect(shape.variants.length).toBeGreaterThan(0);
            for (const v of shape.variants) {
                expect(v.needs.some(n => n.required)).toBe(true);
            }
        }
    });

    it('labels every need, since the label is what the user is told', () => {
        for (const shape of CHART_SHAPES) {
            for (const v of shape.variants) {
                for (const n of v.needs) expect(n.label.trim()).not.toBe('');
            }
        }
    });

    it('never lets a variant accept the same channel twice', () => {
        for (const shape of CHART_SHAPES) {
            for (const v of shape.variants) {
                const channels = v.needs.map(n => n.channel);
                expect(new Set(channels).size).toBe(channels.length);
            }
        }
    });
});

describe('verdicts stay well-formed', () => {
    const everyChart = CHART_SHAPES.map(s => s.type);

    it('returns a verdict for every chart type against any input', () => {
        const inputs: Field[][] = [
            [],
            VENDOR_COUNT,
            [f('a', 'nominal')],
            [f('n', 'quantitative')],
            [f('d', 'temporal'), f('n', 'quantitative'), f('c', 'nominal')],
        ];
        for (const fields of inputs) {
            for (const chart of everyChart) {
                const v: Verdict = checkShape(fields, chart);
                expect(['fits', 'close', 'wrong']).toContain(v.kind);
            }
        }
    });

    it('never proposes an encoding for a verdict that does not fit', () => {
        expect(proposeEncoding(checkShape([], 'bar'))).toBeNull();
    });

    it('never assigns one column to two channels', () => {
        const v = checkShape(
            [f('a', 'nominal'), f('b', 'nominal'), f('n', 'quantitative'), f('m', 'quantitative')],
            'point',
        );
        if (v.kind !== 'fits') throw new Error('expected a fit');
        const used = Object.values(v.encoding).map(e => e.field);
        expect(new Set(used).size).toBe(used.length);
    });
});

// Found by Ben, on a real result: `Vendor` is an int64 foreign key, so it read
// as a measure and a LINE CHART over vendor ID numbers ranked first — above the
// bar chart, which was itself offered with the ID as its bar heights.
describe('key columns are categories, not measures', () => {
    const COLUMNS = [
        { name: 'Vendor', type: 'int64' },
        { name: 'VendorName', type: 'string' },
        { name: 'count Item.Item', type: 'int64' },
    ];
    const KEYS = identifierColumns([
        { fromColumn: 'Vendor', toColumn: 'Vendor' },
        { fromColumn: 'Item', toColumn: 'Item' },
    ]);

    it('collects the join keys the ER model declares', () => {
        expect([...KEYS].sort()).toEqual(['Item', 'Vendor']);
    });

    it('also takes a primary key the probe reported', () => {
        const keys = identifierColumns([], [{ name: 'Id', type: 'int64', primaryKey: true }]);
        expect(keys.has('Id')).toBe(true);
    });

    it('retypes a numeric key as a category', () => {
        const fields = fieldsFromColumns(COLUMNS, KEYS);
        expect(fields.map(f => `${f.name}=${f.vlType}`)).toEqual([
            'Vendor=nominal',
            'VendorName=nominal',
            'count Item.Item=quantitative',
        ]);
    });

    // Retyped rather than dropped: counting by vendor ID is a real chart.
    it('keeps the key plottable as a category', () => {
        const fields = fieldsFromColumns(COLUMNS, KEYS);
        expect(fields.map(f => f.name)).toContain('Vendor');
    });

    it('leaves a text or date key alone', () => {
        const fields = fieldsFromColumns(
            [
                { name: 'Item', type: 'string' },
                { name: 'AddedDate', type: 'date' },
            ],
            identifierColumns([{ fromColumn: 'Item', toColumn: 'AddedDate' }]),
        );
        expect(fields.map(f => f.vlType)).toEqual(['nominal', 'temporal']);
    });

    // The whole point. Before: line/area/scatter fit with x = the ID.
    it('stops offering a line over an ID column', () => {
        const before = checkShape(fieldsFromColumns(COLUMNS), 'line');
        expect(before.kind).toBe('fits');
        expect(before.kind === 'fits' && before.encoding.x?.field).toBe('Vendor');

        // `close`, and the message is about Y rather than X: with only one
        // measure left the matcher puts `count` on the x axis and then has
        // nothing for y. Either way it is no longer on offer, and "needs a
        // number" is the thing to act on.
        const after = checkShape(fieldsFromColumns(COLUMNS, KEYS), 'line');
        expect(after.kind).toBe('close');
        expect(missingSummary(after)).toBe('needs a number');
    });

    // And the bar chart stops plotting the ID as its measure.
    it('gives the bar chart the count, not the key, for its measure', () => {
        const before = checkShape(fieldsFromColumns(COLUMNS), 'bar');
        expect(before.kind === 'fits' && before.encoding.y?.field).toBe('Vendor');
        const after = checkShape(fieldsFromColumns(COLUMNS, KEYS), 'bar');
        expect(after.kind === 'fits' && after.encoding.y?.field).toBe('count Item.Item');
    });

    // Ranking follows: the nonsense charts no longer beat the real one on
    // "fewer unused columns".
    it('ranks the bar chart first now', () => {
        const ranked = allCharts(fieldsFromColumns(COLUMNS, KEYS), {
            rowCount: 13,
            aggregated: true,
        }).filter(v => v.kind === 'fits');
        expect(ranked[0].chart).toBe('bar');
        expect(ranked.map(v => v.chart)).not.toContain('line');
    });

    // Unknown stays unknown — the SQL Editor node has no ER model to ask.
    it('changes nothing when no keys are given', () => {
        expect(fieldsFromColumns(COLUMNS).map(f => f.vlType)).toEqual([
            'quantitative',
            'nominal',
            'quantitative',
        ]);
    });
});

// Found by Ben on the same result as the block above, once the IDs stopped
// being bar HEIGHTS: they were still the bar LABELS. `Vendor` is a category
// after the retyping and comes before `VendorName`, and first-of-its-type wins.
describe('a category channel prefers a name over a key', () => {
    const COLUMNS = [
        { name: 'Vendor', type: 'int64' },
        { name: 'VendorName', type: 'string' },
        { name: 'count Item.Item', type: 'int64' },
    ];
    const KEYS = identifierColumns([{ fromColumn: 'Vendor', toColumn: 'Vendor' }]);

    it('carries the key flag through the retyping', () => {
        const fields = fieldsFromColumns(COLUMNS, KEYS);
        expect(fields.map(x => `${x.name}=${x.vlType}${x.isKey ? ' key' : ''}`)).toEqual([
            'Vendor=nominal key',
            'VendorName=nominal',
            'count Item.Item=quantitative',
        ]);
    });

    // A VARCHAR join column is never retyped, so the flag is the only thing
    // that can tell it from the name beside it.
    it('flags a text key, which nothing retypes', () => {
        const fields = fieldsFromColumns(
            [
                { name: 'VendorCode', type: 'VARCHAR' },
                { name: 'VendorName', type: 'VARCHAR' },
                { name: 'n', type: 'BIGINT' },
            ],
            identifierColumns([{ fromColumn: 'VendorCode', toColumn: 'VendorCode' }]),
        );
        expect(fields.map(x => x.isKey)).toEqual([true, false, false]);
        const v = checkShape(fields, 'bar');
        expect(v.kind === 'fits' && v.encoding.x?.field).toBe('VendorName');
    });

    it('puts the name on the bar chart axis, not the ID', () => {
        // The state this inherits: retyping the key had already taken the ID
        // off the bar HEIGHTS. It left it on the LABELS, because a retyped key
        // is a category and `Vendor` comes first.
        const v = checkShape(fieldsFromColumns(COLUMNS, KEYS), 'bar');
        expect(v.kind === 'fits' && v.encoding.x?.field).toBe('VendorName');
        expect(v.kind === 'fits' && v.encoding.y?.field).toBe('count Item.Item');
        // The ID is not thrown away — it is the leftover, free for the split.
        expect(v.kind === 'fits' && v.unused).not.toContain('count Item.Item');
    });

    // Horizontal bars put the category on y. Same rule, other channel.
    it('does the same for the transposed chart', () => {
        const v = checkShape(fieldsFromColumns(COLUMNS, KEYS), 'barh');
        expect(v.kind === 'fits' && v.encoding.y?.field).toBe('VendorName');
    });

    it('does the same for a pie chart, which is all category', () => {
        const v = checkShape(fieldsFromColumns(COLUMNS, KEYS), 'arc');
        expect(v.kind === 'fits' && v.encoding.color?.field).toBe('VendorName');
    });

    // A tiebreak, not a filter: with nothing else to hand the ID is still the
    // chart, because counting by vendor ID is a real question.
    it('still uses the key when it is the only category', () => {
        const fields = fieldsFromColumns(
            [
                { name: 'Vendor', type: 'int64' },
                { name: 'count Item.Item', type: 'int64' },
            ],
            KEYS,
        );
        const v = checkShape(fields, 'bar');
        expect(v.kind === 'fits' && v.encoding.x?.field).toBe('Vendor');
    });

    // Confined to categories. A date somebody joined on is still the axis you
    // want, and there is no "more descriptive" date to prefer over it.
    it('leaves a temporal channel alone', () => {
        const fields = fieldsFromColumns(
            [
                { name: 'OrderDate', type: 'date' },
                { name: 'ShipDate', type: 'date' },
                { name: 'n', type: 'BIGINT' },
            ],
            identifierColumns([{ fromColumn: 'OrderDate', toColumn: 'OrderDate' }]),
        );
        const v = checkShape(fields, 'line');
        expect(v.kind === 'fits' && v.encoding.x?.field).toBe('OrderDate');
    });

    // Unknown stays unknown: with no ER model to ask, every category is equal
    // again and plain column order decides. That is the SQL Editor node.
    it('falls back to column order when no keys are given', () => {
        const fields = fieldsFromColumns([
            { name: 'VendorCode', type: 'VARCHAR' },
            { name: 'VendorName', type: 'VARCHAR' },
            { name: 'n', type: 'BIGINT' },
        ]);
        const v = checkShape(fields, 'bar');
        expect(v.kind === 'fits' && v.encoding.x?.field).toBe('VendorCode');
    });
});

// Stephen Few's bullet graph. The first contract here that is not one mark with
// channels — `label`/`measure`/`target`/`range1..3` become LAYERS, not Vega-Lite
// channels, and `chart-spec.ts` is the only thing that knows that.
describe('the bullet graph', () => {
    const BULLET = [
        f('Region', 'nominal'),
        f('actual', 'quantitative'),
        f('target', 'quantitative'),
    ];

    it('fits a category, a measure and a target', () => {
        const v = checkShape(BULLET, 'bullet');
        expect(v.kind).toBe('fits');
        expect(proposeEncoding(v)).toEqual({
            label: { field: 'Region', type: 'nominal' },
            measure: { field: 'actual', type: 'quantitative' },
            target: { field: 'target', type: 'quantitative' },
        });
    });

    // The decision that makes the chart worth offering: without its comparative
    // measure a bullet graph is a bar chart, and it would match everything a bar
    // chart matches.
    it('will not draw without a target', () => {
        const v = checkShape([f('Region', 'nominal'), f('actual', 'quantitative')], 'bullet');
        expect(v.kind).toBe('close');
        expect(missingSummary(v)).toBe('needs the target to compare it against');
    });

    // It is SUGGESTED for a plain category and count, but only as a `close` —
    // "add a target and this becomes a bullet graph", which is the whole reason
    // `suggestCharts` keeps near misses. What it must never be is a fit.
    it('offers itself as a near miss, not as a fit, without a target', () => {
        const v = suggestCharts(VENDOR_COUNT).find(x => x.chart === 'bullet');
        expect(v?.kind).toBe('close');
        expect(suggestCharts(VENDOR_COUNT, false).map(x => x.chart)).not.toContain('bullet');
    });

    // The ranges are a JUDGEMENT about what counts as good, so no spare column
    // becomes one by accident.
    it('never fills a range from the leftover columns', () => {
        const v = checkShape([...BULLET, f('n', 'quantitative'), f('m', 'quantitative')], 'bullet');
        expect(v.kind === 'fits' && Object.keys(v.encoding).sort()).toEqual([
            'label',
            'measure',
            'target',
        ]);
        expect(v.kind === 'fits' && v.unused.sort()).toEqual(['m', 'n']);
    });

    // And so the greedy-optional ranking trap does not repeat. `unused` is the
    // tiebreak between fitting charts, so a chart with three hungry optional
    // channels climbs it just by being wide enough to swallow the spares — which
    // is exactly how the line chart came to outrank the bar chart over an ID.
    //
    // A bullet graph consumes THREE columns and never more, so every spare
    // number costs it a place rather than earning one.
    it('cannot climb the ranking by eating spare columns', () => {
        const unusedWith = (spares: number) => {
            const v = checkShape(
                [...BULLET, ...Array.from({ length: spares }, (_, i) => f(`n${i}`, 'quantitative'))],
                'bullet',
            );
            return v.kind === 'fits' ? v.unused.length : -1;
        };
        expect([unusedWith(0), unusedWith(1), unusedWith(3)]).toEqual([0, 1, 3]);
    });

    // Where it DOES climb is the shape it is for: a bar chart of one category
    // and two measures leaves the target over, and the bullet graph does not.
    //
    // Not asserted as FIRST, because a line chart ties it at zero unused here —
    // `line` takes a quantitative x, so it offers `actual` against `target` as a
    // series. That is the pre-existing "a line over two unordered measures"
    // looseness, not something this contract introduced.
    it('outranks the bar chart on a category, a measure and a target', () => {
        const ranked = allCharts(BULLET).filter(v => v.kind === 'fits').map(v => v.chart);
        expect(ranked.indexOf('bullet')).toBeLessThan(ranked.indexOf('bar'));
        expect(checkShape(BULLET, 'bullet')).toMatchObject({ kind: 'fits', unused: [] });
        expect(checkShape(BULLET, 'bar')).toMatchObject({ kind: 'fits', unused: ['target'] });
    });

    // A range can still be PUT there — it is optional, not absent.
    it('accepts a range when one is assigned', () => {
        const needs = CHART_SHAPES.find(s => s.type === 'bullet')!.variants[0].needs;
        const range = needs.find(n => n.channel === 'range2')!;
        expect(range.required).toBe(false);
        expect(range.autofill).toBe(false);
        expect(range.accepts).toEqual(['quantitative']);
    });
});

// Tufte's sparkline in Few's table layout. Reuses `x` and `y` rather than
// inventing channels — unlike the bullet graph's layers these really are the
// inner view's axes, and the only unusual part is that the view repeats.
describe('the sparkline table', () => {
    const SERIES = [
        f('Category', 'nominal'),
        f('Month', 'temporal'),
        f('Spend', 'quantitative'),
    ];

    it('fits a category, a timeline and a measure', () => {
        const v = checkShape(SERIES, 'sparkline');
        expect(v.kind).toBe('fits');
        expect(proposeEncoding(v)).toEqual({
            label: { field: 'Category', type: 'nominal' },
            x: { field: 'Month', type: 'temporal' },
            y: { field: 'Spend', type: 'quantitative' },
        });
    });

    it('needs a category to split the rows by', () => {
        const v = checkShape([f('Month', 'temporal'), f('Spend', 'quantitative')], 'sparkline');
        expect(v.kind).toBe('close');
        expect(missingSummary(v)).toBe('needs a category for each row');
    });

    // A number works as well as a date: a sparkline over a period index is the
    // same chart. Same latitude the line chart's x already has.
    it('takes a number for the timeline as well as a date', () => {
        const v = checkShape(
            [f('Category', 'nominal'), f('Period', 'quantitative'), f('Spend', 'quantitative')],
            'sparkline',
        );
        expect(v.kind).toBe('fits');
        expect(v.kind === 'fits' && v.encoding.x?.field).toBe('Period');
    });

    // The honest gap. It needs several rows per row-label, and multiplicity is
    // not in a column's type — one row per category draws a panel each holding
    // a single point and no line. The box plot hit the same wall; `DAA.101` is
    // what would close it. Recorded as a test so the gap is not mistaken for an
    // oversight.
    it('cannot yet tell a real series from one row per category', () => {
        const oneEach = checkShape(SERIES, 'sparkline', { rowCount: 3, aggregated: true });
        expect(oneEach.kind).toBe('fits');
    });

    it('is offered alongside the line chart, not instead of it', () => {
        const charts = suggestCharts(SERIES).map(v => v.chart);
        expect(charts).toContain('sparkline');
        expect(charts).toContain('line');
    });
});
