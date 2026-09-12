import { describe, expect, it } from 'vitest';
import { qualifyTables, splitLiterals } from './qualify';
import type { SqlStudioTable } from './types';

const t = (name: string, from?: string): SqlStudioTable => ({
    name,
    kind: 'upstream',
    columns: [],
    from,
});

const TABLES = [
    t('Item', 'duckle_src.Item'),
    t('VendorItem', 'duckle_src.VendorItem'),
    t('Vendor', 'duckle_src.Vendor'),
    t('item_norm.parquet', "read_parquet('/tmp/n.parquet')"),
];

describe('qualifyTables', () => {
    it('qualifies a bare table and aliases it back to its own name', () => {
        expect(qualifyTables('SELECT * FROM Item', TABLES)).toBe(
            'SELECT * FROM duckle_src.Item AS Item',
        );
    });

    it('repairs the exact query the model produced', () => {
        const broken = [
            'SELECT Item.*, VendorItem.*, Vendor.*',
            'FROM Item',
            'LEFT JOIN VendorItem ON Item.Item = VendorItem.Item',
            'LEFT JOIN Vendor ON VendorItem.Vendor = Vendor.Vendor',
            "WHERE Vendor.VendorName = 'Medline'",
        ].join('\n');
        expect(qualifyTables(broken, TABLES)).toBe(
            [
                'SELECT Item.*, VendorItem.*, Vendor.*',
                'FROM duckle_src.Item AS Item',
                'LEFT JOIN duckle_src.VendorItem AS VendorItem ON Item.Item = VendorItem.Item',
                'LEFT JOIN duckle_src.Vendor AS Vendor ON VendorItem.Vendor = Vendor.Vendor',
                "WHERE Vendor.VendorName = 'Medline'",
            ].join('\n'),
        );
    });

    // A model that renames tables renames them everywhere, so its own
    // `T1.Item` references resolve. Forcing our alias back would break them.
    it("keeps the model's own alias rather than replacing it", () => {
        expect(qualifyTables('SELECT * FROM Item AS T1 WHERE T1.x = 1', TABLES)).toBe(
            'SELECT * FROM duckle_src.Item AS T1 WHERE T1.x = 1',
        );
    });

    it('keeps a bare alias too', () => {
        expect(qualifyTables('SELECT * FROM Item i', TABLES)).toBe(
            'SELECT * FROM duckle_src.Item i',
        );
    });

    // `FROM Item WHERE` is identifier-whitespace-identifier, the same shape as
    // an alias. Reading WHERE as an alias would silently drop the filter.
    it('does not mistake a following keyword for an alias', () => {
        expect(qualifyTables('SELECT * FROM Item WHERE x = 1', TABLES)).toBe(
            'SELECT * FROM duckle_src.Item AS Item WHERE x = 1',
        );
    });

    it('leaves an already-qualified name alone', () => {
        const sql = 'SELECT * FROM duckle_src.Item AS Item';
        expect(qualifyTables(sql, TABLES)).toBe(sql);
    });

    // The dot is part of the NAME here, not a schema qualifier — the case an
    // identifier-at-a-time reader skips as "already qualified".
    it('rewrites a table name that itself contains a dot, and quotes its alias', () => {
        expect(qualifyTables('SELECT * FROM item_norm.parquet', TABLES)).toBe(
            `SELECT * FROM read_parquet('/tmp/n.parquet') AS "item_norm.parquet"`,
        );
    });

    it('does not let a short name match the front of a longer one', () => {
        // `Item` must not match the `item` in `item_norm.parquet`.
        expect(qualifyTables('SELECT * FROM item_norm.parquet', TABLES)).not.toContain(
            'duckle_src.Item',
        );
    });

    it('ignores a table name that only appears inside a string literal', () => {
        const sql = "SELECT * FROM Item WHERE note = 'see FROM Vendor'";
        expect(qualifyTables(sql, TABLES)).toBe(
            "SELECT * FROM duckle_src.Item AS Item WHERE note = 'see FROM Vendor'",
        );
    });

    it('does not match an identifier that merely ends in from/join', () => {
        const sql = 'SELECT xfrom FROM Item';
        expect(qualifyTables(sql, TABLES)).toBe('SELECT xfrom FROM duckle_src.Item AS Item');
    });

    it('leaves unknown tables untouched, rather than guessing', () => {
        expect(qualifyTables('SELECT * FROM Unknown', TABLES)).toBe('SELECT * FROM Unknown');
    });

    // The node path: nothing carries an address, so there is nothing to repair.
    it('is a no-op when no table has an address', () => {
        const sql = 'SELECT * FROM input JOIN other ON 1=1';
        expect(qualifyTables(sql, [t('input'), t('other')])).toBe(sql);
    });
});

describe('splitLiterals', () => {
    it('separates single-quoted strings from code', () => {
        expect(splitLiterals("a = 'b' AND c").map(s => s.text)).toEqual(['a = ', "'b'", ' AND c']);
    });

    it('treats a doubled quote as an escape, not a terminator', () => {
        const parts = splitLiterals("x = 'O''Brien' AND y");
        expect(parts.find(p => !p.code)?.text).toBe("'O''Brien'");
    });

    it('treats a quoted identifier as a literal run too', () => {
        expect(splitLiterals('FROM "odd name" x').filter(p => !p.code)[0].text).toBe('"odd name"');
    });
});
