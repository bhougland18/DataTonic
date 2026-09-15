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
import { encodedChannels, markType, buildSpec, type ChartSpecState } from './chart-spec';

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
    /**
     * The chart being edited, when one has been picked.
     *
     * Changes what the pane is being asked. Before a chart exists the question
     * is "what could this be"; afterwards it is almost always "why does THIS
     * one look wrong", and answering that from the list of everything that fits
     * is answering a question nobody asked.
     */
    chosen?: ChartSpecState | null,
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

    if (chosen) lines.push('', ...chosenLines(chosen, fields, ctx));
    return lines.join('\n');
}

/**
 * The chart on the Charts step, described as a chart rather than as JSON.
 *
 * The channels, not the spec: asked "why is my bar chart empty", the useful
 * answer turns on which column is on which channel, and a model given raw JSON
 * spends its answer restating the JSON. The mark name is given too, because it
 * is the word the user will see if they open the spec.
 */
function chosenLines(
    chosen: ChartSpecState,
    fields: Parameters<typeof checkShape>[0],
    ctx?: ShapeContext,
): string[] {
    const shape = shapeFor(chosen.chart);
    const verdict = checkShape(fields, chosen.chart, ctx);
    const out = [
        'THE CHART THE USER IS EDITING',
        `${shape?.label ?? chosen.chart} — Vega-Lite mark "${markType(buildSpec(chosen)) ?? chosen.chart}".`,
    ];
    for (const ch of encodedChannels(chosen)) {
        const c = chosen.encoding[ch];
        if (!c) continue;
        const what = c.count ? 'a count of rows' : c.field;
        out.push(`  - ${ch} = ${what} (${c.type})${c.bin ? ', binned by the spec' : ''}`);
    }
    if (chosen.title?.trim()) out.push(`Titled "${chosen.title.trim()}".`);
    out.push(
        verdict.kind === 'fits'
            ? 'The result fits this chart.'
            : `The result does not fit it: ${missingSummary(verdict)}.`,
    );
    // Says where the edit lands, so the answer is something the user can do
    // rather than a spec they have nowhere to put.
    out.push(
        'The user adjusts it with the chart controls — which column is on which channel,',
        'titles, sort, scale, colour, legend, number format — or by editing the Vega-Lite',
        'spec directly. Shaping the data is done in the SQL, never in the spec.',
    );
    return out;
}
