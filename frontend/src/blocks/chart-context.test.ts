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
