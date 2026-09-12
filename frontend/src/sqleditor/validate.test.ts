import { describe, expect, it } from 'vitest';
import {
    aliasMap,
    ambiguousColumns,
    columnIndex,
    joinKeyColumns,
    joinPath,
    joinSuggestion,
    missingTables,
    repairPrompt,
    validateColumns,
} from './validate';
import type { SqlStudioTable } from './types';

const t = (name: string, cols: string[], from?: string): SqlStudioTable => ({
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
];

describe('aliasMap', () => {
    it('maps an explicit alias to its table', () => {
        const m = aliasMap('SELECT * FROM duckle_src."Item" AS T1', TABLES);
        expect(m.get('t1')?.name).toBe('Item');
    });

    it('defaults the alias to the table name when none is given', () => {
        const m = aliasMap('SELECT * FROM duckle_src."Item"', TABLES);
        expect(m.get('item')?.name).toBe('Item');
    });

    it('reads a bare alias with no AS', () => {
        const m = aliasMap('SELECT * FROM Item i', TABLES);
        expect(m.get('i')?.name).toBe('Item');
    });

    it('does not let a short table name claim a longer one', () => {
        const m = aliasMap('SELECT * FROM duckle_src."VendorItem"', TABLES);
        expect(m.get('venditem')).toBeUndefined();
        expect(m.get('vendoritem')?.name).toBe('VendorItem');
    });

    it('maps every table in a join chain', () => {
        const m = aliasMap(
            'SELECT * FROM duckle_src."Item" AS Item LEFT JOIN duckle_src."Vendor" AS Vendor ON Item.Item = Vendor.Vendor',
            TABLES,
        );
        expect([...m.keys()].sort()).toEqual(['item', 'vendor']);
    });

    it('does not read a clause keyword as an alias', () => {
        const m = aliasMap('SELECT * FROM Item WHERE Item.Item = 1', TABLES);
        expect(m.get('where')).toBeUndefined();
        expect(m.get('item')?.name).toBe('Item');
    });
});

describe('validateColumns', () => {
    // The exact failure this was built for.
    it('catches a column hung off the wrong table, and says where it lives', () => {
        const sql = [
            'SELECT Item.*',
            'FROM duckle_src."Item" AS Item',
            'JOIN duckle_src."VendorItem" AS VendorItem ON Item.Item = VendorItem.Item',
            "WHERE VendorItem.VendorName = 'Medline'",
        ].join('\n');
        const problems = validateColumns(sql, TABLES);
        expect(problems).toHaveLength(1);
        expect(problems[0]).toMatchObject({
            ref: 'VendorItem.VendorName',
            table: 'VendorItem',
            column: 'VendorName',
            foundOn: ['Vendor'],
        });
    });

    it('passes a query whose columns all exist', () => {
        const sql =
            'SELECT Item.Description FROM duckle_src."Item" AS Item JOIN duckle_src."Vendor" AS Vendor ON Item.Item = Vendor.Vendor';
        expect(validateColumns(sql, TABLES)).toEqual([]);
    });

    it('is case-insensitive about column names', () => {
        const sql = 'SELECT Item.description FROM duckle_src."Item" AS Item';
        expect(validateColumns(sql, TABLES)).toEqual([]);
    });

    // A schema qualifier is not an alias; judging it would flag every query.
    it('ignores the attach alias in a qualified name', () => {
        const sql = 'SELECT * FROM duckle_src."Item" AS Item';
        expect(validateColumns(sql, TABLES)).toEqual([]);
    });

    // Missing information is not evidence of a mistake.
    it('says nothing about a table whose columns could not be read', () => {
        const unknown = [t('Mystery', [], 'duckle_src."Mystery"')];
        const sql = 'SELECT Mystery.whatever FROM duckle_src."Mystery" AS Mystery';
        expect(validateColumns(sql, unknown)).toEqual([]);
    });

    it('does not flag a column name that only appears in a string', () => {
        const sql = "SELECT * FROM duckle_src.\"Item\" AS Item WHERE Item.Description = 'Item.Nope'";
        expect(validateColumns(sql, TABLES)).toEqual([]);
    });

    it('reports each bad reference once, however often it is written', () => {
        const sql =
            'SELECT Item.Nope FROM duckle_src."Item" AS Item WHERE Item.Nope = 1 OR Item.Nope = 2';
        expect(validateColumns(sql, TABLES)).toHaveLength(1);
    });

    it('reports a column no table has, with an empty foundOn', () => {
        const sql = 'SELECT Item.Zzz FROM duckle_src."Item" AS Item';
        expect(validateColumns(sql, TABLES)[0].foundOn).toEqual([]);
    });
});

describe('repairPrompt', () => {
    it('names where the column actually is', () => {
        const problems = validateColumns(
            'SELECT VendorItem.VendorName FROM duckle_src."VendorItem" AS VendorItem',
            TABLES,
        );
        expect(repairPrompt(problems)).toContain('VendorName is on Vendor');
    });

    it('says so when no table has the column at all', () => {
        const problems = validateColumns(
            'SELECT Item.Zzz FROM duckle_src."Item" AS Item',
            TABLES,
        );
        expect(repairPrompt(problems)).toContain('no table in the schema has a column named Zzz');
    });
});

describe('columnIndex', () => {
    it('inverts the schema so a column names its tables', () => {
        expect(columnIndex(TABLES)).toContain('VendorName: Vendor');
    });

    it('lists every table for a column that several share', () => {
        expect(columnIndex(TABLES)).toContain('Item: Item, ItemLocation, VendorItem');
    });

    it('is empty when nothing has columns', () => {
        expect(columnIndex([t('A', [])])).toBe('');
    });
});

describe('missingTables', () => {
    // The exact second failure: told VendorName is on Vendor, the model used
    // Vendor.VendorName and never added Vendor to the FROM chain. Every column
    // reference is valid against the table it names, so the column check alone
    // sees nothing wrong.
    it('catches a table referenced but never joined', () => {
        const sql = [
            'SELECT Item.*',
            'FROM duckle_src."Item" AS Item',
            'JOIN duckle_src."VendorItem" AS VendorItem ON Item.Item = VendorItem.Item',
            "WHERE Vendor.VendorName = 'Medline'",
        ].join('\n');
        expect(missingTables(sql, TABLES)).toEqual(['Vendor']);
        // And nothing is wrong with the COLUMN — that is why this check exists.
        expect(validateColumns(sql, TABLES)).toEqual([]);
    });

    it('says nothing when every table used is joined', () => {
        const sql =
            'SELECT Item.Item FROM duckle_src."Item" AS Item JOIN duckle_src."Vendor" AS Vendor ON Item.Item = Vendor.Vendor';
        expect(missingTables(sql, TABLES)).toEqual([]);
    });

    it('ignores a qualifier that is not a known table', () => {
        const sql = 'SELECT T9.x FROM duckle_src."Item" AS Item';
        expect(missingTables(sql, TABLES)).toEqual([]);
    });

    it('ignores the attach alias', () => {
        expect(missingTables('SELECT * FROM duckle_src."Item" AS Item', TABLES)).toEqual([]);
    });
});

describe('joinSuggestion', () => {
    const RELS = [
        {
            id: 'r1',
            fromTable: 'Vendor',
            fromColumn: 'Vendor',
            toTable: 'VendorItem',
            toColumn: 'Vendor',
        },
    ];

    it('builds the join that connects the missing table to one already there', () => {
        expect(joinSuggestion('Vendor', ['Item', 'VendorItem'], TABLES, RELS)).toBe(
            'JOIN duckle_src."Vendor" AS Vendor ON Vendor.Vendor = VendorItem.Vendor',
        );
    });

    // Two joins away, so there is no single clause to offer. Better to say
    // nothing than to suggest a join to a table that is not in scope either.
    it('offers nothing when no relationship reaches a table in the query', () => {
        expect(joinSuggestion('Vendor', ['Item'], TABLES, RELS)).toBeNull();
    });
});

describe('repairPrompt with a missing table', () => {
    it('spells out the join to add', () => {
        const text = repairPrompt(
            [],
            ['Vendor'],
            TABLES,
            [
                {
                    id: 'r1',
                    fromTable: 'Vendor',
                    fromColumn: 'Vendor',
                    toTable: 'VendorItem',
                    toColumn: 'Vendor',
                },
            ],
            ['Item', 'VendorItem'],
        );
        expect(text).toContain('Vendor is used but never joined. Add these joins, in this order:');
        expect(text).toContain('ON Vendor.Vendor = VendorItem.Vendor');
    });
});

describe('joinPath', () => {
    const RELS = [
        { id: 'a', fromTable: 'Item', fromColumn: 'Item', toTable: 'VendorItem', toColumn: 'Item' },
        {
            id: 'b',
            fromTable: 'Vendor',
            fromColumn: 'Vendor',
            toTable: 'VendorItem',
            toColumn: 'Vendor',
        },
    ];

    it('returns nothing to do when the table is already there', () => {
        expect(joinPath('Item', ['Item'], TABLES, RELS)).toEqual([]);
    });

    it('walks TWO hops, emitting both joins in order', () => {
        // Vendor is not adjacent to Item — it is reached through VendorItem.
        // Offering only the last join is an instruction that cannot be followed.
        const path = joinPath('Vendor', ['Item'], TABLES, RELS);
        expect(path).toEqual([
            'JOIN duckle_src."VendorItem" AS VendorItem ON Item.Item = VendorItem.Item',
            'JOIN duckle_src."Vendor" AS Vendor ON Vendor.Vendor = VendorItem.Vendor',
        ]);
    });

    it('takes the shortest route when one table is already joined', () => {
        expect(joinPath('Vendor', ['Item', 'VendorItem'], TABLES, RELS)).toHaveLength(1);
    });

    it('returns null when the ER model does not connect the table', () => {
        expect(joinPath('ItemLocation', ['Item'], TABLES, RELS)).toBeNull();
    });
});

describe('ambiguousColumns', () => {
    it('picks out only the columns that live on several tables', () => {
        const withDupe = [
            ...TABLES,
            t('item_norm.parquet', ['Item', 'VendorName'], "read_parquet('/tmp/n.parquet')"),
        ];
        const problems = validateColumns(
            'SELECT Item.VendorName FROM duckle_src."Item" AS Item',
            withDupe,
        );
        expect(ambiguousColumns(problems)[0].foundOn).toEqual(['Vendor', 'item_norm.parquet']);
    });

    it('leaves an unambiguous problem alone', () => {
        const problems = validateColumns(
            'SELECT Item.VendorName FROM duckle_src."Item" AS Item',
            TABLES,
        );
        expect(ambiguousColumns(problems)).toEqual([]);
    });
});

describe('repairPrompt spells out the whole route', () => {
    const RELS = [
        { id: 'a', fromTable: 'Item', fromColumn: 'Item', toTable: 'VendorItem', toColumn: 'Item' },
        {
            id: 'b',
            fromTable: 'Vendor',
            fromColumn: 'Vendor',
            toTable: 'VendorItem',
            toColumn: 'Vendor',
        },
    ];

    it('gives every join needed, not just the last one', () => {
        const problems = validateColumns(
            'SELECT Item.VendorName FROM duckle_src."Item" AS Item',
            TABLES,
        );
        const text = repairPrompt(problems, [], TABLES, RELS, ['Item']);
        expect(text).toContain('VendorName is on Vendor');
        expect(text).toContain('AS VendorItem ON Item.Item = VendorItem.Item');
        expect(text).toContain('AS Vendor ON Vendor.Vendor = VendorItem.Vendor');
        expect(text).toContain('Then write Vendor.VendorName');
    });

    it('says so plainly when no relationship reaches the table', () => {
        const problems = validateColumns(
            'SELECT Item.Location FROM duckle_src."Item" AS Item',
            TABLES,
        );
        expect(repairPrompt(problems, [], TABLES, [], ['Item'])).toContain(
            'no relationship reaching it',
        );
    });
});

describe('unqualified columns', () => {
    const WITH_DUPE = [
        ...TABLES,
        t('item_norm.parquet', ['Item', 'VendorName'], "read_parquet('/tmp/n.parquet')"),
    ];

    // The draft that slipped through: `WHERE VendorName = 'Medline'` names no
    // table, so there was no alias to judge — but nothing in the FROM chain has
    // a VendorName, which is exactly as broken as putting it on the wrong table.
    it('catches a bare column no table in the query can supply', () => {
        const sql = [
            'SELECT Item.*, VendorName',
            'FROM duckle_src."Item" AS Item',
            'JOIN duckle_src."VendorItem" AS VendorItem ON Item.Item = VendorItem.Item',
            "WHERE VendorName = 'Medline'",
        ].join('\n');
        const problems = validateColumns(sql, WITH_DUPE);
        expect(problems).toHaveLength(1);
        expect(problems[0]).toMatchObject({ ref: 'VendorName', alias: '' });
        // Two candidates, so this is the case that must ask the person.
        expect(ambiguousColumns(problems)[0].foundOn).toEqual(['Vendor', 'item_norm.parquet']);
    });

    it('accepts a bare column a joined table does supply', () => {
        const sql = 'SELECT Description FROM duckle_src."Item" AS Item';
        expect(validateColumns(sql, TABLES)).toEqual([]);
    });

    // Only words it can identify as columns are judged; anything else may be a
    // function, a keyword, or an alias the query defined.
    it('ignores a word that is not a column anywhere', () => {
        expect(validateColumns('SELECT sum(x) AS total FROM duckle_src."Item" AS Item', TABLES))
            .toEqual([]);
    });

    it('ignores a table alias used bare', () => {
        const sql = 'SELECT Item.Item FROM duckle_src."Item" AS Item';
        expect(validateColumns(sql, TABLES)).toEqual([]);
    });

    it('ignores an output alias being defined', () => {
        const sql = 'SELECT Item.Item AS VendorName FROM duckle_src."Item" AS Item';
        expect(validateColumns(sql, TABLES)).toEqual([]);
    });

    it('ignores a bare name inside a string', () => {
        const sql = "SELECT Item.Item FROM duckle_src.\"Item\" AS Item WHERE Item.Item = 'VendorName'";
        expect(validateColumns(sql, TABLES)).toEqual([]);
    });

    it('reports it once however often it is written', () => {
        const sql =
            "SELECT VendorName FROM duckle_src.\"Item\" AS Item WHERE VendorName = 'x' OR VendorName = 'y'";
        expect(validateColumns(sql, TABLES)).toHaveLength(1);
    });
});

describe('joinKeyColumns', () => {
    // The only signal that separates a code from a name here: everything comes
    // in as text, so the types are identical and the ER model is the sole
    // record of which column is an identifier.
    it('lists both ends of every relationship', () => {
        expect(
            joinKeyColumns([
                {
                    id: 'r',
                    fromTable: 'Vendor',
                    fromColumn: 'Vendor',
                    toTable: 'VendorItem',
                    toColumn: 'Vendor',
                },
            ]),
        ).toEqual(['Vendor.Vendor', 'VendorItem.Vendor']);
    });

    it('does not repeat a column two relationships share', () => {
        const keys = joinKeyColumns([
            { id: 'a', fromTable: 'Item', fromColumn: 'Item', toTable: 'VendorItem', toColumn: 'Item' },
            { id: 'b', fromTable: 'Item', fromColumn: 'Item', toTable: 'ItemLocation', toColumn: 'Item' },
        ]);
        expect(keys.filter(k => k === 'Item.Item')).toHaveLength(1);
    });
});
