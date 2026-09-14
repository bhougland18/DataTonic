// What the AI pane is told about the result on screen.
//
// Without this the pane answers charting questions from general knowledge, and
// general knowledge about charting is mostly Python. Asked "what do I need to
// add to use a line chart", it recommended `matplotlib` and the `datetime`
// module — advice for a tool that is not in this product, about columns it had
// never seen.
//
// Both halves of that failure are fixed here: the CONTEXT (these columns, these
// types, these charts already fit) and, in `AiPane`'s system prompt, the frame
// (charting here means Vega-Lite).
//
// A string rather than a component or a hook, because it has to cross from
// `blocks/` — which knows about charts — into `sqleditor/AiPane`, which is
// shared with the SQL Editor node and must not learn about them. Same seam as
// `QueryPane`'s `resultInfo`: the pane takes opaque context, Blocks decides
// what goes in it.

import type { SqlRunResult } from '../sqleditor/types';
import {
    checkShape,
    fieldsFromColumns,
    missingSummary,
    shapeFor,
    suggestCharts,
    vlTypeOf,
    type ShapeContext,
    type Verdict,
} from './chart-shapes';

/** How many near misses to describe. The rest are noise in a prompt. */
const MAX_NEAR = 4;

const line = (v: Verdict): string => {
    const label = shapeFor(v.chart)?.label ?? v.chart;
    if (v.kind === 'fits') {
        const enc = Object.entries(v.encoding)
            .map(([ch, e]) => `${ch}=${e.field}`)
            .join(', ');
        return `  - ${label} (${v.variant.label}): ${enc || 'no channels'}`;
    }
    return `  - ${label}: ${missingSummary(v)}`;
};

/**
 * The result's shape and what it can already be charted as.
 *
 * Column TYPES are given as Vega-Lite types beside the DuckDB ones, because the
 * question the pane gets asked is a Vega-Lite question ("why can't I use a line
 * chart") and the answer turns on `temporal` vs `nominal`, not on `VARCHAR`.
 * Making the model do that translation itself is the step it has no reason to
 * get right.
 *
 * Returns '' when there is no result — a prompt that describes an empty result
 * invites the model to reason about one.
 */
export function chartContext(
    result: SqlRunResult | null | undefined,
    ctx?: ShapeContext,
): string {
    if (!result || result.error || result.columns.length === 0) return '';

    const fields = fieldsFromColumns(result.columns);
    const lines: string[] = [
        'THE RESULT CURRENTLY ON SCREEN',
        `${result.rows.length} row${result.rows.length === 1 ? '' : 's'}. Columns, with their Vega-Lite types:`,
    ];
    for (const c of result.columns) {
        const vl = vlTypeOf(c.type);
        lines.push(
            `  - ${c.name}: ${c.type ?? 'unknown'} -> ${vl ?? 'not chartable'}`,
        );
    }

    // Same context the strip uses, so the pane and the strip never disagree
    // about whether a box plot is worth drawing.
    const suggestions = suggestCharts(fields, true, {
        rowCount: result.rows.length,
        ...ctx,
    });
    const fits = suggestions.filter(v => v.kind === 'fits');
    const near = suggestions.filter(v => v.kind === 'close').slice(0, MAX_NEAR);

    lines.push('', 'Charts this result ALREADY fits:');
    lines.push(...(fits.length ? fits.map(line) : ['  (none)']));

    if (near.length) {
        // The near misses are the whole reason somebody opens the pane: the
        // chart they wanted is not in the list and they want to know why.
        lines.push('', 'Charts it does NOT fit yet, and what each is missing:');
        lines.push(...near.map(line));
    }

    // Named explicitly because it is the most common real answer and the one a
    // model is least likely to reach for: the fix is usually a different SELECT,
    // not a different chart library.
    lines.push(
        '',
        'To make a missing chart possible the user changes the QUERY — adding a',
        'column, an aggregate, or a date — not the chart library. Answer in terms of',
        'which column to add and where it would go.',
    );
    return lines.join('\n');
}

/** The verdict for one chart, phrased for a prompt. Used when a type is chosen. */
export function chartVerdictLine(
    result: SqlRunResult | null | undefined,
    chart: Parameters<typeof checkShape>[1],
): string {
    if (!result || result.error || result.columns.length === 0) return '';
    return line(checkShape(fieldsFromColumns(result.columns), chart));
}
