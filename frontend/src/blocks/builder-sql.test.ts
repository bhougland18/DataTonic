import { describe, expect, it } from 'vitest';
import {
    collidingNames,
    columnExpression,
    isGroupingTransform,
    filterSql,
    generateSql,
    selectExpression,
    withCollisionAliases,
} from './builder-sql';
import {
    ALL_OPERATORS,
    activeTransforms,
    aggregatesFor,
    arity,
    bucketsFor,
    clauseFor,
    emptyBuilder,
    filterIsComplete,
    filterTables,
    newCaseBranch,
    newGroup,
    newRule,
    newTransform,
    operatorsFor,
    sameSortKey,
    type BuilderState,
    type ColumnTransform,
    type FilterRule,
} from './builder-types';
import type { SqlStudioTable } from '../sqleditor/types';
import type { ErdRelationship } from '../erd/model';
import {
    normalizeBuilder,
    removeTransform,
    requiredTables,
    setTransformEnabled,
    upsertTransform,
} from './builder-ops';
import { vlTypeOf } from './chart-shapes';

const t = (name: string, cols: string[], from: string): SqlStudioTable => ({
    name,
    kind: 'upstream',
    columns: cols.map(n => ({ name: n })),
    from,
});

const TABLES = [
    t('Item', ['Item', 'ItemGroup', 'Description'], 'duckle_src."Item"'),
    t('ItemLocation', ['Item', 'Location'], 'duckle_src."ItemLocation"'),
    t('Vendor', ['Vendor', 'VendorName'], 'duckle_src."Vendor"'),
    t('VendorItem', ['Item', 'Vendor', 'VendorItem'], 'duckle_src."VendorItem"'),
    t('item_norm.parquet', ['Item'], "read_parquet('/w/item_norm.parquet')"),
];

const REL = {
    itemLoc: {
        id: 'a',
        fromTable: 'Item',
        fromColumn: 'Item',
        toTable: 'ItemLocation',
        toColumn: 'Item',
    },
    itemVi: {
        id: 'b',
        fromTable: 'Item',
        fromColumn: 'Item',
        toTable: 'VendorItem',
        toColumn: 'Item',
    },
    viVendor: {
        id: 'c',
        fromTable: 'Vendor',
        fromColumn: 'Vendor',
        toTable: 'VendorItem',
        toColumn: 'Vendor',
    },
} satisfies Record<string, ErdRelationship>;

const RELS = Object.values(REL);
const opts = { tables: TABLES, relationships: RELS };

const build = (over: Partial<BuilderState>): BuilderState => ({ ...emptyBuilder(), ...over });

const col = (table: string, column: string, rest: Record<string, unknown> = {}) => ({
    table,
    column,
    ...rest,
});

/** A grouping-filter rule on `Item.Item`, which is what the fixtures aggregate. */
const havingRule = (over: Partial<FilterRule> = {}): FilterRule => ({
    id: 'h',
    kind: 'rule',
    table: 'Item',
    column: 'Item',
    op: '=',
    values: ['5'],
    ...over,
});

describe('selectExpression', () => {
    it('qualifies a plain column with its table', () => {
        expect(selectExpression(col('Item', 'Item'))).toBe('Item.Item');
    });

    it('wraps an aggregate', () => {
        expect(selectExpression(col('Item', 'Item', { aggregate: 'count' }))).toBe(
            'count(Item.Item)',
        );
    });

    it('spells count distinct out in full', () => {
        expect(selectExpression(col('Item', 'Item', { aggregate: 'count distinct' }))).toBe(
            'count(DISTINCT Item.Item)',
        );
    });

    it('quotes a table name that is not a plain identifier', () => {
        expect(selectExpression(col('item_norm.parquet', 'Item'))).toBe(
            '"item_norm.parquet".Item',
        );
    });
});

describe('collision aliasing', () => {
    // Item.Item and VendorItem.Item both come out headed `Item`.
    it('finds a name two tables both contribute', () => {
        const columns = [col('Item', 'Item'), col('VendorItem', 'Item')];
        expect(collidingNames(columns).has('item')).toBe(true);
    });

    it('aliases colliding plain columns to Table.Column', () => {
        const out = withCollisionAliases([col('Item', 'Item'), col('VendorItem', 'Item')]);
        expect(out.map(c => c.alias)).toEqual(['Item.Item', 'VendorItem.Item']);
    });

    it('leaves a name only one table contributes alone', () => {
        const out = withCollisionAliases([col('Item', 'Description')]);
        expect(out[0].alias).toBeUndefined();
    });

    it('never overrides an alias the author set', () => {
        const out = withCollisionAliases([
            col('Item', 'Item', { alias: 'Mine' }),
            col('VendorItem', 'Item'),
        ]);
        expect(out[0].alias).toBe('Mine');
    });
});

describe('filterSql', () => {
    const f = (over: Partial<FilterRule>): FilterRule => ({
        id: 'f',
        kind: 'rule' as const,
        table: 'Vendor',
        column: 'VendorName',
        op: '=',
        values: ['Medline'],
        ...over,
    });

    it('writes equality', () => {
        expect(filterSql(f({}))).toBe("Vendor.VendorName = 'Medline'");
    });

    it('escapes a quote in the value', () => {
        expect(filterSql(f({ values: ["O'Brien"] }))).toBe("Vendor.VendorName = 'O''Brien'");
    });

    it('turns contains into a wrapped LIKE', () => {
        expect(filterSql(f({ op: 'contains', values: ['med'] }))).toBe(
            "Vendor.VendorName LIKE '%med%'",
        );
    });

    it('writes an IN list', () => {
        expect(filterSql(f({ op: 'in', values: ['A', 'B'] }))).toBe(
            "Vendor.VendorName IN ('A', 'B')",
        );
    });

    it('needs no value for IS NULL', () => {
        expect(filterSql(f({ op: 'is null', values: [] }))).toBe('Vendor.VendorName IS NULL');
    });

    // An incomplete row is a row being typed, not an error to shout about.
    it('emits nothing while a value is still missing', () => {
        expect(filterSql(f({ values: [''] }))).toBeNull();
        expect(filterSql(f({ op: 'between', values: ['1'] }))).toBeNull();
    });

    it('emits nothing for a disabled row, without deleting it', () => {
        expect(filterSql(f({ enabled: false }))).toBeNull();
    });
});

describe('filterIsComplete', () => {
    it('counts the values each operator needs', () => {
        const base = { id: 'f', kind: 'rule', table: 'T', column: 'c' } as const;
        expect(filterIsComplete({ ...base, op: 'is null', values: [] })).toBe(true);
        expect(filterIsComplete({ ...base, op: '=', values: [] })).toBe(false);
        expect(filterIsComplete({ ...base, op: 'between', values: ['1', '2'] })).toBe(true);
        expect(filterIsComplete({ ...base, op: 'in', values: ['x'] })).toBe(true);
    });
});

