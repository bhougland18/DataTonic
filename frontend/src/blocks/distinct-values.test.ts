import { describe, expect, it } from 'vitest';
import { distinctSql, VALUE_LIMIT } from './distinct-values';

const SQL = distinctSql('VendorName', 'duckle_src."Vendor"');

describe('distinctSql', () => {
    it('asks for the value and how many rows have it', () => {
        expect(SQL).toContain('SELECT VendorName AS value, count(*) AS n');
        expect(SQL).toContain('GROUP BY 1');
    });

    // Alphabetical order plus a LIMIT returns fifty values beginning with A on
    // a large column, which is worse than no list at all.
    it('orders by frequency, then alphabetically to break ties', () => {
        expect(SQL).toContain('ORDER BY 2 DESC, 1');
    });

    it('leaves nulls out — they are not a value to filter on', () => {
        expect(SQL).toContain('WHERE VendorName IS NOT NULL');
    });

    it('caps the list', () => {
        expect(SQL).toContain(`LIMIT ${VALUE_LIMIT}`);
        expect(distinctSql('c', 't', 10)).toContain('LIMIT 10');
    });

    // The engine wraps a node's body in `({sql})`, where a terminator is a
    // syntax error rather than a harmless habit.
    it('has no trailing semicolon', () => {
        expect(SQL.trim().endsWith(';')).toBe(false);
    });

    it('quotes a column name that is not a plain identifier', () => {
        expect(distinctSql('Item Group', 't')).toContain('"Item Group"');
    });

    it('takes the address verbatim, however the table is read', () => {
        const parquet = distinctSql('Item', "read_parquet('/w/item.parquet')");
        expect(parquet).toContain("FROM read_parquet('/w/item.parquet')");
    });
});
