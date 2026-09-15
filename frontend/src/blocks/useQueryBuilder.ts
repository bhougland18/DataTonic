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
    cycleSort,
    excludeJoin,
    moveColumn,
    removeFilterNode,
    removeHavingNode,
    restoreJoin,
    removeTransform,
    setTransformEnabled,
    upsertTransform,
    setJoinMode,
    tablesInScope,
    toggleAllColumns,
    toggleColumn,
    unreachableTables,
    updateFilterNode,
    updateHavingNode,
} from './builder-ops';
import {
    emptyBuilder,
    type ColumnTransform,
    type BuilderState,
    type FilterNode,
    type JoinMode,
    type SelectedColumn,
    type SortColumn,
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
    upsertTransform: (transform: ColumnTransform) => void;
    removeTransform: (id: string) => void;
    setTransformEnabled: (id: string, enabled: boolean) => void;
    addJoinTable: (rel: ErdRelationship) => void;
    setJoinMode: (relationshipId: string, mode: JoinMode) => void;
    excludeJoin: (relationshipId: string) => void;
    restoreJoin: (relationshipId: string) => void;
    canExcludeJoin: (relationshipId: string) => boolean;
    moveColumn: (from: number, to: number) => void;
    removeColumn: (c: SelectedColumn) => void;
    /** Cycle one column unsorted → ascending → descending → unsorted. */
    cycleSort: (table: string, column: string) => void;
    /** Which way a column is sorted, or undefined when it is not. */
    sortDirOf: (table: string, column: string) => 'asc' | 'desc' | undefined;
    /** Reorder the sort keys. ORDER BY is positional — the first key wins. */
    moveSort: (from: number, to: number) => void;
    /** Append a key. The caller picks a sensible column to start from. */
    addSort: (table: string, column: string) => void;
    removeSortAt: (index: number) => void;
    /** Change one key's column or direction in place, keeping its priority. */
    setSortAt: (index: number, patch: Partial<SortColumn>) => void;
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
        // Computed columns. Every edit goes through `upsertTransform` rather
        // than patching `state.transforms` here, because adding one can pull a
        // whole table into the query and that is `rebuildJoins`' job.
        upsertTransform: useCallback(
            (t: ColumnTransform) => setState(b => upsertTransform(b, t, relationships)),
            [relationships],
        ),
        removeTransform: useCallback(
            (id: string) => setState(b => removeTransform(b, id, relationships)),
            [relationships],
        ),
        setTransformEnabled: useCallback(
            (id: string, enabled: boolean) => setState(b => setTransformEnabled(b, id, enabled)),
            [],
        ),
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
        cycleSort: useCallback(
            (table: string, column: string) => setState(b => cycleSort(b, table, column)),
            [],
        ),
        sortDirOf: useCallback(
            (table: string, column: string) =>
                state.sort.find(
                    s =>
                        s.table.toLowerCase() === table.toLowerCase() &&
                        s.column.toLowerCase() === column.toLowerCase(),
                )?.dir,
            [state.sort],
        ),
        // ORDER BY is POSITIONAL — the first key decides, later ones only break
        // its ties — so the order of this list is a real choice, not a display
        // detail, and has to be reorderable.
        moveSort: useCallback(
            (from: number, to: number) =>
                setState(b => {
                    const sort = [...b.sort];
                    const [moved] = sort.splice(from, 1);
                    if (!moved) return b;
                    sort.splice(to, 0, moved);
                    return { ...b, sort };
                }),
            [],
        ),
        addSort: useCallback(
            (table: string, column: string) =>
                setState(b =>
                    // Never twice: a column already in ORDER BY sorts no harder
                    // for being named again, and the duplicate row would be a
                    // control that does nothing.
                    b.sort.some(
                        s =>
                            s.table.toLowerCase() === table.toLowerCase() &&
                            s.column.toLowerCase() === column.toLowerCase(),
                    )
                        ? b
                        : { ...b, sort: [...b.sort, { table, column, dir: 'asc' }] },
                ),
            [],
        ),
        removeSortAt: useCallback(
            (index: number) =>
                setState(b => ({ ...b, sort: b.sort.filter((_, i) => i !== index) })),
            [],
        ),
        setSortAt: useCallback(
            (index: number, patch: Partial<SortColumn>) =>
                setState(b => ({
                    ...b,
                    sort: b.sort.map((s, i) => (i === index ? { ...s, ...patch } : s)),
                })),
            [],
        ),
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