describe('generateSql', () => {
    it('says nothing until something is selected', () => {
        expect(generateSql(emptyBuilder(), opts)).toBe('');
        expect(generateSql(build({ anchor: 'Item' }), opts)).toBe('');
    });

    it('writes a one-table query with leading commas', () => {
        const sql = generateSql(
            build({ anchor: 'Item', columns: [col('Item', 'ItemGroup'), col('Item', 'Item')] }),
            opts,
        );
        expect(sql).toBe(
            ['SELECT Item.ItemGroup', '     , Item.Item', 'FROM duckle_src."Item" AS Item'].join(
                '\n',
            ),
        );
    });

    // The worked example from plan Â§3, end to end.
    it('writes the whole shape: joins, filters, order, limit', () => {
        const state = build({
            anchor: 'Item',
            columns: [
                col('Item', 'ItemGroup'),
                col('Item', 'Item'),
                col('Item', 'Description'),
                col('Vendor', 'VendorName'),
            ],
            joins: [
                { relationshipId: 'a', mode: 'inner' },
                { relationshipId: 'b', mode: 'inner' },
                { relationshipId: 'c', mode: 'inner' },
            ],
            filters: newGroup('and', [
                {
                    id: '1',
                    kind: 'rule',
                    table: 'Vendor',
                    column: 'VendorName',
                    op: '=',
                    values: ['Medline'],
                },
                {
                    id: '2',
                    kind: 'rule',
                    table: 'Item',
                    column: 'ItemGroup',
                    op: '=',
                    values: ['ROI'],
                },
            ]),
            sort: [{ table: 'Item', column: 'Item', dir: 'asc' }],
            limit: 100,
        });
        expect(generateSql(state, { ...opts, title: 'Medline items by location' })).toBe(
            [
                '-- name: Medline items by location',
                '',
                'SELECT Item.ItemGroup',
                '     , Item.Item',
                '     , Item.Description',
                '     , Vendor.VendorName',
                'FROM duckle_src."Item" AS Item',
                'JOIN duckle_src."ItemLocation" AS ItemLocation',
                '  ON Item.Item = ItemLocation.Item',
                'JOIN duckle_src."VendorItem" AS VendorItem',
                '  ON Item.Item = VendorItem.Item',
                'JOIN duckle_src."Vendor" AS Vendor',
                '  ON Vendor.Vendor = VendorItem.Vendor',
                "WHERE Vendor.VendorName = 'Medline'",
                "  AND Item.ItemGroup = 'ROI'",
                'ORDER BY Item.Item',
                'LIMIT 100',
            ].join('\n'),
        );
    });

    // The failure `join-order.ts` repairs in AI drafts cannot arise here: a
    // join is only emitted onto a table already in scope.
    it('skips a join whose tables are not reachable yet, rather than emitting it early', () => {
        const state = build({
            anchor: 'Item',
            columns: [col('Item', 'Item')],
            // Vendor first, though it can only attach via VendorItem.
            joins: [
                { relationshipId: 'c', mode: 'inner' },
                { relationshipId: 'b', mode: 'inner' },
            ],
        });
        const sql = generateSql(state, opts);
        expect(sql).toContain('AS VendorItem');
        expect(sql).not.toContain('AS Vendor\n');
        // And nothing references a table before it exists.
        expect(sql.indexOf('VendorItem.Vendor')).toBe(-1);
    });

    it('drops a join whose relationship was deleted on the Schema step', () => {
        const state = build({
            anchor: 'Item',
            columns: [col('Item', 'Item')],
            joins: [{ relationshipId: 'gone', mode: 'inner' }],
        });
        expect(generateSql(state, opts)).not.toContain('JOIN');
    });

    it('writes LEFT JOIN when the kept side is the one already in FROM', () => {
        const state = build({
            anchor: 'Item',
            columns: [col('Item', 'Item')],
            joins: [{ relationshipId: 'a', mode: 'keep-from' }],
        });
        expect(generateSql(state, opts)).toContain('LEFT JOIN duckle_src."ItemLocation"');
    });

    describe('grouping', () => {
        const state = build({
            anchor: 'Item',
            columns: [col('Item', 'ItemGroup'), col('Item', 'Item', { aggregate: 'count' })],
        });

        // Grouping is a consequence of aggregating, never a separate choice â€”
        // so "column must appear in GROUP BY" cannot be produced.
        it('groups every non-aggregated column automatically', () => {
            expect(generateSql(state, opts)).toContain('GROUP BY Item.ItemGroup');
        });

        it('writes no GROUP BY when nothing is aggregated', () => {
            const plain = build({ anchor: 'Item', columns: [col('Item', 'ItemGroup')] });
            expect(generateSql(plain, opts)).not.toContain('GROUP BY');
        });

        it('uses leading commas in GROUP BY too', () => {
            const two = build({
                anchor: 'Item',
                columns: [
                    col('Item', 'ItemGroup'),
                    col('Item', 'Description'),
                    col('Item', 'Item', { aggregate: 'count' }),
                ],
            });
            expect(generateSql(two, opts)).toContain(
                'GROUP BY Item.ItemGroup\n       , Item.Description',
            );
        });
    });

    // The engine wraps a custom body in `({sql})`, where a terminator is a
    // syntax error â€” the trap that broke every query earlier.
    it('never ends with a semicolon', () => {
        const state = build({ anchor: 'Item', columns: [col('Item', 'Item')], limit: 10 });
        expect(generateSql(state, opts).endsWith(';')).toBe(false);
    });

    it('writes the description line only when there is a title', () => {
        const state = build({ anchor: 'Item', columns: [col('Item', 'Item')] });
        expect(generateSql(state, { ...opts, description: 'orphan' })).not.toContain(
            '-- description',
        );
        expect(generateSql(state, { ...opts, title: 'T', description: 'why' })).toContain(
            '-- description: why',
        );
    });

    it('reads a file-backed table through its own expression', () => {
        const state = build({
            anchor: 'item_norm.parquet',
            columns: [col('item_norm.parquet', 'Item')],
        });
        expect(generateSql(state, opts)).toContain(
            `FROM read_parquet('/w/item_norm.parquet') AS "item_norm.parquet"`,
        );
    });
});



describe('AND / OR and nested groups', () => {
    const rule = (id: string, column: string, value: string): FilterRule => ({
        id,
        kind: 'rule',
        table: 'Item',
        column,
        op: '=',
        values: [value],
    });

    const withFilters = (root: ReturnType<typeof newGroup>) =>
        generateSql(
            build({
                anchor: 'Item',
                columns: [col('Item', 'Item')],
                filters: root,
            }),
            opts,
        );

    it('joins the root group with its conjunction, one per line', () => {
        const sql = withFilters(
            newGroup('and', [rule('1', 'ItemGroup', 'ROI'), rule('2', 'Description', 'x')]),
        );
        expect(sql).toContain("WHERE Item.ItemGroup = 'ROI'\n  AND Item.Description = 'x'");
    });

    it('uses OR when the root says so', () => {
        const sql = withFilters(
            newGroup('or', [rule('1', 'ItemGroup', 'ROI'), rule('2', 'ItemGroup', 'XYZ')]),
        );
        expect(sql).toContain("WHERE Item.ItemGroup = 'ROI'\n  OR Item.ItemGroup = 'XYZ'");
    });

    // The shape a flat list cannot express: one AND and one OR.
    it('parenthesises a nested group', () => {
        const sql = withFilters(
            newGroup('and', [
                rule('1', 'Description', 'medline'),
                newGroup('or', [rule('2', 'ItemGroup', 'ROI'), rule('3', 'ItemGroup', 'XYZ')]),
            ]),
        );
        expect(sql).toContain(
            "WHERE Item.Description = 'medline'\n  AND (Item.ItemGroup = 'ROI' OR Item.ItemGroup = 'XYZ')",
        );
    });

    // Wrapping every group would litter the SQL with `((x))` for conditions
    // nobody grouped.
    it('does not parenthesise a group with one surviving rule', () => {
        const sql = withFilters(newGroup('and', [newGroup('or', [rule('1', 'ItemGroup', 'ROI')])]));
        expect(sql).toContain("WHERE Item.ItemGroup = 'ROI'");
        expect(sql).not.toContain('((');
    });

    it('drops an empty group entirely', () => {
        const sql = withFilters(newGroup('and', [rule('1', 'ItemGroup', 'ROI'), newGroup('or', [])]));
        expect(sql).toContain("WHERE Item.ItemGroup = 'ROI'");
        expect(sql).not.toContain('AND (');
    });

    it('writes no WHERE when every rule is incomplete', () => {
        const sql = withFilters(newGroup('and', [rule('1', 'ItemGroup', '')]));
        expect(sql).not.toContain('WHERE');
    });
});

