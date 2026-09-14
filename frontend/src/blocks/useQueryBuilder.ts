// Everything the query builder needs, in one place both hosts can mount.
//
// Follows the seam `ErdEditor` cut for the ER model: two surfaces, differing in
// exactly the parameters they are given. The builder's whole view of the world
// is already `SqlStudioTable[]` + `ErdRelationship[]` — nothing in `builder-*`
// imports the workspace catalog — so it was portable before this hook existed;
// it was simply inlined in `BlocksStudio` and therefore reachable from one
// surface only.
//
// NOT an `ErdPersistence`-style adapter, deliberately. That editor owns a
// savable document and has its own Save button. A query builder does not: the
// thing it produces is a QUERY, and the host decides where that goes — a saved
// query in Blocks, a node property in SQL Studio. Giving this a save of its own
// would invent a moment that does not exist, and put two owners on one
// document, which is exactly how the two surfaces drifted apart before.
//
// So the state lives here and the host reads it. `sql` is an output, never
// pushed into an editor by an effect: derived state that also writes is the
// shape that goes subtly wrong the moment the two disagree.

import { useCallback, useMemo, useState } from 'react';
import type { ErdRelationship } from '../erd/model';
import type { SqlStudioTable } from '../sqleditor/types';
import type { CatalogSelection } from '../sqleditor/TableCatalog';
import { generateSql } from './builder-sql';
import {
    addTable,
    addFilterNode,
    addHavingNode,
    canExcludeJoin,
    canReach,
    excludeJoin,
    moveColumn,
    removeFilterNode,
    removeHavingNode,
    restoreJoin,
    setAggregate,
    setJoinMode,
    tablesInScope,
    toggleAllColumns,
    toggleColumn,
    unreachableTables,
    updateFilterNode,
    updateHavingNode,
} from './builder-ops';
import {
    aggregatesFor,
    emptyBuilder,
    type Aggregate,
    type BuilderState,
    type FilterNode,
    type JoinMode,
    type SelectedColumn,
} from './builder-types';
import type { ColumnOption } from './ColumnPicker';

export interface QueryBuilderInput {
    /** What the query may read. The host discovers these. */
    tables: SqlStudioTable[];
    relationships: ErdRelationship[];
    /** Written into the generated SQL as a `-- name:` header. */
    title?: string;
    description?: string;
}

export interface QueryBuilder {
    state: BuilderState;
    setState: React.Dispatch<React.SetStateAction<BuilderState>>;
    /** Throw the query away and start from nothing. */
    reset: () => void;

    /** The SQL the current state produces. An output; nothing writes it back. */
    sql: string;
    /** Tables the query needs but the ER model cannot connect. */
    stranded: string[];

    // What the panel renders from.
    filterOptions: ColumnOption[];
    havingOptions: ColumnOption[];
    activeJoins: Map<string, JoinMode>;
    excludedJoinIds: Set<string>;
    selectionFor: (table: SqlStudioTable) => CatalogSelection;

    // Every edit, named for what it does rather than for the module it lives in.
    addJoinTable: (rel: ErdRelationship) => void;
    setJoinMode: (relationshipId: string, mode: JoinMode) => void;
    excludeJoin: (relationshipId: string) => void;
    restoreJoin: (relationshipId: string) => void;
    canExcludeJoin: (relationshipId: string) => boolean;
    moveColumn: (from: number, to: number) => void;
    removeColumn: (c: SelectedColumn) => void;
    updateFilter: (node: FilterNode) => void;
    addFilter: (groupId: string, child: FilterNode) => void;
    removeFilter: (id: string) => void;
    updateHaving: (node: FilterNode) => void;
    addHaving: (groupId: string, child: FilterNode) => void;
    removeHaving: (id: string) => void;

    /** Does the query summarise? Decides whether HAVING or a box plot mean anything. */
    aggregated: boolean;
}

