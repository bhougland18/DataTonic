import { describe, expect, it } from 'vitest';
import {
    addTable,
    canReach,
    cycleSort,
    rebuildJoins,
    removeFilterNode,
    removeTable,
    requiredTables,
    setAggregate,
    setJoinMode,
    toggleAllColumns,
    toggleColumn,
    unreachableTables,
} from './builder-ops';
import {
    emptyBuilder,
    newGroup,
    type BuilderState,
    type FilterRule,
} from './builder-types';
import { generateSql } from './builder-sql';
import type { ErdRelationship } from '../erd/model';
import type { SqlStudioTable } from '../sqleditor/types';

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
    t('Orphan', ['x'], 'duckle_src."Orphan"'),
];

// Item â€”â€” ItemLocation, Item â€”â€” VendorItem â€”â€” Vendor. Orphan connects to nothing.
const RELS: ErdRelationship[] = [
    { id: 'a', fromTable: 'Item', fromColumn: 'Item', toTable: 'ItemLocation', toColumn: 'Item' },
    { id: 'b', fromTable: 'Item', fromColumn: 'Item', toTable: 'VendorItem', toColumn: 'Item' },
    {
        id: 'c',
        fromTable: 'Vendor',
        fromColumn: 'Vendor',
        toTable: 'VendorItem',
        toColumn: 'Vendor',
    },
];

const filter = (over: Partial<FilterRule> & { id: string; table: string }): FilterRule => ({
    kind: 'rule' as const,
    column: 'x',
    op: '=' as const,
    values: ['v'],
    ...over,
});

const pick = (state: BuilderState, table: string, column: string) =>
    toggleColumn(state, table, column, RELS);

describe('toggleColumn', () => {
    it('anchors on the first table picked', () => {
        const s = pick(emptyBuilder(), 'Item', 'Item');
        expect(s.anchor).toBe('Item');
        expect(s.joins).toEqual([]);
    });

    it('adds no join for a second column on the same table', () => {
        const s = pick(pick(emptyBuilder(), 'Item', 'Item'), 'Item', 'ItemGroup');
        expect(s.joins).toEqual([]);
        expect(s.columns).toHaveLength(2);
    });

    it('joins the ER model when a column comes from another table', () => {
        const s = pick(pick(emptyBuilder(), 'Item', 'Item'), 'ItemLocation', 'Location');
        expect(s.joins.map(j => j.relationshipId)).toEqual(['a']);
    });

    // Vendor is two hops from Item. The user picked one column; the builder
    // brings VendorItem along because the route needs it.
    it('brings intermediate tables along for a two-hop pick', () => {
        const s = pick(pick(emptyBuilder(), 'Item', 'Item'), 'Vendor', 'VendorName');
        expect(s.joins.map(j => j.relationshipId)).toEqual(['b', 'c']);
    });

    it('unticks, and drops the join that only that column needed', () => {
        const on = pick(pick(emptyBuilder(), 'Item', 'Item'), 'ItemLocation', 'Location');
        const off = pick(on, 'ItemLocation', 'Location');
        expect(off.joins).toEqual([]);
        expect(off.columns).toHaveLength(1);
    });

    // The intermediate is not the user's pick, so it must not vanish when
    // something else still routes through it.
    it('keeps an intermediate join that another table still needs', () => {
        let s = pick(emptyBuilder(), 'Item', 'Item');
        s = pick(s, 'Vendor', 'VendorName'); // pulls in VendorItem
        s = pick(s, 'VendorItem', 'VendorItem');
        s = pick(s, 'VendorItem', 'VendorItem'); // untick it again
        expect(s.joins.map(j => j.relationshipId)).toEqual(['b', 'c']);
    });

    it('moves the anchor when every column of the original anchor goes', () => {
        let s = pick(emptyBuilder(), 'Item', 'Item');
        s = pick(s, 'ItemLocation', 'Location');
        s = pick(s, 'Item', 'Item');
        expect(s.anchor).toBe('ItemLocation');
        expect(s.joins).toEqual([]);
    });

    it('drops a sort on a column that is unticked', () => {
        let s = pick(emptyBuilder(), 'Item', 'Item');
        s = cycleSort(s, 'Item', 'Item');
        s = pick(s, 'Item', 'Item');
        expect(s.sort).toEqual([]);
    });

    it('empties the anchor when the last column goes', () => {
        const s = pick(pick(emptyBuilder(), 'Item', 'Item'), 'Item', 'Item');
        expect(s.anchor).toBeUndefined();
    });
});

