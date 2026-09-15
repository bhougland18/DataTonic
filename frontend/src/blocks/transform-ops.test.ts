import { describe, expect, it } from 'vitest';
import {
    argText,
    opById,
    opsFor,
    suggestedAlias,
    transformExpression,
    transformIsComplete,
    TRANSFORM_OPS,
} from './transform-ops';
import { aggregatesFor, newTransform, type ColumnTransform } from './builder-types';

const t = (over: Partial<ColumnTransform> = {}): ColumnTransform => ({
    ...newTransform('aggregate', 'sum'),
    table: 'Line',
    column: 'Quantity',
    alias: 'Total Qty',
    ...over,
});

describe('opsFor', () => {
    it('offers arithmetic on a numeric column', () => {
        const ids = opsFor('aggregate', 'INTEGER').map(o => o.id);
        expect(ids).toContain('sum');
        expect(ids).toContain('avg');
    });

    // Absent, not disabled. `sum(VARCHAR)` does not return something odd - it
    // does not run at all, so offering it is offering a dead end.
    it('withholds sum and avg from text, keeping counts and extremes', () => {
        const ids = opsFor('aggregate', 'VARCHAR').map(o => o.id);
        expect(ids).not.toContain('sum');
        expect(ids).not.toContain('avg');
        expect(ids).toEqual(expect.arrayContaining(['count', 'count distinct', 'min', 'max']));
    });

    // One answer per family to "is this a number?", not two that can drift.
    it('agrees with aggregatesFor rather than testing types again', () => {
        for (const type of ['INTEGER', 'VARCHAR', 'DATE', 'float64', undefined]) {
            const fromOps = opsFor('aggregate', type)
                .map(o => o.id)
                .sort();
            const fromAggregates = aggregatesFor(type)
                .filter(a => a !== 'none')
                .sort();
            expect(fromOps).toEqual(fromAggregates);
        }
    });

    it('offers nothing for a kind with no operations yet', () => {
        expect(opsFor('window', 'INTEGER')).toEqual([]);
        expect(opsFor('regex', 'VARCHAR')).toEqual([]);
    });
});

describe('transformExpression', () => {
    it('wraps the column in the aggregate', () => {
        expect(transformExpression(t())).toBe('sum(Line.Quantity)');
    });

    it('spells count distinct out in full', () => {
        expect(transformExpression(t({ op: 'count distinct' }))).toBe(
            'count(DISTINCT Line.Quantity)',
        );
    });

    // A bare count is a ROW count, which is a different question from counting
    // a column's non-null values. The engine hit the other version of this and
    // emitted COUNT("") - a quoted empty identifier that fails the run.
    it('counts rows when no column is named', () => {
        expect(transformExpression(t({ op: 'count', table: undefined, column: undefined }))).toBe(
            'count(*)',
        );
    });

    it('quotes a name that needs it', () => {
        expect(transformExpression(t({ table: 'item_norm.parquet', column: 'Qty On Hand' }))).toBe(
            'sum("item_norm.parquet"."Qty On Hand")',
        );
    });

    // A query saved against an operation that was later renamed must not
    // silently emit something else.
    it('returns null for an unknown operation', () => {
        expect(transformExpression(t({ op: 'median' }))).toBeNull();
    });
});

describe('transformIsComplete', () => {
    it('accepts a filled-in transformation', () => {
        expect(transformIsComplete(t())).toBe(true);
    });

    it('rejects one with no alias', () => {
        expect(transformIsComplete(t({ alias: '   ' }))).toBe(false);
    });

    it('rejects one whose column has been dropped', () => {
        expect(transformIsComplete(t({ table: undefined, column: undefined }))).toBe(false);
    });

    it('accepts count with no column, because that is count(*)', () => {
        expect(
            transformIsComplete(t({ op: 'count', table: undefined, column: undefined })),
        ).toBe(true);
    });

    it('rejects an unknown operation', () => {
        expect(transformIsComplete(t({ op: 'median' }))).toBe(false);
    });
});

describe('resultType', () => {
    // The chart matcher reads this to decide whether a column is quantitative.
    it('calls a count a BIGINT whatever it counted', () => {
        expect(opById('count')?.resultType?.('VARCHAR')).toBe('BIGINT');
        expect(opById('count distinct')?.resultType?.('DATE')).toBe('BIGINT');
    });

    // min/max return the COLUMN's type - including a date. Claiming numeric
    // here would type `max(OrderDate)` as quantitative and offer it as a
    // measure, which is exactly the quietly-wrong chart the matcher prevents.
    it('keeps the column type for min and max, including dates', () => {
        expect(opById('max')?.resultType?.('DATE')).toBe('DATE');
        expect(opById('min')?.resultType?.('VARCHAR')).toBe('VARCHAR');
    });
});

describe('suggestedAlias', () => {
    it('names the operation and what it read', () => {
        expect(suggestedAlias(t())).toBe('sum Line.Quantity');
    });

    it('names a bare count without a trailing space', () => {
        expect(suggestedAlias(t({ op: 'count', table: undefined, column: undefined }))).toBe(
            'count',
        );
    });
});

describe('argText', () => {
    it('reads a scalar argument', () => {
        expect(argText({ unit: 'month' }, 'unit')).toBe('month');
    });

    // An array arg is not a scalar; reading it as one would stringify it into
    // the SQL as `a,b`.
    it('reads an absent or non-scalar argument as empty', () => {
        expect(argText({}, 'unit')).toBe('');
        expect(argText({ partitionBy: ['Vendor'] }, 'partitionBy')).toBe('');
    });
});

describe('the catalog itself', () => {
    it('has no duplicate operation ids', () => {
        const ids = TRANSFORM_OPS.map(o => o.id);
        expect(new Set(ids).size).toBe(ids.length);
    });
});
