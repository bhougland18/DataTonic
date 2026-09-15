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

    it.each(TYPES)('%s carries its own data and a fixed size', type => {
        const spec = thumbSpec(type) as Record<string, Record<string, unknown[]>>;
        expect(spec.data.values.length).toBeGreaterThan(0);
        expect(spec.width).toBeDefined();
        expect(spec.height).toBeDefined();
    });

    it.each(TYPES)('%s encodes at least one channel', type => {
        expect(Object.keys(thumbSpec(type).encoding as object).length).toBeGreaterThan(0);
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
