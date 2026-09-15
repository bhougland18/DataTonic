import { describe, expect, it } from 'vitest';
import type { Column, DataType } from '../pipeline-types';
import { markType, readSpec } from '../blocks/chart-spec';
import { suggestChart } from './suggest-chart';

const col = (name: string, type: DataType): Column => ({ name, type, nullable: true });

/** What channel got what, for an assertion that reads like the chart. */
function encoding(spec: Record<string, unknown> | null) {
    const state = spec ? readSpec(spec) : null;
    if (!state) return null;
    return Object.fromEntries(
        Object.entries(state.encoding).map(([ch, c]) => [ch, c?.field ?? (c?.count ? 'count' : '')]),
    );
}

// Pinned because the implementation changed underneath it: the decision order
// is the same one the hand-rolled version made, so a dive that auto-charted as
// a line before must not quietly become something else.
describe('suggestChart keeps the decision order it had', () => {
    it('charts time + measure as a line', () => {
        const spec = suggestChart([col('AddedDate', 'date'), col('n', 'int64')]);
        expect(markType(spec!)).toBe('line');
        expect(encoding(spec)).toEqual({ x: 'AddedDate', y: 'n' });
    });

    it('charts category + measure as a bar', () => {
        const spec = suggestChart([col('Vendor', 'string'), col('n', 'int64')]);
        expect(markType(spec!)).toBe('bar');
        expect(encoding(spec)).toEqual({ x: 'Vendor', y: 'n' });
    });

    // The reason this is not simply "the best-ranked fit": a line accepts a
    // quantitative x on purpose, so ranking alone would call this a line.
    it('charts two measures as a scatter, not a line', () => {
        const spec = suggestChart([col('UnitCost', 'float64'), col('OnHand', 'int64')]);
        expect(markType(spec!)).toBe('point');
        expect(encoding(spec)).toEqual({ x: 'UnitCost', y: 'OnHand' });
    });

    it('falls back to the table when nothing sensible fits', () => {
        expect(suggestChart([col('Vendor', 'string')])).toBeNull();
        expect(suggestChart([])).toBeNull();
    });
});

// What delegating to the shared matcher actually bought. The old three-role
// regex got all of these wrong.
describe('suggestChart inherits the better type mapping', () => {
    it('does not put a list of numbers on an axis', () => {
        // `INTEGER[]` contains "integer", which is what the old regex read.
        const cols = [
            { name: 'Sizes', type: 'INTEGER[]' as unknown as DataType, nullable: true },
            col('Vendor', 'string'),
        ];
        expect(suggestChart(cols)).toBeNull();
    });

    it('treats a boolean as a category rather than a magnitude', () => {
        const spec = suggestChart([col('Active', 'bool'), col('n', 'int64')]);
        expect(markType(spec!)).toBe('bar');
        expect(encoding(spec)).toEqual({ x: 'Active', y: 'n' });
    });

    it('produces a spec with no data, width or height for the renderer to bind', () => {
        const spec = suggestChart([col('Vendor', 'string'), col('n', 'int64')])!;
        expect(spec).not.toHaveProperty('data');
        expect(spec).not.toHaveProperty('width');
    });
});
