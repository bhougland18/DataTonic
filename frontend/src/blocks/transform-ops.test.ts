import { describe, expect, it } from 'vitest';
import {
    argText,
    opById,
    opsFor,
    suggestedAlias,
    transformExpression,
    transformIsComplete,
    transformProblem,
    TRANSFORM_OPS,
} from './transform-ops';
import {
    aggregatesFor,
    newCaseBranch,
    newGroup,
    newTransform,
    type CaseBranch,
    type ColumnTransform,
} from './builder-types';
import { isGroupingTransform } from './builder-sql';

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

// ---------------------------------------------------------------------------
// Literal and Case (DAA.117)
// ---------------------------------------------------------------------------

const lit = (value: string, type: string, alias = 'Period'): ColumnTransform => ({
    ...newTransform('literal', 'literal'),
    args: { value, type },
    alias,
});

describe('literal', () => {
    it('quotes text', () => {
        expect(transformExpression(lit('Q1', 'text'))).toBe("'Q1'");
    });

    it('escapes a quote in the text', () => {
        expect(transformExpression(lit("O'Brien", 'text'))).toBe("'O''Brien'");
    });

    it('writes a number bare', () => {
        expect(transformExpression(lit('42', 'number'))).toBe('42');
    });

    it('spells a date out as DuckDB reads it', () => {
        expect(transformExpression(lit('2026-01-01', 'date'))).toBe("DATE '2026-01-01'");
    });

    // The only kind that reads nothing at all. Anything assuming a source
    // column breaks here.
    it('needs no column', () => {
        expect(transformIsComplete(lit('Q1', 'text'))).toBe(true);
    });

    // A syntax error in a query built entirely from controls is the thing the
    // builder exists to make impossible.
    it('refuses a number that is not one, and says why', () => {
        expect(transformProblem(lit('Q1', 'number'))).toBe('That is not a number.');
    });

    it('refuses a date DuckDB would not read', () => {
        expect(transformProblem(lit('01/01/2026', 'date'))).toBe('Dates are YYYY-MM-DD.');
    });

    it('still asks for a name', () => {
        expect(transformProblem(lit('Q1', 'text', '  '))).toBe('Give the column a name.');
    });

    it('is not a grouping key — DuckDB folds a constant', () => {
        expect(isGroupingTransform(lit('Q1', 'text'))).toBe(false);
    });
});

describe('case', () => {
    const branch = (
        col: string,
        value: string,
        then: string,
        thenIsColumn = false,
    ): CaseBranch => ({
        ...newCaseBranch(),
        when: newGroup('and', [
            {
                id: `r-${col}-${value}`,
                kind: 'rule' as const,
                table: 'Vendor',
                column: col,
                op: 'starts with' as const,
                values: [value],
            },
        ]),
        then,
        thenIsColumn,
    });

    const caseOf = (branches: CaseBranch[], otherwise?: string): ColumnTransform => ({
        ...newTransform('case', 'case'),
        args: otherwise === undefined ? { branches } : { branches, else: otherwise },
        alias: 'Band',
    });

    it('builds a WHEN / THEN / ELSE', () => {
        expect(transformExpression(caseOf([branch('VendorName', 'M', 'M vendors')], 'other'))).toBe(
            "CASE WHEN Vendor.VendorName LIKE 'M%' THEN 'M vendors' ELSE 'other' END",
        );
    });

    // Measured: `CASE WHEN 1=2 THEN 'x' END` returns NULL rather than failing,
    // so an empty box means "leave the rest alone".
    it('omits ELSE when it is empty', () => {
        const sql = transformExpression(caseOf([branch('VendorName', 'M', 'M vendors')]));
        expect(sql).toBe("CASE WHEN Vendor.VendorName LIKE 'M%' THEN 'M vendors' END");
    });

    it('keeps the branches in order, because CASE takes the first match', () => {
        const sql = transformExpression(
            caseOf([branch('VendorName', 'M', 'first'), branch('VendorName', 'Me', 'second')]),
        );
        expect(sql?.indexOf('first')).toBeLessThan(sql?.indexOf('second') ?? -1);
    });

    // Without `thenIsColumn` the generator cannot tell the word from the
    // column, and guessing wrong is silent.
    it('tells a column THEN from a text THEN', () => {
        expect(transformExpression(caseOf([branch('VendorName', 'M', 'Vendor.VendorName', true)])))
            .toContain('THEN Vendor.VendorName');
        expect(transformExpression(caseOf([branch('VendorName', 'M', 'Vendor.VendorName')])))
            .toContain("THEN 'Vendor.VendorName'");
    });

    it('asks for at least one condition', () => {
        expect(transformProblem(caseOf([]))).toBe('Add at least one condition.');
    });

    // A dropped branch gives wrong answers rather than failing, so an
    // unfinished one must stop the whole thing.
    it('refuses a branch whose condition is unfinished', () => {
        const empty = { ...newCaseBranch(), then: 'x' };
        expect(transformProblem(caseOf([empty]))).toBe('Every condition needs filling in.');
    });

    it('refuses a branch with no value', () => {
        expect(transformProblem(caseOf([branch('VendorName', 'M', '   ')]))).toBe(
            'Every condition needs a value.',
        );
    });

    it('IS a grouping key', () => {
        expect(isGroupingTransform(caseOf([branch('VendorName', 'M', 'x')]))).toBe(true);
    });
});
