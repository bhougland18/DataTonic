import { describe, expect, it } from 'vitest';
import { CHART_SHAPES } from './chart-shapes';
import { thumbSpec } from './chart-thumbnails';
import { readSpec } from './chart-spec';

const TYPES = CHART_SHAPES.map(s => s.type);

describe('thumbSpec', () => {
    // A gallery missing a card is a chart type nobody can pick. The exhaustive
    // switch makes this a compile error too; this catches a `default` branch
    // being added later to silence one.
    it.each(TYPES)('has a thumbnail for %s', type => {
        expect(thumbSpec(type)).toBeTruthy();
    });

    /**
     * The view a thumbnail's size and encoding actually live on.
     *
     * A FACETED thumbnail cannot carry either at the top level — Vega-Lite
     * refuses a top-level width on a facet, which is the same rule that sent
     * `VegaChart` looking for `child_width`. So the size moves inward with the
     * view, and the assertions follow it rather than being relaxed.
     */
    const sized = (spec: Record<string, unknown>): Record<string, unknown> =>
        'facet' in spec ? (spec.spec as Record<string, unknown>) : spec;

    it.each(TYPES)('%s carries its own data and a fixed size', type => {
        const spec = thumbSpec(type) as Record<string, unknown>;
        expect((spec.data as { values: unknown[] }).values.length).toBeGreaterThan(0);
        const view = sized(spec);
        expect(view.width).toBeDefined();
        expect(view.height).toBeDefined();
    });

    it.each(TYPES)('%s encodes at least one channel', type => {
        const view = sized(thumbSpec(type) as Record<string, unknown>);
        expect(Object.keys(view.encoding as object).length).toBeGreaterThan(0);
    });

    it('hands back a fresh object each time, since vega may mutate what it is given', () => {
        expect(thumbSpec('bar')).not.toBe(thumbSpec('bar'));
    });

    // The point of the split: a thumbnail is decoration with a baked size and
    // inline rows, which is exactly what a block's chart must never be. If
    // `readSpec` ever accepted one, the two would have collapsed into each
    // other and a thumbnail could be saved as a document.
    it.each(TYPES)('%s is not mistakable for an editable document', type => {
        expect(readSpec(thumbSpec(type))).toBeNull();
    });
});