describe('aggregate naming and HAVING', () => {
    const grouped = (over: Partial<BuilderState> = {}) =>
        build({
            anchor: 'Item',
            columns: [
                col('Item', 'ItemGroup'),
                col('Item', 'Item', { aggregate: 'count' }),
            ],
            ...over,
        });

    it('names an aggregate after its calculation', () => {
        expect(generateSql(grouped(), opts)).toContain(
            'count(Item.Item) AS "count Item.Item"',
        );
    });

    it('leaves a plain column unnamed when nothing collides', () => {
        expect(generateSql(grouped(), opts)).toContain('SELECT Item.ItemGroup\n');
    });

    // Naming the aggregate also settles the collision it would otherwise have
    // with its own raw column.
    it('lets a count and its own column coexist', () => {
        const sql = generateSql(
            build({
                anchor: 'Item',
                columns: [col('Item', 'Item'), col('Item', 'Item', { aggregate: 'count' })],
            }),
            opts,
        );
        expect(sql).toContain('SELECT Item.Item\n');
        expect(sql).toContain('count(Item.Item) AS "count Item.Item"');
    });

    it('writes HAVING against the aggregate expression, not the bare column', () => {
        const sql = generateSql(
            grouped({ having: newGroup('and', [havingRule()]) }),
            opts,
        );
        expect(sql).toContain('HAVING count(Item.Item) = 5');
    });

    // HAVING without GROUP BY is rejected by DuckDB outright.
    it('writes no HAVING when nothing is aggregated', () => {
        const sql = generateSql(
            build({
                anchor: 'Item',
                columns: [col('Item', 'ItemGroup')],
                having: newGroup('and', [
                    {
                        id: 'h',
                        kind: 'rule',
                        table: 'Item',
                        column: 'Item',
                        op: '=',
                        values: ['5'],
                    },
                ]),
            }),
            opts,
        );
        expect(sql).not.toContain('HAVING');
    });

    it('puts HAVING after GROUP BY and before ORDER BY', () => {
        const sql = generateSql(
            grouped({
                having: newGroup('and', [
                    {
                        id: 'h',
                        kind: 'rule',
                        table: 'Item',
                        column: 'Item',
                        op: '=',
                        values: ['5'],
                    },
                ]),
                sort: [{ table: 'Item', column: 'ItemGroup', dir: 'asc' }],
            }),
            opts,
        );
        expect(sql.indexOf('GROUP BY')).toBeLessThan(sql.indexOf('HAVING'));
        expect(sql.indexOf('HAVING')).toBeLessThan(sql.indexOf('ORDER BY'));
    });

    // The whole point of the grouping filter: "vendors with more than five
    // items". A count compared to a quoted string reads as a text comparison.
    it('compares a count to a bare number', () => {
        const sql = generateSql(
            grouped({
                having: newGroup('and', [havingRule({ op: '>', values: ['5'] })]),
            }),
            opts,
        );
        expect(sql).toContain('HAVING count(Item.Item) > 5');
    });

    it.each(['>', '>=', '<', '<='] as const)('emits %s', op => {
        const sql = generateSql(
            grouped({ having: newGroup('and', [havingRule({ op, values: ['5'] })]) }),
            opts,
        );
        expect(sql).toContain(`HAVING count(Item.Item) ${op} 5`);
    });

    it('quotes a value that is not a number even against a count', () => {
        const sql = generateSql(
            grouped({ having: newGroup('and', [havingRule({ op: '=', values: ['n/a'] })]) }),
            opts,
        );
        expect(sql).toContain("HAVING count(Item.Item) = 'n/a'");
    });

    it('writes both ends of a numeric BETWEEN bare', () => {
        const sql = generateSql(
            grouped({
                having: newGroup('and', [havingRule({ op: 'between', values: ['5', '10'] })]),
            }),
            opts,
        );
        expect(sql).toContain('HAVING count(Item.Item) BETWEEN 5 AND 10');
    });

    // min/max return the column's own type, so the literal stays quoted —
    // everything in this workspace arrives from the API as text.
    it('keeps quotes around a min/max comparison', () => {
        const sql = generateSql(
            build({
                anchor: 'Item',
                columns: [col('Item', 'ItemGroup'), col('Item', 'Item', { aggregate: 'max' })],
                having: newGroup('and', [
                    havingRule({ aggregate: 'max', op: '>', values: ['5'] }),
                ]),
            }),
            opts,
        );
        expect(sql).toContain("HAVING max(Item.Item) > '5'");
    });

    // A WHERE rule has no aggregate, so nothing here changes row filtering:
    // `Item.Item = 1043` against a VARCHAR column would cast the column, not
    // the literal, and that is a different query.
    it('leaves WHERE values quoted even when they look numeric', () => {
        const sql = generateSql(
            build({
                anchor: 'Item',
                columns: [col('Item', 'Item')],
                filters: newGroup('and', [
                    { id: 'w', kind: 'rule', table: 'Item', column: 'Item', op: '>', values: ['5'] },
                ]),
            }),
            opts,
        );
        expect(sql).toContain("WHERE Item.Item > '5'");
    });

    // One column summarised twice is two different left-hand sides. Matching on
    // table+column alone resolved both rules to whichever was ticked first.
    it('resolves each rule to its own aggregate when a column is summarised twice', () => {
        const sql = generateSql(
            build({
                anchor: 'Item',
                columns: [
                    col('Item', 'ItemGroup'),
                    col('Item', 'Item', { aggregate: 'count' }),
                    col('Item', 'Item', { aggregate: 'max' }),
                ],
                having: newGroup('and', [
                    havingRule({ id: 'h1', aggregate: 'count', op: '>', values: ['5'] }),
                    havingRule({ id: 'h2', aggregate: 'max', op: '=', values: ['Z'] }),
                ]),
            }),
            opts,
        );
        expect(sql).toContain('HAVING count(Item.Item) > 5');
        expect(sql).toContain("AND max(Item.Item) = 'Z'");
    });

    // Saved before the aggregate was recorded on the rule, with the raw column
    // ALSO selected. HAVING is about groups, so the summarised entry wins — and
    // the value is written bare because the settled left-hand side is a count.
    it('resolves an aggregate-less rule to the summarised column', () => {
        const sql = generateSql(
            build({
                anchor: 'Item',
                columns: [col('Item', 'Item'), col('Item', 'Item', { aggregate: 'count' })],
                having: newGroup('and', [havingRule({ op: '=', values: ['5'] })]),
            }),
            opts,
        );
        expect(sql).toContain('HAVING count(Item.Item) = 5');
    });
});

describe('operatorsFor', () => {
    it('drops the text operators from a count', () => {
        const ops = operatorsFor('count');
        expect(ops).toContain('>');
        expect(ops).not.toContain('contains');
        expect(ops).not.toContain('starts with');
    });

    // min/max return the column's type, which may well be text.
    it('keeps everything for min and max', () => {
        expect(operatorsFor('max')).toContain('contains');
        expect(operatorsFor('min')).toEqual(ALL_OPERATORS);
    });

    it('keeps everything for a plain WHERE rule', () => {
        expect(operatorsFor(undefined)).toEqual(ALL_OPERATORS);
        expect(operatorsFor('none')).toEqual(ALL_OPERATORS);
    });

    it('offers the comparisons everywhere', () => {
        for (const op of ['>', '>=', '<', '<='] as const) {
            expect(ALL_OPERATORS).toContain(op);
            expect(arity(op)).toBe(1);
        }
    });
});

