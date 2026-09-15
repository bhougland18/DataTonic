// Pick ONE reasonable Vega-Lite chart for a result's columns, or null to fall
// back to a plain table. The dives gallery's auto-chart default, used when a
// dive's own spec does not resolve against the rows it got back.
//
// DELEGATES to `blocks/chart-shapes.ts`, which owns the DuckDB-type-to-Vega-Lite
// mapping and the column-to-channel assignment. This file used to carry its own
// three-role regex, and it was the weaker of the two in ways that mattered:
// `INTEGER[]` read as quantitative (a list of numbers is not a number), a
// composite went on an axis, and there was no notion of a variant. One
// definition now, so the gallery gets the better answer for free.
//
// SUGGESTING IS NOT SELECTING, and that is why this function still exists.
// `suggestCharts` RANKS every mark and keeps the near misses — it is an offer,
// and the Blocks Charts step puts it in front of a person who chooses. This
// picks one automatically, which is only ever right where there is nobody to
// ask: a saved dive being opened, whose own chart no longer fits its rows. Do
// not reach for it on an authoring surface. A chart that appears without being
// asked for is a claim about what the data means, and that claim is the user's
// to make.

import type { Column } from '../pipeline-types';
import type { DiveChart } from './dive-types';
import { checkShape, fieldsFromColumns, type ChartType } from '../blocks/chart-shapes';
import { buildSpec, stateFromVerdict } from '../blocks/chart-spec';

/**
 * The preference order, and why it is not just "the best-ranked fit".
 *
 * `suggestCharts` ranks by fit quality, which is the right answer to "what
 * could I chart" and the wrong one here: a line chart accepts a quantitative x
 * deliberately (`chart-shapes.ts`), so two measures rank as a line before they
 * rank as a scatter. Two measures against each other is a scatter plot, and it
 * was already what this function did.
 *
 * So the decision order stays what it was — time + measure is a line, category
 * + measure is a bar, two measures are a scatter — and only the type mapping
 * and the channel assignment moved. A line is offered ONLY when something
 * temporal exists, which is what makes the rest of the order work.
 */
function order(hasTemporal: boolean): ChartType[] {
    return hasTemporal ? ['line', 'bar', 'point'] : ['bar', 'point'];
}

export function suggestChart(columns: Column[]): DiveChart | null {
    const fields = fieldsFromColumns(columns.map(c => ({ name: c.name, type: c.type })));
    const hasTemporal = fields.some(f => f.vlType === 'temporal');
    for (const chart of order(hasTemporal)) {
        const state = stateFromVerdict(checkShape(fields, chart));
        if (state) return buildSpec(state);
    }
    return null; // nothing sensible to chart -> render the table
}
