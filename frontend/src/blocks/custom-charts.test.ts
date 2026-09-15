import { describe, expect, it } from 'vitest';
import type { Field } from './chart-shapes';
import {
    applyCustom,
    cannedRowsFor,
    checkCustom,
    customId,
    customSummary,
    customThumb,
    isCustomChart,
    parseCustomCharts,
    removeCustom,
    storedCustomCharts,
    upsertCustom,
    variantFromSpec,
    type CustomChart,
} from './custom-charts';

const f = (name: string, vlType: Field['vlType']): Field => ({ name, vlType });

/** A template somebody saved: styled bars, made over Vendor/count. */
const TEMPLATE: CustomChart = {
    id: 'ranked-abc12',
    name: 'Ranked bars, our house style',
    spec: {
        mark: { type: 'bar', cornerRadiusEnd: 4 },
        encoding: {
            y: { field: 'Vendor', type: 'nominal', sort: '-x', axis: { labelLimit: 200 } },
            x: { field: 'count Item.Item', type: 'quantitative', axis: { format: ',.0f' } },
        },
        config: { bar: { fill: '#ff7a45' } },
    },
};

/** The NEXT query's columns — different names, same shape. */
const OTHER = [f('Manufacturer', 'nominal'), f('n', 'quantitative')];

describe('variantFromSpec', () => {
    it('reads the channels and their types as a contract', () => {
        const v = variantFromSpec(TEMPLATE.spec)!;
        expect(v.needs.map(n => [n.channel, n.accepts, n.required])).toEqual([
            ['x', ['quantitative'], true],
            ['y', ['nominal', 'ordinal'], true],
        ]);
    });

    // Colour and size are garnish. Demanding them would make half the
    // templates permanently unusable.
    it('makes colour and size optional', () => {
        const v = variantFromSpec({
            mark: 'bar',
            encoding: {
                x: { field: 'a', type: 'nominal' },
                y: { field: 'b', type: 'quantitative' },
                color: { field: 'c', type: 'nominal' },
                size: { field: 'd', type: 'quantitative' },
            },
        })!;
        expect(v.needs.filter(n => !n.required).map(n => n.channel)).toEqual(['color', 'size']);
    });

    // A channel with no field is not a column slot.
    it('ignores a constant and a fieldless aggregate', () => {
        const v = variantFromSpec({
            mark: 'bar',
            encoding: {
                x: { field: 'a', type: 'nominal' },
                y: { aggregate: 'count', type: 'quantitative' },
                color: { value: 'red' },
            },
        })!;
        expect(v.needs.map(n => n.channel)).toEqual(['x']);
    });

    // Layered and faceted templates are most of the reason to want custom
    // charts, so they must still be savable — they just have no top-level
    // contract to read.
    it('returns null for a spec with no top-level encoding', () => {
        expect(variantFromSpec({ layer: [{ mark: 'bar' }] })).toBeNull();
        expect(variantFromSpec({ mark: 'bar' })).toBeNull();
        expect(variantFromSpec({ mark: 'bar', encoding: {} })).toBeNull();
    });
});

// The whole point: what carries over is the SHAPE, not two column names.
describe('checkCustom', () => {
    it('fits a different query of the same shape', () => {
        const v = checkCustom(TEMPLATE, OTHER);
        expect(v.kind).toBe('fits');
        expect(v.encoding).toEqual({
            x: { field: 'n', type: 'quantitative' },
            y: { field: 'Manufacturer', type: 'nominal' },
        });
    });

    it('says what is missing rather than drawing nothing', () => {
        const v = checkCustom(TEMPLATE, [f('Manufacturer', 'nominal')]);
        expect(v.kind).toBe('close');
        expect(customSummary(v)).toBe('needs a number for x');
    });

    it('reports wrong when more than one channel cannot be filled', () => {
        expect(checkCustom(TEMPLATE, []).kind).toBe('wrong');
    });

    it('calls an unreadable template unreadable, not wrong', () => {
        const layered: CustomChart = { id: 'l', name: 'L', spec: { layer: [{ mark: 'bar' }] } };
        const v = checkCustom(layered, OTHER);
        expect(v.kind).toBe('unreadable');
        expect(customSummary(v)).toContain('as-is');
    });

    it('fits nothing when the result has no chartable column', () => {
        expect(checkCustom(TEMPLATE, []).encoding).toBeUndefined();
    });
});

describe('applyCustom', () => {
    it('swaps the fields for this result and keeps everything else', () => {
        const v = checkCustom(TEMPLATE, OTHER);
        const spec = applyCustom(TEMPLATE, v.encoding) as Record<string, never>;
        const enc = spec.encoding as unknown as Record<string, Record<string, unknown>>;
        expect(enc.y.field).toBe('Manufacturer');
        expect(enc.x.field).toBe('n');
        // The styling IS the reason the template was saved; none of it may be
        // normalised away.
        expect(enc.y.sort).toBe('-x');
        expect(enc.y.axis).toEqual({ labelLimit: 200 });
        expect(enc.x.axis).toEqual({ format: ',.0f' });
        expect(spec.mark).toEqual({ type: 'bar', cornerRadiusEnd: 4 });
        expect(spec.config).toEqual({ bar: { fill: '#ff7a45' } });
    });

    it('escapes a dotted column on the way in', () => {
        const v = checkCustom(TEMPLATE, [
            f('Vendor', 'nominal'),
            f('count Item.Item', 'quantitative'),
        ]);
        const spec = applyCustom(TEMPLATE, v.encoding) as Record<string, never>;
        const enc = spec.encoding as unknown as Record<string, Record<string, unknown>>;
        expect(enc.x.field).toBe('count Item\\.Item');
    });

    it('does not mutate the stored template', () => {
        const before = JSON.stringify(TEMPLATE.spec);
        applyCustom(TEMPLATE, checkCustom(TEMPLATE, OTHER).encoding);
        expect(JSON.stringify(TEMPLATE.spec)).toBe(before);
    });

    it('hands back an unreadable template untouched', () => {
        const layered: CustomChart = {
            id: 'l',
            name: 'L',
            spec: { layer: [{ mark: 'bar', encoding: { x: { field: 'keep', type: 'nominal' } } }] },
        };
        expect(applyCustom(layered, undefined)).toEqual(layered.spec);
    });
});