describe('aggregatesFor', () => {
    it('offers arithmetic only on a numeric column', () => {
        expect(aggregatesFor('INTEGER')).toContain('sum');
        expect(aggregatesFor('DECIMAL(18,2)')).toContain('avg');
    });

    // `sum(VARCHAR)` does not return something odd — it does not run.
    it('withholds sum and avg from text', () => {
        expect(aggregatesFor('VARCHAR')).not.toContain('sum');
        expect(aggregatesFor('VARCHAR')).not.toContain('avg');
    });

    it('still allows counting and extremes on text', () => {
        expect(aggregatesFor('VARCHAR')).toEqual(['none', 'count', 'count distinct', 'min', 'max']);
    });

    // Missing information is not the same as a text column.
    it('offers everything when the type is unknown', () => {
        expect(aggregatesFor(undefined)).toContain('sum');
    });

    // A run's preview reports Duckle's own type names, not SQL ones, and the
    // digits are part of the token. `float64` matched nothing, so every DOUBLE
    // column in a result was offered the text aggregates only.
    it.each(['int32', 'int64', 'float32', 'float64', 'decimal'])(
        'recognises %s, the name a run actually reports',
        type => {
            expect(aggregatesFor(type)).toContain('sum');
        },
    );

    it.each(['string', 'bool', 'json', 'binary'])('still withholds sum from %s', type => {
        expect(aggregatesFor(type)).not.toContain('sum');
    });
});


// Ben's real model, 2026-09-15. `PurchaseOrder` and `PurchaseOrderLine` are
// related on BOTH `PurchaseOrder` and `Company` — a composite key, entered as
// two relationships because that is how the ERD records them.
//
// Joining on only the first does not fail. It multiplies rows, and the symptom
// was two vendors numbered 2 with identical sums: a total quietly too large.
const COMPOSITE_TABLES = [
    t('Vendor', ['Company', 'Vendor', 'VendorName'], 'duckle_src."Vendor"'),
    t('PurchaseOrder', ['Company', 'PurchaseOrder', 'Vendor'], 'duckle_src."PurchaseOrder"'),
    t(
        'PurchaseOrderLine',
        ['Company', 'PurchaseOrder', 'Quantity'],
        'duckle_src."PurchaseOrderLine"',
    ),
];

const COMPOSITE_RELS: ErdRelationship[] = [
    {
        id: 'v-po',
        fromTable: 'Vendor',
        fromColumn: 'Vendor',
        toTable: 'PurchaseOrder',
        toColumn: 'Vendor',
    },
    {
        id: 'po-pol-key',
        fromTable: 'PurchaseOrder',
        fromColumn: 'PurchaseOrder',
        toTable: 'PurchaseOrderLine',
        toColumn: 'PurchaseOrder',
    },
    {
        id: 'po-pol-company',
        fromTable: 'PurchaseOrder',
        fromColumn: 'Company',
        toTable: 'PurchaseOrderLine',
        toColumn: 'Company',
    },
];

describe('composite keys join on every column', () => {
    const state = build({
        anchor: 'Vendor',
        columns: [col('Vendor', 'VendorName'), col('PurchaseOrderLine', 'Quantity')],
        joins: [
            { relationshipId: 'v-po', mode: 'inner' },
            { relationshipId: 'po-pol-key', mode: 'inner' },
        ],
    });
    const sql = generateSql(state, {
        tables: COMPOSITE_TABLES,
        relationships: COMPOSITE_RELS,
    });

    it('ANDs the second arm into the same ON clause', () => {
        expect(sql).toContain('PurchaseOrder.PurchaseOrder = PurchaseOrderLine.PurchaseOrder');
        expect(sql).toContain('PurchaseOrder.Company = PurchaseOrderLine.Company');
    });

    // The arm nothing selected still has to come along: a composite key is a
    // fact about the schema, not something anybody ticked.
    it('emits ONE join, not two', () => {
        expect(sql.match(/JOIN duckle_src\."PurchaseOrderLine"/g)?.length).toBe(1);
    });

    it('leaves a single-column join alone', () => {
        expect(sql).toContain('ON Vendor.Vendor = PurchaseOrder.Vendor');
        expect(sql).not.toMatch(/ON Vendor\.Vendor[^\n]*\n AND/);
    });

    // Ruling out a route can mean ruling out one arm of a key.
    it('honours an exclusion on the extra arm', () => {
        const without = generateSql(
            { ...state, excludedJoins: ['po-pol-company'] },
            { tables: COMPOSITE_TABLES, relationships: COMPOSITE_RELS },
        );
        expect(without).not.toContain('PurchaseOrderLine.Company');
    });
});

// Sorting by a column that is SUMMARISED. The raw column is gone once anything
// is grouped, and DuckDB says so: `column "Quantity" must appear in the GROUP BY
// clause or be part of an aggregate`. Hit live on 2026-09-15.
describe('ORDER BY in an aggregated query', () => {
    const grouped = (sort: BuilderState['sort']) =>
        generateSql(
            build({
                anchor: 'Item',
                columns: [
                    col('Item', 'ItemGroup'),
                    col('Item', 'Item', { aggregate: 'count' }),
                ],
                sort,
            }),
            opts,
        );

    it('orders by the aggregate alias, not the raw column', () => {
        const sql = grouped([{ table: 'Item', column: 'Item', dir: 'desc' }]);
        expect(sql).toContain('ORDER BY "count Item.Item" DESC');
        expect(sql).not.toMatch(/ORDER BY Item\.Item/);
    });

    // A grouping key survives under its own name, so it sorts as itself.
    it('orders by a GROUP BY key directly', () => {
        expect(grouped([{ table: 'Item', column: 'ItemGroup', dir: 'asc' }])).toContain(
            'ORDER BY Item.ItemGroup',
        );
    });

    it('leaves an unaggregated query alone', () => {
        const sql = generateSql(
            build({
                anchor: 'Item',
                columns: [col('Item', 'Item')],
                sort: [{ table: 'Item', column: 'Item', dir: 'asc' }],
            }),
            opts,
        );
        expect(sql).toContain('ORDER BY Item.Item');
    });

    // One column both grouped and summarised: the grouping key is the one that
    // still exists under its own name.
    it('prefers the grouping key when a column is both', () => {
        const sql = generateSql(
            build({
                anchor: 'Item',
                columns: [col('Item', 'Item'), col('Item', 'Item', { aggregate: 'count' })],
                sort: [{ table: 'Item', column: 'Item', dir: 'asc' }],
            }),
            opts,
        );
        expect(sql).toContain('ORDER BY Item.Item');
    });
});

// ---------------------------------------------------------------------------
// Date bucketing (DAA.105)
// ---------------------------------------------------------------------------
//
// Every SQL assertion here was first run against the real workspace database
// (`Duckle_new_workspace/data/infor.duckdb`) rather than reasoned about — the
// handoff's standing instruction, and the reason the `date_trunc` over VARCHAR
// case below is stated as a fact rather than a guess.

const DATED_TABLES: SqlStudioTable[] = [
    {
        name: 'PurchaseOrder',
        kind: 'upstream',
        columns: [
            { name: 'PurchaseOrder', type: 'VARCHAR' },
            { name: 'PurchaseOrderDate', type: 'DATE' },
            { name: 'Vendor', type: 'VARCHAR' },
        ],
        from: 'duckle_src."PurchaseOrder"',
    },
];
const datedOpts = { tables: DATED_TABLES, relationships: [] as ErdRelationship[] };