export function useQueryBuilder({
    tables,
    relationships,
    title,
    description,
}: QueryBuilderInput): QueryBuilder {
    const [state, setState] = useState<BuilderState>(() => emptyBuilder());

    const sql = useMemo(
        () => generateSql(state, { tables, relationships, title, description }),
        [state, tables, relationships, title, description],
    );

    const stranded = useMemo(
        () => unreachableTables(state, relationships),
        [state, relationships],
    );

    /**
     * What the grouping filter may compare: the SUMMARISED columns.
     *
     * `count(Item.Item)`, not `Item.Item` — once the rows are grouped the raw
     * column has no single value, and offering it left no way to ask for "more
     * than five" because the operators on a text column are the text ones.
     */
    const havingOptions = useMemo(
        (): ColumnOption[] =>
            state.columns
                .filter(c => (c.aggregate ?? 'none') !== 'none')
                .map(c => ({ table: c.table, column: c.column, aggregate: c.aggregate })),
        [state.columns],
    );

    const filterOptions = useMemo(
        (): ColumnOption[] =>
            tables
                // A filter on a table the model cannot connect is a query that
                // cannot run.
                .filter(t => canReach(state, t.name, relationships))
                .flatMap(t => t.columns.map(c => ({ table: t.name, column: c.name }))),
        [tables, state, relationships],
    );

    const activeJoins = useMemo(
        () => new Map(state.joins.map(j => [j.relationshipId, j.mode])),
        [state.joins],
    );

    const excludedJoinIds = useMemo(
        () => new Set(state.excludedJoins ?? []),
        [state.excludedJoins],
    );

    const aggregated = useMemo(
        () => state.columns.some(c => (c.aggregate ?? 'none') !== 'none'),
        [state.columns],
    );

    /** Turn the catalog into a column picker. */
    const selectionFor = useCallback(
        (table: SqlStudioTable): CatalogSelection => ({
            isSelected: column =>
                state.columns.some(
                    c =>
                        c.table.toLowerCase() === table.name.toLowerCase() &&
                        c.column.toLowerCase() === column.toLowerCase(),
                ),
            onToggle: column =>
                setState(b => toggleColumn(b, table.name, column, relationships)),
            onToggleAll: () =>
                setState(b =>
                    toggleAllColumns(
                        b,
                        table.name,
                        table.columns.map(c => c.name),
                        relationships,
                    ),
                ),
            aggregateOf: column =>
                state.columns.find(
                    c =>
                        c.table.toLowerCase() === table.name.toLowerCase() &&
                        c.column.toLowerCase() === column.toLowerCase(),
                )?.aggregate ?? 'none',
            onAggregate: (column, aggregate) =>
                setState(b => setAggregate(b, table.name, column, aggregate as Aggregate)),
            aggregatesFor: column =>
                aggregatesFor(table.columns.find(c => c.name === column)?.type),
            reachable: canReach(state, table.name, relationships),
        }),
        [state, relationships],
    );

    /** Bring a relationship's tables in without selecting from them. */
    const addJoinTable = useCallback(
        (rel: ErdRelationship) => {
            setState(b => {
                const scope = tablesInScope(b, relationships);
                // Whichever end is not there yet; with an empty query the
                // `from` side becomes the anchor.
                const target = scope.has(rel.fromTable.toLowerCase()) ? rel.toTable : rel.fromTable;
                return addTable(b, target, relationships);
            });
        },
        [relationships],
    );

    return {
        state,
        setState,
        reset: useCallback(() => setState(emptyBuilder()), []),
        sql,
        stranded,
        filterOptions,
        havingOptions,
        activeJoins,
        excludedJoinIds,
        aggregated,
        selectionFor,
        addJoinTable,
        setJoinMode: useCallback(
            (id: string, mode: JoinMode) => setState(b => setJoinMode(b, id, mode)),
            [],
        ),
        excludeJoin: useCallback(
            (id: string) => setState(b => excludeJoin(b, id, relationships)),
            [relationships],
        ),
        restoreJoin: useCallback(
            (id: string) => setState(b => restoreJoin(b, id, relationships)),
            [relationships],
        ),
        // Reads current state rather than setting it, so it stays a question
        // the panel can ask while deciding whether to offer the bin at all.
        canExcludeJoin: useCallback(
            (id: string) => canExcludeJoin(state, id, relationships),
            [state, relationships],
        ),
        moveColumn: useCallback((from: number, to: number) => setState(b => moveColumn(b, from, to)), []),
        removeColumn: useCallback(
            (c: SelectedColumn) =>
                setState(b => toggleColumn(b, c.table, c.column, relationships)),
            [relationships],
        ),
        updateFilter: useCallback(
            (node: FilterNode) => setState(b => updateFilterNode(b, node, relationships)),
            [relationships],
        ),
        addFilter: useCallback(
            (groupId: string, child: FilterNode) =>
                setState(b => addFilterNode(b, groupId, child, relationships)),
            [relationships],
        ),
        removeFilter: useCallback(
            (id: string) => setState(b => removeFilterNode(b, id, relationships)),
            [relationships],
        ),
        updateHaving: useCallback((node: FilterNode) => setState(b => updateHavingNode(b, node)), []),
        addHaving: useCallback(
            (groupId: string, child: FilterNode) => setState(b => addHavingNode(b, groupId, child)),
            [],
        ),
        removeHaving: useCallback((id: string) => setState(b => removeHavingNode(b, id)), []),
    };
}