describe('thumbnails', () => {
    it('invents rows keyed by the template s own field names', () => {
        const rows = cannedRowsFor(TEMPLATE.spec);
        expect(rows.length).toBeGreaterThan(0);
        expect(Object.keys(rows[0]).sort()).toEqual(['Vendor', 'count Item.Item']);
        expect(typeof rows[0]['count Item.Item']).toBe('number');
        expect(typeof rows[0].Vendor).toBe('string');
    });

    it('gives a dated column real dates', () => {
        const rows = cannedRowsFor({
            mark: 'line',
            encoding: {
                x: { field: 'd', type: 'temporal' },
                y: { field: 'v', type: 'quantitative' },
            },
        });
        expect(Number.isNaN(Date.parse(String(rows[0].d)))).toBe(false);
    });

    it('sizes the card and drops the title, which would overflow 46px', () => {
        const t = customThumb(TEMPLATE.spec) as Record<string, unknown>;
        expect(t.width).toBe(76);
        expect(t.title).toBeNull();
        expect((t.data as { values: unknown[] }).values.length).toBeGreaterThan(0);
    });

    it('declines rather than drawing a card it cannot fill', () => {
        expect(customThumb({ layer: [{ mark: 'bar' }] })).toBeNull();
    });
});

describe('persistence', () => {
    it('round-trips through the stored shape', () => {
        const stored = storedCustomCharts([TEMPLATE]);
        expect(parseCustomCharts(stored).map(c => c.id)).toEqual([TEMPLATE.id]);
    });

    it('drops a malformed entry rather than the whole file', () => {
        const charts = parseCustomCharts({
            charts: [TEMPLATE, { id: 'x' }, { name: 'no spec', id: 'y' }],
        });
        expect(charts).toHaveLength(1);
    });

    it('survives a payload that was never written', () => {
        expect(parseCustomCharts(null)).toEqual([]);
        expect(parseCustomCharts({})).toEqual([]);
    });

    it('upserts by id, newest first', () => {
        const other = { ...TEMPLATE, id: 'other-1', name: 'Other' };
        const list = upsertCustom(upsertCustom([], TEMPLATE), other);
        expect(list.map(c => c.id)).toEqual(['other-1', 'ranked-abc12']);
        const revised = upsertCustom(list, { ...TEMPLATE, name: 'Renamed' });
        expect(revised).toHaveLength(2);
        expect(revised[0].name).toBe('Renamed');
    });

    it('removes by id', () => {
        expect(removeCustom([TEMPLATE], TEMPLATE.id)).toEqual([]);
    });

    it.each([
        ['no id', { name: 'n', spec: {} }],
        ['no name', { id: 'i', spec: {} }],
        ['a spec that is not an object', { id: 'i', name: 'n', spec: 'bar' }],
    ])('refuses %s', (_l, raw) => {
        expect(isCustomChart(raw)).toBe(false);
    });
});

describe('customId', () => {
    it('slugifies the name', () => {
        expect(customId('Ranked bars, our house style')).toMatch(
            /^ranked-bars-our-house-style-[a-z0-9]{5}$/,
        );
    });

    it('falls back rather than producing a bare suffix', () => {
        expect(customId('***')).toMatch(/^chart-[a-z0-9]{5}$/);
    });
});

// A template saved from the controls carries ESCAPED field references, because
// Vega-Lite reads a dot as nested access. Canned rows are DATA, so they must be
// keyed by the real column name — keyed by the escaped literal, every
// GUI-built template had a blank thumbnail.
describe('a template with a dotted column', () => {
    const escaped: CustomChart = {
        id: 'd',
        name: 'Dotted',
        spec: {
            mark: 'bar',
            encoding: {
                x: { field: 'Vendor', type: 'nominal' },
                y: { field: 'count Item\.Item', type: 'quantitative' },
            },
        },
    };

    it('keys its canned rows by the real column name', () => {
        const rows = cannedRowsFor(escaped.spec);
        expect(Object.keys(rows[0]).sort()).toEqual(['Vendor', 'count Item.Item']);
        expect(typeof rows[0]['count Item.Item']).toBe('number');
    });

    it('still reads as a contract, and still matches by shape', () => {
        expect(checkCustom(escaped, OTHER).kind).toBe('fits');
    });

    it('draws a thumbnail rather than an empty card', () => {
        const t = customThumb(escaped.spec) as Record<string, { values: unknown[] }>;
        expect(t.data.values.length).toBeGreaterThan(0);
    });
});