describe('bucketsFor', () => {
    it.each(['DATE', 'TIMESTAMP', 'TIMESTAMP WITH TIME ZONE', 'datetime', 'TIME'])(
        'offers buckets on %s',
        type => {
            expect(bucketsFor(type)).toContain('month');
        },
    );

    // Measured, not assumed: DuckDB answers `No function matches the given name
    // and argument types 'date_trunc(STRING_LITERAL, VARCHAR)'` — the same dead
    // end `sum` over a VARCHAR is, so the control is absent rather than broken.
    it.each(['VARCHAR', 'INTEGER', 'BOOLEAN', 'DOUBLE'])('offers none on %s', type => {
        expect(bucketsFor(type)).toEqual([]);
    });

    // Both type vocabularies, as `aggregatesFor` learned to do the hard way.
    // A DESCRIBE gives SQL spellings; a run preview gives Duckle's own names,
    // which `crates/metadata` serializes as plain `date` / `timestamp` — no
    // `date32`-style suffix, so the trap that cost `float64` its aggregates
    // does not recur here. Pinned rather than assumed.
    it.each(["date", "timestamp"])("recognises %s, the name a run actually reports", type => {
        expect(bucketsFor(type)).toContain("month");
    });

    // The deliberate asymmetry with `aggregatesFor`, which is permissive here.
    // Being permissive would put a date dropdown on every column of a workspace
    // whose columns were all text until they were typed.
    it('offers NOTHING when the type is unknown, unlike aggregatesFor', () => {
        expect(bucketsFor(undefined)).toEqual([]);
        expect(aggregatesFor(undefined)).toContain('sum');
    });

    // One date test, shared. Two would drift into a column that can be bucketed
    // but plots as a category.
    it('agrees with the chart matcher about what a date is', () => {
        for (const type of ['DATE', 'TIMESTAMP', 'VARCHAR', 'INTEGER']) {
            expect(bucketsFor(type).length > 0).toBe(vlTypeOf(type) === 'temporal');
        }
    });
});

describe('columnExpression with a bucket', () => {
    it('truncates the column', () => {
        expect(
            columnExpression(col('PurchaseOrder', 'PurchaseOrderDate', { bucket: 'month' })),
        ).toBe("date_trunc('month', PurchaseOrder.PurchaseOrderDate)");
    });

    it('leaves the column alone at none', () => {
        expect(
            columnExpression(col('PurchaseOrder', 'PurchaseOrderDate', { bucket: 'none' })),
        ).toBe('PurchaseOrder.PurchaseOrderDate');
    });

    // Aggregate OUTSIDE the bucket: `date_trunc('month', count(x))` is not a
    // thing, and this is the only order that composes.
    it('nests the aggregate outside the bucket', () => {
        expect(
            columnExpression(
                col('PurchaseOrder', 'PurchaseOrderDate', { bucket: 'month', aggregate: 'count' }),
            ),
        ).toBe("count(date_trunc('month', PurchaseOrder.PurchaseOrderDate))");
    });
});

describe('a bucketed column is named', () => {
    // Left alone DuckDB heads the column `date_trunc('month', …)`, which is the
    // expression rather than a heading.
    it('gets the bucket as its alias', () => {
        const [c] = withCollisionAliases([
            col('PurchaseOrder', 'PurchaseOrderDate', { bucket: 'month' }),
        ]);
        expect(c.alias).toBe('month PurchaseOrder.PurchaseOrderDate');
    });

    it('names both parts when both apply, outside-in', () => {
        const [c] = withCollisionAliases([
            col('PurchaseOrder', 'PurchaseOrderDate', { bucket: 'month', aggregate: 'count' }),
        ]);
        expect(c.alias).toBe('count month PurchaseOrder.PurchaseOrderDate');
    });

    it('leaves a hand-written name alone', () => {
        const [c] = withCollisionAliases([
            col('PurchaseOrder', 'PurchaseOrderDate', { bucket: 'month', alias: 'Month' }),
        ]);
        expect(c.alias).toBe('Month');
    });
});

describe('generateSql buckets dates', () => {
    const trend = build({
        anchor: 'PurchaseOrder',
        columns: [
            col('PurchaseOrder', 'PurchaseOrderDate', { bucket: 'month' }),
            col('PurchaseOrder', 'PurchaseOrder', { aggregate: 'count' }),
        ],
    });

    // THE mistake this control exists to stop: writing the bucket in SELECT and
    // the raw column in GROUP BY does not error — it groups by the day and
    // labels the result a month.
    it('groups by the same expression it selects', () => {
        const sql = generateSql(trend, datedOpts);
        expect(sql).toContain(
            'SELECT date_trunc(\'month\', PurchaseOrder.PurchaseOrderDate) AS "month PurchaseOrder.PurchaseOrderDate"',
        );
        expect(sql).toContain("GROUP BY date_trunc('month', PurchaseOrder.PurchaseOrderDate)");
        expect(sql).not.toContain('GROUP BY PurchaseOrder.PurchaseOrderDate');
    });

    // The raw column is in neither SELECT nor GROUP BY, so DuckDB rejects it
    // with `must appear in the GROUP BY clause` — the same failure a summarised
    // column has, and the alias is the same answer.
    it('sorts a bucketed grouping key by its alias, not the raw column', () => {
        const sql = generateSql(
            {
                ...trend,
                sort: [{ table: 'PurchaseOrder', column: 'PurchaseOrderDate', dir: 'asc' }],
            },
            datedOpts,
        );
        expect(sql).toContain('ORDER BY "month PurchaseOrder.PurchaseOrderDate"');
    });

    it('still sorts an UNBUCKETED grouping key by the column itself', () => {
        const sql = generateSql(
            build({
                anchor: 'PurchaseOrder',
                columns: [
                    col('PurchaseOrder', 'Vendor'),
                    col('PurchaseOrder', 'PurchaseOrder', { aggregate: 'count' }),
                ],
                sort: [{ table: 'PurchaseOrder', column: 'Vendor', dir: 'asc' }],
            }),
            datedOpts,
        );
        expect(sql).toContain('ORDER BY PurchaseOrder.Vendor');
    });

    // A bucket on its own creates no GROUP BY: grouping is a consequence of
    // aggregating (plan §6), and that rule does not change here.
    it('does not group when nothing is aggregated', () => {
        const sql = generateSql(
            build({
                anchor: 'PurchaseOrder',
                columns: [col('PurchaseOrder', 'PurchaseOrderDate', { bucket: 'month' })],
            }),
            datedOpts,
        );
        expect(sql).not.toContain('GROUP BY');
    });
});

// ---------------------------------------------------------------------------
// Column transformations — the state shape (DAA.109)
// ---------------------------------------------------------------------------

describe('transform state shape', () => {
    it('starts empty', () => {
        expect(emptyBuilder().transforms).toEqual([]);
    });

    // `query-io` casts stored JSON straight back to BuilderState with no
    // normalising layer, so every query saved before today arrives without the
    // key. Anything reading it directly would throw on the first `.filter()`.
    it('survives a saved query that has no transforms at all', () => {
        const old = { ...emptyBuilder() } as BuilderState;
        delete (old as { transforms?: unknown }).transforms;
        expect(activeTransforms(old.transforms)).toEqual([]);
    });

    it('drops switched-off transformations, keeps the rest', () => {
        const on = newTransform('function', 'upper');
        const off = { ...newTransform('function', 'lower'), enabled: false };
        // `enabled` absent means ON — a transformation created and never
        // touched has to appear, same rule filter rules follow.
        expect(activeTransforms([on, off]).map(t => t.op)).toEqual(['upper']);
    });

    it('mints ids that do not collide with filter ids', () => {
        const ids = [
            newTransform('function').id,
            newTransform('function').id,
            newCaseBranch().id,
            newRule().id,
        ];
        expect(new Set(ids).size).toBe(4);
    });

    // A literal reads nothing; a case names its columns inside its branches.
    // Code that assumes a source column breaks on two of the six kinds.
    it('allows a transformation with no source column', () => {
        const lit = newTransform('literal');
        expect(lit.table).toBeUndefined();
        expect(lit.column).toBeUndefined();
    });
});

