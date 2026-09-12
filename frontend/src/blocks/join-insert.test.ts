import { describe, expect, it } from 'vitest';
import { insertJoin, joinInsertionPoint, mentionsTable, tableClause } from './join-insert';
import type { ErdRelationship } from '../erd/model';
import type { SqlStudioTable } from '../sqleditor/types';

const tbl = (name: string, from?: string): SqlStudioTable => ({
    name,
    kind: 'upstream',
    columns: [],
    from,
});

const TABLES = [
    tbl('Item', 'duckle_src."Item"'),
    tbl('VendorItem', 'duckle_src."VendorItem"'),
    tbl('Vendor', 'duckle_src."Vendor"'),
    tbl('item_norm.parquet', "read_parquet('/tmp/n.parquet')"),
];

const REL: ErdRelationship = {
    id: 'r',
    fromTable: 'Item',
    fromColumn: 'Item',
    toTable: 'VendorItem',
    toColumn: 'Item',
};

describe('tableClause', () => {
    it('addresses the table and aliases it to its own name', () => {
        expect(tableClause('Item', TABLES)).toBe('duckle_src."Item" AS Item');
    });

    it('quotes an alias that is not a plain identifier', () => {
        expect(tableClause('item_norm.parquet', TABLES)).toBe(
            `read_parquet('/tmp/n.parquet') AS "item_norm.parquet"`,
        );
    });
});

describe('mentionsTable', () => {
    it('finds a table used as an alias', () => {
        expect(mentionsTable('SELECT * FROM duckle_src."Item" AS Item', 'Item')).toBe(true);
    });

    it('finds a table named only inside a quoted identifier', () => {
        expect(mentionsTable('SELECT * FROM duckle_src."Item"', 'Item')).toBe(true);
    });

    // `"` is an identifier, `'` is data — the word Item in a string is a
    // coincidence, and treating it as a table reference would block a join the
    // user can legitimately add.
    it('ignores the name inside a string literal', () => {
        expect(mentionsTable("SELECT * FROM Vendor WHERE note = 'Item'", 'Item')).toBe(false);
    });

    it('does not find a short name inside a longer one', () => {
        expect(mentionsTable('SELECT * FROM VendorItem AS VendorItem', 'Item')).toBe(false);
    });

    it('does not mistake a column reference for the table', () => {
        expect(mentionsTable('SELECT VendorItem.Item FROM VendorItem', 'Item')).toBe(false);
    });
});

describe('joinInsertionPoint', () => {
    it('puts the join before WHERE, not at the end', () => {
        const sql = 'SELECT * FROM Item\nWHERE x = 1';
        expect(sql.slice(joinInsertionPoint(sql)).trim()).toBe('WHERE x = 1');
    });

    it('appends when there is no trailing clause', () => {
        const sql = 'SELECT * FROM Item';
        expect(joinInsertionPoint(sql)).toBe(sql.length);
    });

    // A WHERE belonging to a subquery is not the outer query's tail; splicing
    // before it would drop the join inside the parentheses.
    it('ignores a WHERE nested inside a subquery', () => {
        const sql = 'SELECT * FROM (SELECT * FROM t WHERE a = 1) s';
        expect(joinInsertionPoint(sql)).toBe(sql.length);
    });

    it('ignores a WHERE that only appears in a string', () => {
        const sql = "SELECT 'WHERE' FROM Item";
        expect(joinInsertionPoint(sql)).toBe(sql.length);
    });
});

describe('insertJoin', () => {
    it('seeds a whole query when the editor is empty', () => {
        const r = insertJoin('', REL, 'inner', TABLES);
        expect(r).toEqual({
            kind: 'seed',
            sql:
                'SELECT *\nFROM duckle_src."Item" AS Item\n' +
                'JOIN duckle_src."VendorItem" AS VendorItem\n  ON Item.Item = VendorItem.Item\n',
        });
    });

    it('anchors the seed on the side whose rows are all kept', () => {
        const r = insertJoin('', REL, 'keep-to', TABLES);
        if (r.kind === 'blocked') throw new Error('expected a seed');
        expect(r.sql).toContain('FROM duckle_src."VendorItem" AS VendorItem');
        expect(r.sql).toContain('LEFT JOIN duckle_src."Item" AS Item');
    });

    it('appends to a query that already has one side', () => {
        const r = insertJoin('SELECT *\nFROM duckle_src."Item" AS Item', REL, 'inner', TABLES);
        if (r.kind === 'blocked') throw new Error('expected an append');
        expect(r.sql).toBe(
            'SELECT *\nFROM duckle_src."Item" AS Item\n' +
                'JOIN duckle_src."VendorItem" AS VendorItem\n  ON Item.Item = VendorItem.Item\n',
        );
    });

    it('splices before an existing WHERE rather than after it', () => {
        const r = insertJoin(
            'SELECT *\nFROM duckle_src."Item" AS Item\nWHERE Item.x = 1',
            REL,
            'inner',
            TABLES,
        );
        if (r.kind === 'blocked') throw new Error('expected an append');
        expect(r.sql).toBe(
            'SELECT *\nFROM duckle_src."Item" AS Item\n' +
                'JOIN duckle_src."VendorItem" AS VendorItem\n  ON Item.Item = VendorItem.Item\n' +
                'WHERE Item.x = 1',
        );
    });

    it('carries qualifiers into the ON clause', () => {
        const qualified: ErdRelationship = {
            ...REL,
            qualifiers: [{ table: 'VendorItem', column: 'source', op: '=', value: 'RQ' }],
        };
        const r = insertJoin('SELECT * FROM Item AS Item', qualified, 'inner', TABLES);
        if (r.kind === 'blocked') throw new Error('expected an append');
        expect(r.sql).toContain("ON Item.Item = VendorItem.Item AND VendorItem.source = 'RQ'");
    });

    it('refuses when neither table is in the query', () => {
        const r = insertJoin('SELECT * FROM duckle_src."Vendor" AS Vendor', REL, 'inner', TABLES);
        expect(r).toMatchObject({ kind: 'blocked' });
    });

    it('refuses when the join is already there', () => {
        const sql = 'SELECT * FROM Item AS Item JOIN VendorItem AS VendorItem ON 1=1';
        expect(insertJoin(sql, REL, 'inner', TABLES)).toMatchObject({ kind: 'blocked' });
    });

    // The silent-wrong-answer case: appending a LEFT JOIN keeps the rows of the
    // table already in FROM, so asking to keep the absent table's rows would
    // quietly produce the opposite of what the arrow says.
    it('refuses to keep every row of a table that is not the anchor', () => {
        const r = insertJoin(
            'SELECT * FROM duckle_src."Item" AS Item',
            REL,
            'keep-to',
            TABLES,
        );
        expect(r.kind).toBe('blocked');
        if (r.kind !== 'blocked') return;
        expect(r.reason).toContain('VendorItem');
    });

    it('allows keeping the anchor side, which a LEFT JOIN does express', () => {
        const r = insertJoin(
            'SELECT * FROM duckle_src."Item" AS Item',
            REL,
            'keep-from',
            TABLES,
        );
        if (r.kind === 'blocked') throw new Error('expected an append');
        expect(r.sql).toContain('LEFT JOIN duckle_src."VendorItem" AS VendorItem');
    });
});