describe('toggleAllColumns', () => {
    const ITEM_COLS = ['Item', 'ItemGroup', 'Description'];

    // Individually, not as `Table.*`. A star cannot be reordered or aggregated,
    // so it has to be expanded the moment either is wanted â€” and expanding it
    // at the click keeps the star out of the generator entirely.
    it('adds every column of the table by name', () => {
        const s = toggleAllColumns(emptyBuilder(), 'Item', ITEM_COLS, RELS);
        expect(s.columns.map(c => c.column)).toEqual(ITEM_COLS);
    });

    it('fills in only what is missing, keeping what was already picked', () => {
        let s = pick(emptyBuilder(), 'Item', 'ItemGroup');
        s = toggleAllColumns(s, 'Item', ITEM_COLS, RELS);
        expect(s.columns).toHaveLength(3);
        // The one picked first keeps its position, so ordering is not reshuffled.
        expect(s.columns[0].column).toBe('ItemGroup');
    });

    it('clears the table when every column is already on', () => {
        const on = toggleAllColumns(emptyBuilder(), 'Item', ITEM_COLS, RELS);
        const off = toggleAllColumns(on, 'Item', ITEM_COLS, RELS);
        expect(off.columns).toEqual([]);
    });

    it('leaves other tables alone', () => {
        let s = pick(emptyBuilder(), 'ItemLocation', 'Location');
        s = toggleAllColumns(s, 'Item', ITEM_COLS, RELS);
        expect(s.columns.filter(c => c.table === 'ItemLocation')).toHaveLength(1);
    });
});

describe('join modes survive editing', () => {
    it('keeps a chosen mode when an unrelated column is added', () => {
        let s = pick(emptyBuilder(), 'Item', 'Item');
        s = pick(s, 'ItemLocation', 'Location');
        s = setJoinMode(s, 'a', 'keep-from');
        s = pick(s, 'Item', 'Description');
        expect(s.joins.find(j => j.relationshipId === 'a')?.mode).toBe('keep-from');
    });
});

describe('tables brought in without selecting from them', () => {
    // The Joins list's remaining job: filter on a table whose columns you do
    // not want in the output.
    it('keeps a join for a table added deliberately', () => {
        let s = pick(emptyBuilder(), 'Item', 'Item');
        s = addTable(s, 'ItemLocation', RELS);
        expect(s.joins.map(j => j.relationshipId)).toEqual(['a']);
        expect(s.columns).toHaveLength(1);
    });

    it('keeps the join once a filter names the table', () => {
        let s = pick(emptyBuilder(), 'Item', 'Item');
        s = { ...s, filters: newGroup('and', [filter({ id: 'f', table: 'ItemLocation', column: 'Location' })]) };
        s = rebuildJoins(s, RELS);
        expect(s.joins.map(j => j.relationshipId)).toEqual(['a']);
    });

    it('drops the join when the filter goes', () => {
        let s = pick(emptyBuilder(), 'Item', 'Item');
        s = { ...s, filters: newGroup('and', [filter({ id: 'f', table: 'ItemLocation', column: 'Location' })]) };
        s = rebuildJoins(s, RELS);
        s = removeFilterNode(s, 'f', RELS);
        expect(s.joins).toEqual([]);
    });

    it('removeTable takes its columns, filters and sorts with it', () => {
        let s = pick(emptyBuilder(), 'Item', 'Item');
        s = pick(s, 'ItemLocation', 'Location');
        s = { ...s, filters: newGroup('and', [filter({ id: 'f', table: 'ItemLocation', column: 'Location' })]) };
        s = removeTable(s, 'ItemLocation', RELS);
        expect(s.columns).toHaveLength(1);
        // The rule goes with the table, wherever in the tree it sat.
        expect(s.filters.children).toEqual([]);
        expect(s.joins).toEqual([]);
    });
});