describe('clauseFor', () => {
    // All three enforced by DuckDB, and the two errors are real, measured
    // strings: `WHERE clause cannot contain aggregates` and `WHERE clause
    // cannot contain window functions`.
    it('sends aggregates to HAVING and windows to QUALIFY', () => {
        expect(clauseFor('aggregate')).toBe('having');
        expect(clauseFor('window')).toBe('qualify');
    });

    it.each(['function', 'regex', 'case', 'literal'] as const)(
        'sends %s to WHERE, because it is scalar',
        kind => {
            expect(clauseFor(kind)).toBe('where');
        },
    );
});

// ---------------------------------------------------------------------------
// Transformations in the generated SQL (DAA.111)
// ---------------------------------------------------------------------------

const PO_TABLES: SqlStudioTable[] = [
    {
        name: 'PurchaseOrder',
        kind: 'upstream',
        columns: [
            { name: 'PurchaseOrder', type: 'BIGINT' },
            { name: 'PurchaseOrderDate', type: 'DATE' },
            { name: 'Vendor', type: 'BIGINT' },
            { name: 'POCode', type: 'VARCHAR' },
        ],
        from: 'duckle_src."PurchaseOrder"',
    },
];
const poOpts = { tables: PO_TABLES, relationships: [] as ErdRelationship[] };

const xf = (over: Partial<ColumnTransform>): ColumnTransform => ({
    ...newTransform('aggregate', 'count'),
    alias: 'Orders',
    ...over,
});

describe('generateSql with transformations', () => {
    it('emits a transformation with its alias quoted', () => {
        const sql = generateSql(
            build({
                anchor: 'PurchaseOrder',
                columns: [col('PurchaseOrder', 'Vendor')],
                transforms: [xf({ alias: 'Total Orders' })],
            }),
            poOpts,
        );
        expect(sql).toContain('count(*) AS "Total Orders"');
    });

    // "How many purchase orders are there" ticks no column at all.
    it('builds a query that is nothing but a transformation', () => {
        const sql = generateSql(
            build({
                anchor: 'PurchaseOrder',
                columns: [],
                transforms: [xf({ table: 'PurchaseOrder', column: 'PurchaseOrder' })],
            }),
            poOpts,
        );
        expect(sql).toContain('SELECT count(PurchaseOrder.PurchaseOrder) AS Orders');
        expect(sql).toContain('FROM duckle_src."PurchaseOrder" AS PurchaseOrder');
        expect(sql).not.toContain('GROUP BY');
    });

    it('still returns nothing when there is neither a column nor a transformation', () => {
        expect(generateSql(build({ anchor: 'PurchaseOrder' }), poOpts)).toBe('');
    });

    // An aggregate transformation is what MAKES the query grouped; every ticked
    // column that is not summarised becomes a key. Grouping stays a
    // consequence, never a separate choice.
    it('groups the ticked columns once a transformation aggregates', () => {
        const sql = generateSql(
            build({
                anchor: 'PurchaseOrder',
                columns: [col('PurchaseOrder', 'Vendor')],
                transforms: [xf({})],
            }),
            poOpts,
        );
        expect(sql).toContain('GROUP BY PurchaseOrder.Vendor');
    });

    it('drops an incomplete transformation rather than emitting half of it', () => {
        const sql = generateSql(
            build({
                anchor: 'PurchaseOrder',
                columns: [col('PurchaseOrder', 'Vendor')],
                // `sum` with no column, and an unknown operation.
                transforms: [
                    xf({ op: 'sum', table: undefined, column: undefined }),
                    xf({ op: 'median', table: 'PurchaseOrder', column: 'Vendor' }),
                ],
            }),
            poOpts,
        );
        expect(sql).not.toContain('sum(');
        expect(sql).not.toContain('median');
        expect(sql).not.toContain('GROUP BY');
    });

    it('leaves a switched-off transformation out', () => {
        const sql = generateSql(
            build({
                anchor: 'PurchaseOrder',
                columns: [col('PurchaseOrder', 'Vendor')],
                transforms: [xf({ enabled: false })],
            }),
            poOpts,
        );
        expect(sql).not.toContain('count(*)');
    });
});

describe('a transformation name owns its heading', () => {
    // Two columns under one heading is the failure `collidingNames` exists to
    // stop; a transformation occupies the same heading space. The person NAMED
    // the transformation, so the plain column is the one that gets qualified.
    it('qualifies a plain column that clashes with a transformation alias', () => {
        const [c] = withCollisionAliases(
            [col('PurchaseOrder', 'Vendor')],
            [xf({ alias: 'Vendor' })],
        );
        expect(c.alias).toBe('PurchaseOrder.Vendor');
    });

    it('leaves a column alone when nothing clashes', () => {
        const [c] = withCollisionAliases(
            [col('PurchaseOrder', 'Vendor')],
            [xf({ alias: 'Orders' })],
        );
        expect(c.alias).toBeUndefined();
    });
});

describe('isGroupingTransform', () => {
    // An aggregate CAUSES the grouping; a window is computed after it and
    // DuckDB rejects it in GROUP BY; a literal is constant-folded - measured,
    // `SELECT 'Q1' AS p, Vendor, count(*) ... GROUP BY Vendor` runs.
    it.each(['aggregate', 'window', 'literal'] as const)('keeps %s out of GROUP BY', kind => {
        expect(isGroupingTransform(xf({ kind }))).toBe(false);
    });

    it.each(['function', 'regex', 'case'] as const)('makes %s a grouping key', kind => {
        expect(isGroupingTransform(xf({ kind }))).toBe(true);
    });
});

describe('requiredTables counts transformations', () => {
    // "Count the order lines" needs the table joined without a single column of
    // it being ticked. Left out, the generator names a table absent from FROM.
    it('brings in a table only a transformation reaches', () => {
        const state = build({
            columns: [col('PurchaseOrder', 'Vendor')],
            transforms: [xf({ table: 'PurchaseOrderLine', column: 'Quantity', op: 'sum' })],
        });
        expect(requiredTables(state)).toEqual(['PurchaseOrder', 'PurchaseOrderLine']);
    });

    // Toggling one back on must not silently restructure the FROM chain.
    it('keeps the table of a switched-off transformation', () => {
        const state = build({
            columns: [col('PurchaseOrder', 'Vendor')],
            transforms: [
                xf({ table: 'PurchaseOrderLine', column: 'Quantity', enabled: false }),
            ],
        });
        expect(requiredTables(state)).toContain('PurchaseOrderLine');
    });
});

// ---------------------------------------------------------------------------
// Transform state operations (DAA.112)
// ---------------------------------------------------------------------------

