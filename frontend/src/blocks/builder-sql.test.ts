import { describe, expect, it } from 'vitest';
import {
    collidingNames,
    filterSql,
    generateSql,
    selectExpression,
    withCollisionAliases,
} from './builder-sql';
import {
    ALL_OPERATORS,
    aggregatesFor,
    arity,
    emptyBuilder,
    filterIsComplete,
    newGroup,
    operatorsFor,
    type BuilderState,
    type FilterRule,
} from './builder-types';
import type { SqlStudioTable } from '../sqleditor/types';
import type { ErdRelationship } from '../erd/model';

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