describe('unreachable tables', () => {
    it('reports a table the ER model does not connect', () => {
        let s = pick(emptyBuilder(), 'Item', 'Item');
        s = pick(s, 'Orphan', 'x');
        expect(unreachableTables(s, RELS)).toEqual(['Orphan']);
    });

    it('emits no join for it rather than inventing one', () => {
        let s = pick(emptyBuilder(), 'Item', 'Item');
        s = pick(s, 'Orphan', 'x');
        expect(s.joins).toEqual([]);
    });

    it('canReach says so before the pick is made', () => {
        const s = pick(emptyBuilder(), 'Item', 'Item');
        expect(canReach(s, 'Vendor', RELS)).toBe(true);
        expect(canReach(s, 'Orphan', RELS)).toBe(false);
    });

    it('anything is reachable from an empty query', () => {
        expect(canReach(emptyBuilder(), 'Orphan', RELS)).toBe(true);
    });
});

describe('requiredTables', () => {
    it('counts columns, filters, sorts and deliberate additions', () => {
        let s = pick(emptyBuilder(), 'Item', 'Item');
        s = { ...s, filters: newGroup('and', [filter({ id: 'f', table: 'Vendor', column: 'VendorName' })]) };
        s = addTable(s, 'ItemLocation', RELS);
        expect(requiredTables(s).sort()).toEqual(['Item', 'ItemLocation', 'Vendor']);
    });
});

describe('cycleSort', () => {
    it('goes unsorted, asc, desc, unsorted', () => {
        let s = pick(emptyBuilder(), 'Item', 'Item');
        s = cycleSort(s, 'Item', 'Item');
        expect(s.sort[0].dir).toBe('asc');
        s = cycleSort(s, 'Item', 'Item');
        expect(s.sort[0].dir).toBe('desc');
        s = cycleSort(s, 'Item', 'Item');
        expect(s.sort).toEqual([]);
    });
});

// The point of the redesign: a query assembled by ticking cannot name a column
// that does not exist or reference a table before it is joined.
describe('end to end, ticking columns', () => {
    it('builds the Medline query from four ticks and a filter', () => {
        let s = pick(emptyBuilder(), 'Item', 'ItemGroup');
        s = pick(s, 'Item', 'Item');
        s = pick(s, 'ItemLocation', 'Location');
        s = pick(s, 'Vendor', 'VendorName');
        s = setAggregate(s, 'Item', 'Item', 'none');
        s = {
            ...s,
            filters: newGroup('and', [
                filter({ id: 'f', table: 'Vendor', column: 'VendorName', values: ['Medline'] }),
            ]),
        };
        s = rebuildJoins(s, RELS);

        const sql = generateSql(s, { tables: TABLES, relationships: RELS });
        expect(sql).toBe(
            [
                'SELECT Item.ItemGroup',
                '     , Item.Item',
                '     , ItemLocation.Location',
                '     , Vendor.VendorName',
                'FROM duckle_src."Item" AS Item',
                'JOIN duckle_src."ItemLocation" AS ItemLocation',
                '  ON Item.Item = ItemLocation.Item',
                'JOIN duckle_src."VendorItem" AS VendorItem',
                '  ON Item.Item = VendorItem.Item',
                'JOIN duckle_src."Vendor" AS Vendor',
                '  ON Vendor.Vendor = VendorItem.Vendor',
                "WHERE Vendor.VendorName = 'Medline'",
            ].join('\n'),
        );
    });

    it('counts items per group from two ticks and an aggregate', () => {
        let s = pick(emptyBuilder(), 'Item', 'ItemGroup');
        s = pick(s, 'Item', 'Item');
        s = setAggregate(s, 'Item', 'Item', 'count');
        const sql = generateSql(s, { tables: TABLES, relationships: RELS });
        // The aggregate names itself: a count headed `Item` reads as a value.
        expect(sql).toBe(
            [
                'SELECT Item.ItemGroup',
                '     , count(Item.Item) AS "count Item.Item"',
                'FROM duckle_src."Item" AS Item',
                'GROUP BY Item.ItemGroup',
            ].join('\n'),
        );
    });
});