describe('transform state operations', () => {
    const rels = RELS;

    const sumOf = (table: string, column: string): ColumnTransform => ({
        ...newTransform('aggregate', 'sum'),
        table,
        column,
        alias: `sum ${table}.${column}`,
    });

    it('adds a transformation', () => {
        const next = upsertTransform(
            build({ anchor: 'Item', columns: [col('Item', 'Item')] }),
            sumOf('Item', 'ItemGroup'),
            rels,
        );
        expect(next.transforms).toHaveLength(1);
    });

    it('replaces one with the same id rather than adding a second', () => {
        const first = sumOf('Item', 'ItemGroup');
        const state = upsertTransform(
            build({ anchor: 'Item', columns: [col('Item', 'Item')] }),
            first,
            rels,
        );
        const next = upsertTransform(state, { ...first, alias: 'Renamed' }, rels);
        expect(next.transforms).toHaveLength(1);
        expect(next.transforms?.[0].alias).toBe('Renamed');
    });

    // A transformation can be the ONLY reason a table is in the query, so
    // adding one has to pull it in through the ER model exactly as ticking a
    // column does — and removing it has to let it go again.
    it('brings a table in, and lets it go again', () => {
        const start = build({ anchor: 'Item', columns: [col('Item', 'Item')] });
        const t = sumOf('Vendor', 'VendorName');
        const added = upsertTransform(start, t, rels);
        expect(added.joins.length).toBeGreaterThan(0);

        const removed = removeTransform(added, t.id, rels);
        expect(removed.transforms).toEqual([]);
        expect(removed.joins).toEqual([]);
    });

    // Deliberate: `requiredTables` counts switched-off transformations, so
    // toggling one back on cannot silently restructure the FROM chain.
    it('keeps the joins when one is switched off', () => {
        const t = sumOf('Vendor', 'VendorName');
        const added = upsertTransform(
            build({ anchor: 'Item', columns: [col('Item', 'Item')] }),
            t,
            rels,
        );
        const off = setTransformEnabled(added, t.id, false);
        expect(off.transforms?.[0].enabled).toBe(false);
        expect(off.joins).toEqual(added.joins);
    });

    it('leaves the other transformations alone when one is toggled', () => {
        const a = sumOf('Item', 'ItemGroup');
        const b = { ...sumOf('Item', 'Description'), id: 'second' };
        let state = build({ anchor: 'Item', columns: [col('Item', 'Item')] });
        state = upsertTransform(state, a, rels);
        state = upsertTransform(state, b, rels);
        const next = setTransformEnabled(state, a.id, false);
        expect(next.transforms?.find(t => t.id === b.id)?.enabled).toBeUndefined();
    });

    // Every one of these must survive a state that predates the field.
    it('works on a saved query that has no transforms key', () => {
        const old = { ...build({ anchor: 'Item', columns: [col('Item', 'Item')] }) };
        delete (old as { transforms?: unknown }).transforms;
        expect(() => upsertTransform(old, sumOf('Item', 'ItemGroup'), rels)).not.toThrow();
        expect(() => removeTransform(old, 'nope', rels)).not.toThrow();
        expect(() => setTransformEnabled(old, 'nope', false)).not.toThrow();
    });
});

// ---------------------------------------------------------------------------
// Migration of saved queries (DAA.114)
// ---------------------------------------------------------------------------
//
// The catalog's aggregate and bucket dropdowns are gone, so a query saved under
// the old shape would otherwise open with an aggregation nobody can change or
// see a reason for. Worse, the generator reads both shapes: a column left
// summarised AND selected becomes `sum(x)` in SELECT and `x` in GROUP BY at the
// same time, which changes every number in the result.

describe('normalizeBuilder', () => {
    it('turns a summarised column into an aggregate transformation', () => {
        const next = normalizeBuilder(
            build({
                anchor: 'Item',
                columns: [
                    col('Item', 'ItemGroup'),
                    col('Item', 'Item', { aggregate: 'count' }),
                ],
            }),
        );
        expect(next.columns).toHaveLength(1);
        expect(next.columns[0].column).toBe('ItemGroup');
        expect(next.transforms).toHaveLength(1);
        expect(next.transforms?.[0]).toMatchObject({
            kind: 'aggregate',
            op: 'count',
            table: 'Item',
            column: 'Item',
        });
    });

    // The heading a saved query already produced must not change underneath
    // somebody - it may be referenced by a chart or pasted into a report.
    it('keeps the alias the query was already generating', () => {
        const next = normalizeBuilder(
            build({
                anchor: 'Item',
                columns: [col('Item', 'Item', { aggregate: 'count', alias: 'Items' })],
            }),
        );
        expect(next.transforms?.[0].alias).toBe('Items');
    });

    it('defaults the alias to what the generator used to emit', () => {
        const next = normalizeBuilder(
            build({ anchor: 'Item', columns: [col('Item', 'Item', { aggregate: 'count' })] }),
        );
        expect(next.transforms?.[0].alias).toBe('count Item.Item');
    });

    it('turns a bucketed column into a date_trunc transformation', () => {
        const next = normalizeBuilder(
            build({
                anchor: 'PurchaseOrder',
                columns: [col('PurchaseOrder', 'PurchaseOrderDate', { bucket: 'month' })],
            }),
        );
        expect(next.transforms?.[0]).toMatchObject({
            kind: 'function',
            op: 'date_trunc',
            args: { unit: 'month' },
        });
        expect(next.columns).toEqual([]);
    });

    // Chaining is out of scope, so `count(date_trunc(...))` cannot be expressed
    // as one row. Two rows keeps both halves rather than dropping either.
    it('splits a column that was both bucketed and summarised', () => {
        const next = normalizeBuilder(
            build({
                anchor: 'PurchaseOrder',
                columns: [
                    col('PurchaseOrder', 'PurchaseOrderDate', {
                        bucket: 'month',
                        aggregate: 'count',
                    }),
                ],
            }),
        );
        expect(next.transforms?.map(t => t.op)).toEqual(['date_trunc', 'count']);
    });

    it('leaves a query with nothing legacy in it completely alone', () => {
        const state = build({ anchor: 'Item', columns: [col('Item', 'Item')] });
        expect(normalizeBuilder(state)).toBe(state);
    });

    it('is idempotent', () => {
        const once = normalizeBuilder(
            build({ anchor: 'Item', columns: [col('Item', 'Item', { aggregate: 'count' })] }),
        );
        expect(normalizeBuilder(once)).toBe(once);
    });

    it('survives a saved query with no transforms key at all', () => {
        const old = build({
            anchor: 'Item',
            columns: [col('Item', 'Item', { aggregate: 'count' })],
        });
        delete (old as { transforms?: unknown }).transforms;
        expect(normalizeBuilder(old).transforms).toHaveLength(1);
    });

    // The whole point: the numbers must not move.
    it('generates the same SQL before and after migration', () => {
        const before = build({
            anchor: 'Item',
            columns: [col('Item', 'ItemGroup'), col('Item', 'Item', { aggregate: 'count' })],
        });
        const after = normalizeBuilder(before);
        expect(generateSql(after, opts)).toBe(generateSql(before, opts));
    });
});

// ---------------------------------------------------------------------------
// Filters and Sort naming a transformation (DAA.113)
// ---------------------------------------------------------------------------
//
// The left-hand side is the transformation's ALIAS. DuckDB supports lateral
// column aliases - a SELECT alias may be named in WHERE, GROUP BY, HAVING,
// QUALIFY and ORDER BY - which is exactly what lets this work without the
// subquery the builder has ruled out.

