import { describe, expect, it } from 'vitest';
import { hasAddresses, schemaText } from './AiPane';
import type { SqlStudioTable } from './types';
import type { ErdRelationship } from '../erd/model';

function table(over: Partial<SqlStudioTable> & { name: string }): SqlStudioTable {
    return { kind: 'upstream', columns: [], ...over };
}

function rel(over: Partial<ErdRelationship> & { id: string }): ErdRelationship {
    return {
        fromTable: 'Item',
        fromColumn: 'ItemID',
        toTable: 'VendorItem',
        toColumn: 'Item',
        inferred: false,
        ...over,
    };
}

describe('schemaText', () => {
    const item = table({ name: 'Item', columns: [{ name: 'ItemID' }, { name: 'Description' }] });

    it('lists each table with its columns', () => {
        expect(schemaText([item], [])).toContain('Item: ItemID, Description');
    });

    it('says so when a table has no columns, rather than listing nothing', () => {
        // An empty list would read as "this table has no columns", which is a
        // different and false claim from "we could not read them".
        expect(schemaText([table({ name: 'Vendor' })], [])).toContain('Vendor: (columns unknown)');
    });

    // The node path: a table's name IS what you write after FROM, so an
    // address section would be noise the model has to reconcile.
    it('keeps the compact form when no table needs an address', () => {
        expect(hasAddresses([item])).toBe(false);
        expect(schemaText([item], [])).not.toContain('FROM/JOIN');
    });

    it('treats a `from` that merely repeats the name as no address at all', () => {
        const same = table({ ...item, from: 'Item' });
        expect(hasAddresses([same])).toBe(false);
        expect(schemaText([same], [])).not.toContain('FROM/JOIN');
    });

    // The Blocks path: the address is `"duckle_src"."Item"`, and without this
    // the model writes `FROM Item` and the query fails.
    it('puts the address in the table entry itself, beside its columns', () => {
        const addressed = table({ ...item, from: '"duckle_src"."Item"' });
        const text = schemaText([addressed], []);
        // One entry carrying both, so there is no second list to ignore.
        expect(text).toContain('Table Item');
        expect(text).toContain('  FROM/JOIN: "duckle_src"."Item" AS Item');
        expect(text).toContain('  Columns: ItemID, Description');
    });

    // The alias is what keeps the two halves consistent: join keys come from
    // the ER model, which knows tables by name only.
    it('keeps join keys in terms of the names the aliases restore', () => {
        const addressed = table({ ...item, from: '"duckle_src"."Item"' });
        const text = schemaText([addressed], [rel({ id: 'r1' })]);
        expect(text).toContain('AS Item');
        expect(text).toContain('Item.ItemID = VendorItem.Item');
    });

    // A file-derived dataset is named `item_norm.parquet`. Unquoted, DuckDB
    // reads `item_norm.parquet.Item` as schema.table.column and looks for a
    // schema that does not exist, so every join touching it was broken.
    describe('a table name that is not a plain SQL identifier', () => {
        const parquet = table({
            name: 'item_norm.parquet',
            columns: [{ name: 'Item' }],
            from: "read_parquet('/tmp/item_norm.parquet')",
        });

        it('quotes the alias', () => {
            expect(schemaText([parquet], [])).toContain(
                `AS "item_norm.parquet"`,
            );
        });

        it('quotes it on both sides of a join key', () => {
            const text = schemaText(
                [item, parquet],
                [rel({ id: 'r1', toTable: 'item_norm.parquet', toColumn: 'Item' })],
            );
            expect(text).toContain(`Item.ItemID = "item_norm.parquet".Item`);
        });

        it('leaves ordinary names unquoted, so they stay case-insensitive', () => {
            expect(schemaText([item], [rel({ id: 'r1' })])).toContain(
                'Item.ItemID = VendorItem.Item',
            );
        });
    });

    it('warns about qualifiers only when a join carries one', () => {
        const plain = schemaText([item], [rel({ id: 'r1' })]);
        expect(plain).not.toContain('Keep them in the ON clause');

        const qualified = schemaText(
            [item],
            [
                rel({
                    id: 'r1',
                    qualifiers: [{ table: 'Item', column: 'source', op: '=', value: 'RQ' }],
                }),
            ],
        );
        expect(qualified).toContain('Keep them in the ON clause');
    });
});
