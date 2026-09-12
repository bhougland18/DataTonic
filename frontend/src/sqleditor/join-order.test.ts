import { describe, expect, it } from 'vitest';
import { aliasOf, forwardReferences, onDependencies, parseFromChain, reorderJoins } from './join-order';

// The query the model actually produced: Vendor is joined before VendorItem,
// but its ON names VendorItem. DuckDB: `Referenced table "VendorItem" not
// found! Candidate tables: "Vendor", "ItemLocation"`.
const BROKEN = [
    'SELECT Item.*, ItemLocation.*, Vendor.Vendor, Vendor.VendorName',
    'FROM duckle_src."Item" AS Item',
    'JOIN duckle_src."ItemLocation" AS ItemLocation',
    '  ON Item.Item = ItemLocation.Item',
    'JOIN duckle_src."Vendor" AS Vendor ON Vendor.Vendor = VendorItem.Vendor',
    'JOIN duckle_src."VendorItem" AS VendorItem',
    '  ON Item.Item = VendorItem.Item',
    "WHERE Vendor.VendorName = 'Medline'",
].join('\n');

describe('aliasOf', () => {
    it('reads an explicit alias', () => {
        expect(aliasOf('duckle_src."Vendor" AS Vendor')).toBe('Vendor');
    });

    it('unquotes an alias that needed quoting', () => {
        expect(aliasOf(`read_parquet('/tmp/x.parquet') AS "item_norm.parquet"`)).toBe(
            'item_norm.parquet',
        );
    });

    it('falls back to the relation name when there is no alias', () => {
        expect(aliasOf('duckle_src."Item"')).toBe('Item');
    });

    it('reads a bare alias', () => {
        expect(aliasOf('Item i')).toBe('i');
    });
});

describe('onDependencies', () => {
    it('lists the other tables an ON clause needs', () => {
        expect(onDependencies('Vendor.Vendor = VendorItem.Vendor', 'Vendor')).toEqual(['VendorItem']);
    });

    it('ignores a name that only appears in a string', () => {
        expect(onDependencies("A.x = 'B.y'", 'A')).toEqual([]);
    });
});

describe('parseFromChain', () => {
    it('splits the anchor, the joins and the tail', () => {
        const chain = parseFromChain(BROKEN);
        expect(chain?.anchor.alias).toBe('Item');
        expect(chain?.joins.map(j => j.alias)).toEqual(['ItemLocation', 'Vendor', 'VendorItem']);
        expect(chain?.tail.trim()).toBe("WHERE Vendor.VendorName = 'Medline'");
    });

    // Shapes we do not model are refused outright rather than half-parsed.
    it('refuses a comma join', () => {
        expect(parseFromChain('SELECT * FROM a, b WHERE a.x = b.x')).toBeNull();
    });

    it('refuses a join with USING instead of ON', () => {
        expect(parseFromChain('SELECT * FROM a JOIN b USING (x)')).toBeNull();
    });
});

describe('forwardReferences', () => {
    it('names the table referenced before it is joined', () => {
        expect(forwardReferences(BROKEN)).toEqual(['VendorItem']);
    });

    it('finds none in a correctly ordered chain', () => {
        const ok = [
            'SELECT *',
            'FROM duckle_src."Item" AS Item',
            'JOIN duckle_src."VendorItem" AS VendorItem ON Item.Item = VendorItem.Item',
            'JOIN duckle_src."Vendor" AS Vendor ON Vendor.Vendor = VendorItem.Vendor',
        ].join('\n');
        expect(forwardReferences(ok)).toEqual([]);
    });
});

describe('reorderJoins', () => {
    it('moves the join after the table it references', () => {
        const { sql, moved } = reorderJoins(BROKEN);
        expect(moved).toBe(true);
        expect(forwardReferences(sql)).toEqual([]);
        // VendorItem now precedes Vendor, which is the whole fix.
        expect(sql.indexOf('"VendorItem" AS VendorItem')).toBeLessThan(
            sql.indexOf('"Vendor" AS Vendor'),
        );
    });

    it('keeps the SELECT list and the WHERE clause intact', () => {
        const { sql } = reorderJoins(BROKEN);
        expect(sql).toContain('SELECT Item.*, ItemLocation.*, Vendor.Vendor, Vendor.VendorName');
        expect(sql).toContain("WHERE Vendor.VendorName = 'Medline'");
        expect(sql).toContain('ON Vendor.Vendor = VendorItem.Vendor');
    });

    // A working query is never restructured — reordering an outer join can
    // change which rows survive, and there is no reason to risk that.
    it('leaves an already-valid chain exactly as written', () => {
        const ok = [
            'SELECT *',
            'FROM duckle_src."Item" AS Item',
            'LEFT JOIN duckle_src."VendorItem" AS VendorItem ON Item.Item = VendorItem.Item',
        ].join('\n');
        expect(reorderJoins(ok)).toEqual({ sql: ok, moved: false });
    });

    it('preserves each join keyword when it moves one', () => {
        const sql = [
            'SELECT *',
            'FROM duckle_src."Item" AS Item',
            'LEFT JOIN duckle_src."Vendor" AS Vendor ON Vendor.Vendor = VendorItem.Vendor',
            'JOIN duckle_src."VendorItem" AS VendorItem ON Item.Item = VendorItem.Item',
        ].join('\n');
        const out = reorderJoins(sql);
        expect(out.moved).toBe(true);
        expect(out.sql).toContain('LEFT JOIN duckle_src."Vendor" AS Vendor');
        expect(forwardReferences(out.sql)).toEqual([]);
    });

    // Unorderable means a reference to something not in the query at all —
    // a different problem, and not one to paper over by shuffling.
    it('gives up rather than guessing when the chain cannot be satisfied', () => {
        const sql = [
            'SELECT *',
            'FROM duckle_src."Item" AS Item',
            'JOIN duckle_src."Vendor" AS Vendor ON Vendor.Vendor = Nowhere.Vendor',
        ].join('\n');
        expect(reorderJoins(sql)).toEqual({ sql, moved: false });
    });

    it('leaves a shape it cannot parse alone', () => {
        const sql = 'SELECT * FROM a, b WHERE a.x = b.x';
        expect(reorderJoins(sql)).toEqual({ sql, moved: false });
    });
});