describe('filters on a transformation', () => {
    // A real catalog operation: a transformation whose op is unknown is
    // DROPPED as incomplete, and then there is nothing for the rule to name.
    const month: ColumnTransform = {
        ...newTransform('function', 'date_trunc'),
        table: 'PurchaseOrder',
        column: 'PurchaseOrderDate',
        args: { unit: 'month' },
        alias: 'Code',
    };
    const orders: ColumnTransform = {
        ...newTransform('aggregate', 'count'),
        alias: 'Orders',
    };

    const ruleOn = (t: ColumnTransform, over: Partial<FilterRule> = {}): FilterRule => ({
        id: 'r1',
        kind: 'rule',
        transformId: t.id,
        table: '',
        column: '',
        op: '=',
        values: ['X'],
        ...over,
    });

    // A rule naming a computed column has no table, and requiring one is what
    // would silently drop every such filter from the SQL.
    it('counts as complete without a table or column', () => {
        expect(filterIsComplete(ruleOn(month))).toBe(true);
    });

    it('still rejects a source-column rule with no column', () => {
        expect(
            filterIsComplete({ ...ruleOn(month), transformId: undefined }),
        ).toBe(false);
    });

    // The transformation's table is reached through the TRANSFORM, not through
    // the rule - counting it here would count it twice, and would count an
    // empty string for a literal.
    it('names no table in the filter tree', () => {
        expect(filterTables(newGroup('and', [ruleOn(month)]))).toEqual([]);
    });

    it('compares the alias in WHERE', () => {
        const sql = generateSql(
            build({
                anchor: 'PurchaseOrder',
                columns: [col('PurchaseOrder', 'Vendor')],
                transforms: [month],
                filters: newGroup('and', [ruleOn(month, { values: ['ABC'] })]),
            }),
            poOpts,
        );
        expect(sql).toContain("WHERE Code = 'ABC'");
    });

    it('compares the alias in HAVING', () => {
        const sql = generateSql(
            build({
                anchor: 'PurchaseOrder',
                columns: [col('PurchaseOrder', 'Vendor')],
                transforms: [orders],
                having: newGroup('and', [
                    ruleOn(orders, { op: '>', values: ['5'] }),
                ]),
            }),
            poOpts,
        );
        expect(sql).toContain('HAVING Orders > ');
    });

    // Quoted, because the name is something a person typed.
    it('quotes an alias that needs it', () => {
        const spaced = { ...month, alias: 'PO Code' };
        const sql = generateSql(
            build({
                anchor: 'PurchaseOrder',
                columns: [col('PurchaseOrder', 'Vendor')],
                transforms: [spaced],
                filters: newGroup('and', [ruleOn(spaced, { values: ['ABC'] })]),
            }),
            poOpts,
        );
        expect(sql).toContain('WHERE "PO Code" = \'ABC\'');
    });

    // Stale either way; the SQL should say so rather than the rule vanishing.
    it('falls back to the column reference when the transformation is gone', () => {
        const sql = generateSql(
            build({
                anchor: 'PurchaseOrder',
                columns: [col('PurchaseOrder', 'Vendor')],
                transforms: [],
                filters: newGroup('and', [
                    ruleOn(month, { table: 'PurchaseOrder', column: 'POCode' }),
                ]),
            }),
            poOpts,
        );
        expect(sql).toContain('WHERE PurchaseOrder.POCode');
    });
});

describe('sorting by a transformation', () => {
    const orders: ColumnTransform = {
        ...newTransform('aggregate', 'count'),
        alias: 'Orders',
    };

    it('orders by the alias', () => {
        const sql = generateSql(
            build({
                anchor: 'PurchaseOrder',
                columns: [col('PurchaseOrder', 'Vendor')],
                transforms: [orders],
                sort: [{ transformId: orders.id, table: '', column: '', dir: 'desc' }],
            }),
            poOpts,
        );
        expect(sql).toContain('ORDER BY Orders DESC');
    });

    it('leaves a source-column sort alone', () => {
        const sql = generateSql(
            build({
                anchor: 'PurchaseOrder',
                columns: [col('PurchaseOrder', 'Vendor')],
                transforms: [orders],
                sort: [{ table: 'PurchaseOrder', column: 'Vendor', dir: 'asc' }],
            }),
            poOpts,
        );
        expect(sql).toContain('ORDER BY PurchaseOrder.Vendor');
    });
});

describe('sameSortKey', () => {
    // Two transformations can read the same source column - a date rounded to
    // a month and to a year - so they must compare by ID, not by column.
    it('tells two transformations on one column apart', () => {
        const a = { table: 'PO', column: 'Date', transformId: 'x' };
        const b = { table: 'PO', column: 'Date', transformId: 'y' };
        expect(sameSortKey(a, b)).toBe(false);
        expect(sameSortKey(a, { ...a })).toBe(true);
    });

    it('never confuses a transformation with its own source column', () => {
        expect(
            sameSortKey(
                { table: 'PO', column: 'Date', transformId: 'x' },
                { table: 'PO', column: 'Date' },
            ),
        ).toBe(false);
    });

    it('compares source columns case-insensitively', () => {
        expect(sameSortKey({ table: 'po', column: 'date' }, { table: 'PO', column: 'Date' })).toBe(
            true,
        );
    });
});

// The guard added when a real op was first put through these tests: a rule
// naming a transformation that no longer exists, with no column to fall back
// on, has nothing to compare. Emitted, it is `"".""` - a syntax error rather
// than a wrong answer, but an avoidable one.
describe('a rule with nothing left to name', () => {
    it('is dropped rather than emitted empty', () => {
        expect(
            filterSql({
                id: 'r',
                kind: 'rule',
                transformId: 'gone',
                table: '',
                column: '',
                op: '=',
                values: ['X'],
            }),
        ).toBeNull();
    });

    it('still emits when a column remains to fall back on', () => {
        expect(
            filterSql({
                id: 'r',
                kind: 'rule',
                transformId: 'gone',
                table: 'Vendor',
                column: 'VendorName',
                op: '=',
                values: ['X'],
            }),
        ).toBe("Vendor.VendorName = 'X'");
    });
});

// The literal beside a count must be BARE. `count(x) > '5'` runs - DuckDB casts
// an untyped literal - but the generated SQL is meant to be read, and a quoted
// number next to a count reads as a string comparison. The rule no longer
// carries the aggregate once it names a transformation, so the generator fills
// it in from the transformation's own operation.
describe('literals beside a transformation', () => {
    const orders: ColumnTransform = {
        ...newTransform('aggregate', 'count'),
        alias: 'Orders',
    };
    const month: ColumnTransform = {
        ...newTransform('function', 'date_trunc'),
        table: 'PurchaseOrder',
        column: 'PurchaseOrderDate',
        args: { unit: 'month' },
        alias: 'Month',
    };
    const rule = (t: ColumnTransform, op: FilterRule['op'], v: string): FilterRule => ({
        id: 'r',
        kind: 'rule',
        transformId: t.id,
        table: '',
        column: '',
        op,
        values: [v],
    });

    it('writes a number bare against an aggregate transformation', () => {
        const sql = generateSql(
            build({
                anchor: 'PurchaseOrder',
                columns: [col('PurchaseOrder', 'Vendor')],
                transforms: [orders],
                having: newGroup('and', [rule(orders, '>', '5')]),
            }),
            poOpts,
        );
        expect(sql).toContain('HAVING Orders > 5');
    });

    // A date_trunc column compared against a date wants its quotes exactly as
    // a plain column would, so scalar transformations are left alone.
    it('keeps the quotes against a scalar transformation', () => {
        const sql = generateSql(
            build({
                anchor: 'PurchaseOrder',
                columns: [],
                transforms: [month, orders],
                filters: newGroup('and', [rule(month, '>=', '2024-01-01')]),
            }),
            poOpts,
        );
        expect(sql).toContain("WHERE Month >= '2024-01-01'");
    });
});
