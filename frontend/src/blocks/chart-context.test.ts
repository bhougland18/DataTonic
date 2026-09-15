import { describe, expect, it } from 'vitest';
import { chartContext } from './chart-context';
import type { SqlRunResult } from '../sqleditor/types';

const result = (
    columns: { name: string; type?: string }[],
    rows = 1,
    error?: string,
): SqlRunResult => ({
    columns,
    rows: Array.from({ length: rows }, () => ({})),
    error,
});

/** The query on screen when the pane recommended matplotlib. */
const MEDLINE = result(
    [
        { name: 'ItemGroup', type: 'VARCHAR' },
        { name: 'Item', type: 'VARCHAR' },
        { name: 'UOMConversion', type: 'DOUBLE' },
        { name: 'Vendor', type: 'BIGINT' },
    ],
    55,
);

describe('chartContext', () => {
    it('says nothing when there is nothing on screen', () => {
        expect(chartContext(null)).toBe('');
        expect(chartContext(undefined)).toBe('');
        expect(chartContext(result([], 0))).toBe('');
    });

    // A failed run must not leave the model describing the result before it.
    it('says nothing for a failed run', () => {
        expect(chartContext(result([{ name: 'a', type: 'VARCHAR' }], 0, 'boom'))).toBe('');
    });

    it('gives every column its DuckDB and Vega-Lite type', () => {
        const text = chartContext(MEDLINE);
        expect(text).toContain('ItemGroup: VARCHAR -> nominal');
        expect(text).toContain('UOMConversion: DOUBLE -> quantitative');
    });

    it('states the row count', () => {
        expect(chartContext(MEDLINE)).toContain('55 rows');
    });

    it('lists the charts that already fit, with their channels', () => {
        const text = chartContext(MEDLINE);
        expect(text).toContain('Charts this result ALREADY fits:');
        expect(text).toMatch(/Bar chart.*x=/);
    });

    // The reason somebody opens the pane: the chart they wanted is missing and
    // they want to know what it would take.
    it('lists near misses and what each one needs', () => {
        const text = chartContext(result([{ name: 'Vendor', type: 'VARCHAR' }], 10));
        expect(text).toContain('does NOT fit yet');
        expect(text).toContain('needs a number');
    });

    it('points the fix at the query, not at a chart library', () => {
        expect(chartContext(MEDLINE)).toContain('changes the QUERY');
    });

    it('marks a column that cannot be plotted at all', () => {
        const text = chartContext(result([{ name: 'tags', type: 'VARCHAR[]' }], 3));
        expect(text).toContain('tags: VARCHAR[] -> not chartable');
    });

    it('reports honestly when nothing fits', () => {
        const text = chartContext(result([{ name: 'tags', type: 'VARCHAR[]' }], 3));
        expect(text).toContain('(none)');
    });

    it('never names a chart library', () => {
        const text = chartContext(MEDLINE).toLowerCase();
        for (const tool of ['matplotlib', 'seaborn', 'plotly', 'ggplot', 'python', 'excel']) {
            expect(text).not.toContain(tool);
        }
    });
});

// Once a chart is picked the pane is almost never being asked "what could this
// be" any more — it is being asked why THIS one looks wrong.
describe('chartContext with a chart chosen', () => {
    const bars = {
        chart: 'bar' as const,
        title: 'Items per group',
        encoding: {
            x: { field: 'ItemGroup', type: 'nominal' as const },
            y: { field: 'UOMConversion', type: 'quantitative' as const },
        },
    };

    it('says nothing extra until one is picked', () => {
        expect(chartContext(MEDLINE)).not.toContain('THE CHART THE USER IS EDITING');
    });

    it('describes the chart by its channels, not as JSON', () => {
        const text = chartContext(MEDLINE, undefined, bars);
        expect(text).toContain('THE CHART THE USER IS EDITING');
        expect(text).toContain('x = ItemGroup (nominal)');
        expect(text).toContain('y = UOMConversion (quantitative)');
        expect(text).toContain('Titled "Items per group"');
    });

    it('names the mark, which is the word the spec will show', () => {
        expect(chartContext(MEDLINE, undefined, bars)).toContain('mark "bar"');
    });

    it('says whether the result still fits it', () => {
        expect(chartContext(MEDLINE, undefined, bars)).toContain('The result fits this chart.');
        const gone = chartContext(result([{ name: 'ItemGroup', type: 'VARCHAR' }], 4), undefined, bars);
        expect(gone).toContain('does not fit it');
    });

    // A histogram's count has no column behind it, so naming one would be a
    // lie the model would then repeat back.
    it('describes a binned count as what it is', () => {
        const hist = {
            chart: 'histogram' as const,
            encoding: {
                x: { field: 'UOMConversion', type: 'quantitative' as const, bin: true },
                y: { count: true, type: 'quantitative' as const },
            },
        };
        const text = chartContext(MEDLINE, undefined, hist);
        expect(text).toContain('x = UOMConversion (quantitative), binned by the spec');
        expect(text).toContain('y = a count of rows');
    });

    // The rule that keeps the two halves of the product straight (plan §9).
    it('still points reshaping at the SQL', () => {
        expect(chartContext(MEDLINE, undefined, bars)).toContain('Shaping the data is done in the SQL');
    });

    it('never names a chart library', () => {
        const text = chartContext(MEDLINE, undefined, bars).toLowerCase();
        for (const tool of ['matplotlib', 'seaborn', 'plotly', 'ggplot', 'python', 'excel']) {
            expect(text).not.toContain(tool);
        }
    });
});
