// Editing builder state.
//
// Every operation returns a state that is CONSISTENT — the joins always match
// the tables actually referenced, because they are recomputed rather than
// patched. Adding a column cannot leave a dangling join and removing one
// cannot leave an orphan, so there is no state the generator has to defend
// against and no repair step anywhere downstream.
//
// That is the same bargain as the rest of the redesign: make the wrong thing
// unconstructable instead of detectable.

import { parallelJoins, relationshipPath, type ErdRelationship } from '../erd/model';
import {
    addToGroup,
    filterTables,
    newTransform,
    removeNode,
    replaceNode,
} from './builder-types';
import type {
    Aggregate,
    CaseBranch,
    ColumnTransform,
    DateBucket,
    BuilderJoin,
    BuilderState,
    FilterGroup,
    FilterNode,
    JoinMode,
    SortColumn,
} from './builder-types';

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Tables the query must reach, in the order they were first needed.
 *
 * Columns, filters and sorts all count, and so does `extraTables` — a table
 * brought in deliberately from the Joins list to be filtered on before any
 * filter names it yet. Without that last one the join would be pruned the
 * instant it was added, which is the one thing the Joins list is still for.
 */
export function requiredTables(state: BuilderState): string[] {
    const out: string[] = [];
    const add = (t: string) => {
        if (!out.some(x => eq(x, t))) out.push(t);
    };
    // NOT the current anchor. The anchor is derived from this list, so counting
    // it as a requirement would make it self-sustaining: unticking the last
    // column of the FROM table would leave it in FROM, joined to nothing.
    for (const c of state.columns) add(c.table);
    for (const t of state.extraTables ?? []) add(t);
    for (const t of filterTables(state.filters)) add(t);
    for (const s of state.sort) add(s.table);
    // Transformations reach tables too, and a transformation is often the ONLY
    // reason a table is in the query — "count the order lines" needs
    // `PurchaseOrderLine` without ticking a single column of it. Left out, the
    // generator would emit `count(PurchaseOrderLine.…)` against a table absent
    // from FROM, which is a binder error rather than a wrong answer, but an
    // avoidable one.
    //
    // Switched-off transformations still count. Their table stays joined so
    // that toggling one back on does not silently restructure the FROM chain.
    for (const t of state.transforms ?? []) {
        if (t.table) add(t.table);
        // A case names its columns inside its branches, not on the record.
        for (const b of caseBranchesOf(t)) for (const tb of filterTables(b.when)) add(tb);
    }
    return out;
}

/** The branches of a `case`, or nothing. Args are loose, so this narrows once. */
export function caseBranchesOf(t: ColumnTransform): CaseBranch[] {
    const v = t.args.branches;
    return Array.isArray(v) && v.every(x => typeof x === 'object' && x && 'when' in x)
        ? (v as CaseBranch[])
        : [];
}

/**
 * Recompute the anchor and the join list from the tables actually needed.
 *
 * Rebuilt from scratch rather than added to and pruned. A patch has to answer
 * "is this join still carrying someone else's route" on every removal, and
 * getting that wrong strands a table or leaves a join to nothing; recomputing
 * cannot be subtly wrong, only wrong all at once, which tests catch.
 *
 * Join MODES survive the rebuild, keyed on the relationship — choosing an
 * outer join and then ticking an unrelated column should not quietly put it
 * back to inner.
 */
export function rebuildJoins(state: BuilderState, relationships: ErdRelationship[]): BuilderState {
    const required = requiredTables(state);
    if (required.length === 0) return { ...state, anchor: undefined, joins: [] };

    const modes = new Map(state.joins.map(j => [j.relationshipId, j.mode]));
    // The anchor is the first table still needed, so removing every column of
    // the original anchor moves FROM rather than leaving it joined to nothing.
    const anchor = required[0];
    const scope = new Set([anchor.toLowerCase()]);
    const joins: BuilderJoin[] = [];

    for (const table of required.slice(1)) {
        if (scope.has(table.toLowerCase())) continue;
        const hops = relationshipPath(table, scope, relationships, state.excludedJoins);
        // Unreachable: leave it out of the FROM chain rather than inventing a
        // join. `unreachableTables` reports it so the UI can say so.
        if (!hops) continue;
        for (const hop of hops) {
            joins.push({
                relationshipId: hop.rel.id,
                mode: modes.get(hop.rel.id) ?? 'inner',
            });
            // The other arms of a composite key come along. They are recorded
            // so the Joins list shows them as IN USE — the generator emits them
            // regardless, and a list offering to "add" a join already in the ON
            // clause is a list nobody can reason from.
            for (const also of parallelJoins(
                hop.joined,
                scope,
                relationships,
                state.excludedJoins,
            )) {
                if (also.id === hop.rel.id) continue;
                if (joins.some(j => j.relationshipId === also.id)) continue;
                // The mode belongs to the JOIN, not to each condition in it, so
                // the extra arms follow whatever the hop chose.
                joins.push({ relationshipId: also.id, mode: modes.get(hop.rel.id) ?? 'inner' });
            }
            scope.add(hop.joined.toLowerCase());
        }
    }
    return { ...state, anchor, joins };
}

/**
 * Why a table is in the query.
 *
 * Three things can pull a table in and only one of them is visible in the
 * column list, so a query can grow tables for reasons that are collapsed out of
 * sight — a filter on a table you never selected from is legitimate, and looks
 * exactly like a bug when you cannot see the filter.
 *
 * `route` is the interesting one: nobody asked for that table, it is on the
 * path between two that were asked for.
 */
export type TableReason = 'anchor' | 'column' | 'filter' | 'added' | 'route';

export function tableReason(state: BuilderState, table: string): TableReason {
    if (state.anchor && eq(state.anchor, table)) return 'anchor';
    if (state.columns.some(c => eq(c.table, table))) return 'column';
    if ((state.extraTables ?? []).some(t => eq(t, table))) return 'added';
    if (
        filterTables(state.filters).some(t => eq(t, table)) ||
        filterTables(state.having).some(t => eq(t, table))
    ) {
        return 'filter';
    }
    return 'route';
}

/** Tables the state needs but the ER model cannot connect. */
export function unreachableTables(
    state: BuilderState,
    relationships: ErdRelationship[],
): string[] {
    const scope = tablesInScope(state, relationships);
    if (scope.size === 0) return [];
    return requiredTables(state).filter(t => !scope.has(t.toLowerCase()));
}

/**
 * Rule a relationship out of routing, and re-route around it.
 *
 * The answer to a tie the model cannot settle (see `BuilderState.excludedJoins`).
 * Removing the join the router happened to pick sends it down the other route,
 * which is the whole point: `Item → item_norm.parquet → Vendor` becomes
 * `Item → VendorItem → Vendor`, and the row count stops being inflated by the
 * extract's duplicate pairs.
 */
export function excludeJoin(
    state: BuilderState,
    relationshipId: string,
    relationships: ErdRelationship[],
): BuilderState {
    const excluded = state.excludedJoins ?? [];
    if (excluded.includes(relationshipId)) return state;
    return rebuildJoins(
        { ...state, excludedJoins: [...excluded, relationshipId] },
        relationships,
    );
}

/** Put a ruled-out relationship back in play. */
export function restoreJoin(
    state: BuilderState,
    relationshipId: string,
    relationships: ErdRelationship[],
): BuilderState {
    const excluded = (state.excludedJoins ?? []).filter(id => id !== relationshipId);
    return rebuildJoins(
        { ...state, excludedJoins: excluded.length > 0 ? excluded : undefined },
        relationships,
    );
}

/**
 * Would removing this join leave the query able to reach everything it needs?
 *
 * Asked by simulating it rather than reasoning about it. Whether another route
 * exists is exactly the question `rebuildJoins` answers, so excluding and
 * counting what became unreachable cannot disagree with what excluding would
 * actually do — which a separate "is there an alternative path" check could.
 *
 * False means the join is load-bearing: it is the only way in, and offering to
 * delete it would be offering to break the query.
 */
export function canExcludeJoin(
    state: BuilderState,
    relationshipId: string,
    relationships: ErdRelationship[],
): boolean {
    if ((state.excludedJoins ?? []).includes(relationshipId)) return false;
    const before = unreachableTables(state, relationships).length;
    const after = unreachableTables(
        { ...state, excludedJoins: [...(state.excludedJoins ?? []), relationshipId] },
        relationships,
    ).length;
    return after <= before;
}

/** Can this table be added to the query at all? */
export function canReach(
    state: BuilderState,
    table: string,
    relationships: ErdRelationship[],
): boolean {
    const scope = tablesInScope(state, relationships);
    // An empty query can start anywhere — the first pick chooses the anchor.
    // Exclusions count here too: a table only reachable through a route the
    // person ruled out is not reachable, and offering it would produce a
    // column that silently fails to join.
    return (
        scope.size === 0 ||
        relationshipPath(table, scope, relationships, state.excludedJoins) !== null
    );
}

/** The tables the FROM chain actually reaches, lowercased. */
export function tablesInScope(
    state: BuilderState,
    relationships: ErdRelationship[],
): Set<string> {
    const rebuilt = rebuildJoins(state, relationships);
    const scope = new Set<string>();
    if (!rebuilt.anchor) return scope;
    scope.add(rebuilt.anchor.toLowerCase());
    for (const j of rebuilt.joins) {
        const rel = relationships.find(r => r.id === j.relationshipId);
        if (!rel) continue;
        scope.add(rel.fromTable.toLowerCase());
        scope.add(rel.toTable.toLowerCase());
    }
    return scope;
}

export function hasColumn(state: BuilderState, table: string, column: string): boolean {
    return state.columns.some(c => eq(c.table, table) && eq(c.column, column));
}

/**
 * Tick or untick one column.
 *
 * Ticking the first one sets the anchor; ticking one on a table not yet in the
 * query brings it in through the ER model, intermediates and all. Unticking
 * the last column of a table drops the join unless something else routes
 * through it — all of which is `rebuildJoins`, not special cases here.
 */
export function toggleColumn(
    state: BuilderState,
    table: string,
    column: string,
    relationships: ErdRelationship[],
): BuilderState {
    const has = hasColumn(state, table, column);
    const columns = has
        ? state.columns.filter(c => !(eq(c.table, table) && eq(c.column, column)))
        : [...state.columns, { table, column }];
    // Sorts on a column that is gone go with it: ORDER BY on something not
    // selected is legal SQL but is not what unticking meant.
    const sort = has
        ? state.sort.filter(s => !(eq(s.table, table) && eq(s.column, column)))
        : state.sort;
    return rebuildJoins({ ...state, columns, sort }, relationships);
}

/**
 * The table-level checkbox: tick every column, or clear them all.
 *
 * It adds the columns INDIVIDUALLY rather than emitting `Table.*`. A star is a
 * shortcut for typing, not a thing worth keeping: it cannot be reordered, it
 * cannot carry an aggregate, and it has to be expanded the moment either is
 * wanted — so the expansion may as well happen at the click. Doing it here also
 * removes the star as a special case from the generator, the collision check
 * and the GROUP BY rule.
 */
export function toggleAllColumns(
    state: BuilderState,
    table: string,
    allColumns: string[],
    relationships: ErdRelationship[],
): BuilderState {
    const every = allColumns.length > 0 && allColumns.every(c => hasColumn(state, table, c));
    const columns = every
        ? state.columns.filter(c => !eq(c.table, table))
        : [
              ...state.columns,
              ...allColumns
                  .filter(c => !hasColumn(state, table, c))
                  .map(column => ({ table, column })),
          ];
    const sort = every ? state.sort.filter(s => !eq(s.table, table)) : state.sort;
    return rebuildJoins({ ...state, columns, sort }, relationships);
}

/**
 * Move a selected column to a new position in the SELECT list.
 *
 * Column ORDER is builder state, not a property of the SQL text — the order of
 * `state.columns` is the order of the output. Reordering therefore belongs
 * here, in the picker, rather than being a reason to switch the builder off:
 * "I want these columns in a different order" is not a SQL-authoring problem,
 * and having to hand the query over to solve it would make the toggle a
 * workaround instead of a choice.
 */
export function moveColumn(state: BuilderState, from: number, to: number): BuilderState {
    if (from === to || from < 0 || from >= state.columns.length) return state;
    const columns = [...state.columns];
    const [moved] = columns.splice(from, 1);
    columns.splice(Math.max(0, Math.min(to, columns.length)), 0, moved);
    return { ...state, columns };
}

export function setAggregate(
    state: BuilderState,
    table: string,
    column: string,
    aggregate: Aggregate,
): BuilderState {
    return {
        ...state,
        columns: state.columns.map(c =>
            eq(c.table, table) && eq(c.column, column) ? { ...c, aggregate } : c,
        ),
    };
}

/**
 * Name one selected column's output.
 *
 * An alias is NOT a transformation, which is why it is edited where columns are
 * chosen rather than in Column Transformations. Nothing is computed: the same
 * value comes back under a different heading. A transformation makes a column
 * that did not exist; this renames one that does.
 *
 * An alias equal to the column's own name is CLEARED rather than stored. It
 * would emit `Item AS Item` — legal, and noise in output that is meant to be
 * read — and it would make the Column Ordering list show a name the person
 * never really chose.
 */
export function setColumnAlias(
    state: BuilderState,
    table: string,
    column: string,
    alias: string,
): BuilderState {
    const trimmed = alias.trim();
    const next = trimmed === '' || trimmed === column ? undefined : trimmed;
    return {
        ...state,
        columns: state.columns.map(c =>
            eq(c.table, table) && eq(c.column, column) ? { ...c, alias: next } : c,
        ),
    };
}

/**
 * Round a temporal column to a day/week/month/quarter/year.
 *
 * Independent of `setAggregate` on purpose: bucketing a date and counting it
 * are different questions, and a control that shared a slot would make
 * "months, counted" unsayable.
 */
export function setBucket(
    state: BuilderState,
    table: string,
    column: string,
    bucket: DateBucket,
): BuilderState {
    return {
        ...state,
        columns: state.columns.map(c =>
            eq(c.table, table) && eq(c.column, column) ? { ...c, bucket } : c,
        ),
    };
}

/**
 * Bring a saved query up to date: legacy aggregates and buckets become
 * transformations.
 *
 * Aggregation used to live on `SelectedColumn.aggregate`, and date bucketing on
 * `.bucket`, both edited from dropdowns in the catalog tree. Those dropdowns are
 * gone — the tree answers WHICH COLUMNS and nothing else now — so a query saved
 * under the old shape would open with an aggregation nobody could change or see
 * a reason for.
 *
 * Run on LOAD, at every point state enters the builder. `query-io` casts stored
 * JSON straight back to `BuilderState` with no validation of its own, so this is
 * the only place the old shape can be caught.
 *
 * The fields are CLEARED as they are converted. Leaving them would mean a column
 * that is both summarised and a grouping key, and the generator reads both — the
 * result would be `sum(x)` in SELECT and `x` in GROUP BY at the same time.
 *
 * Idempotent: state with nothing legacy in it comes back untouched, so calling
 * it twice, or on a new query, costs nothing.
 */
export function normalizeBuilder(state: BuilderState): BuilderState {
    const legacy = state.columns.filter(
        c => (c.aggregate ?? 'none') !== 'none' || (c.bucket ?? 'none') !== 'none',
    );
    if (legacy.length === 0) return state;

    const migrated: ColumnTransform[] = [];
    for (const c of legacy) {
        const agg = c.aggregate ?? 'none';
        const bucket = c.bucket ?? 'none';
        // A column that was BOTH bucketed and aggregated becomes two rows, not
        // one: chaining is out of scope, so `count(date_trunc(…))` cannot be
        // expressed, and the two halves are independently useful. Rare enough
        // that splitting is better than dropping either.
        if (bucket !== 'none') {
            migrated.push({
                ...newTransform('function', 'date_trunc'),
                table: c.table,
                column: c.column,
                args: { unit: bucket },
                alias: `${bucket} ${c.table}.${c.column}`,
            });
        }
        if (agg !== 'none') {
            migrated.push({
                ...newTransform('aggregate', agg),
                table: c.table,
                column: c.column,
                // The alias it was already generating, so a saved query's
                // column headings do not change under somebody.
                alias: c.alias ?? `${agg} ${c.table}.${c.column}`,
            });
        }
    }

    return {
        ...state,
        // The summarised column stops being a SELECTED column: it is now a
        // transformation reading the same source. Left in, it would also become
        // a grouping key and quietly change every number in the result.
        columns: state.columns.filter(
            c => (c.aggregate ?? 'none') === 'none' && (c.bucket ?? 'none') === 'none',
        ),
        transforms: [...(state.transforms ?? []), ...migrated],
    };
}

/**
 * Add, replace or drop one computed column.
 *
 * `rebuildJoins` runs on every one of these, because a transformation can be
 * the ONLY reason a table is in the query — adding "sum of Line.Quantity" to a
 * query about purchase orders has to bring `PurchaseOrderLine` in through the
 * ER model, and removing it has to let the table go again. Exactly what
 * ticking a column does, for the same reason.
 */
export function upsertTransform(
    state: BuilderState,
    transform: ColumnTransform,
    relationships: ErdRelationship[],
): BuilderState {
    const existing = state.transforms ?? [];
    const has = existing.some(t => t.id === transform.id);
    return rebuildJoins(
        {
            ...state,
            transforms: has
                ? existing.map(t => (t.id === transform.id ? transform : t))
                : [...existing, transform],
        },
        relationships,
    );
}

export function removeTransform(
    state: BuilderState,
    id: string,
    relationships: ErdRelationship[],
): BuilderState {
    return rebuildJoins(
        { ...state, transforms: (state.transforms ?? []).filter(t => t.id !== id) },
        relationships,
    );
}

/**
 * Switch one on or off without deleting it.
 *
 * No rebuild: `requiredTables` deliberately counts switched-off
 * transformations, so that toggling one back on cannot silently restructure
 * the FROM chain underneath somebody.
 */
export function setTransformEnabled(
    state: BuilderState,
    id: string,
    enabled: boolean,
): BuilderState {
    return {
        ...state,
        transforms: (state.transforms ?? []).map(t => (t.id === id ? { ...t, enabled } : t)),
    };
}

/** Bring a table in without selecting from it — the Joins list's remaining job. */
export function addTable(
    state: BuilderState,
    table: string,
    relationships: ErdRelationship[],
): BuilderState {
    const extra = state.extraTables ?? [];
    if (extra.some(t => eq(t, table))) return state;
    return rebuildJoins({ ...state, extraTables: [...extra, table] }, relationships);
}

/** Every rule naming this table, removed wherever it sits in the tree. */
function dropRulesFor(group: FilterGroup, table: string): FilterGroup {
    return {
        ...group,
        children: group.children
            .filter(c => !(c.kind === 'rule' && eq(c.table, table)))
            .map(c => (c.kind === 'group' ? dropRulesFor(c, table) : c)),
    };
}

export function removeTable(
    state: BuilderState,
    table: string,
    relationships: ErdRelationship[],
): BuilderState {
    return rebuildJoins(
        {
            ...state,
            columns: state.columns.filter(c => !eq(c.table, table)),
            filters: dropRulesFor(state.filters, table),
            sort: state.sort.filter(s => !eq(s.table, table)),
            extraTables: (state.extraTables ?? []).filter(t => !eq(t, table)),
        },
        relationships,
    );
}

export function setJoinMode(
    state: BuilderState,
    relationshipId: string,
    mode: JoinMode,
): BuilderState {
    return {
        ...state,
        joins: state.joins.map(j => (j.relationshipId === relationshipId ? { ...j, mode } : j)),
    };
}

/** Replace one rule or group, wherever it sits in the tree. */
export function updateFilterNode(
    state: BuilderState,
    node: FilterNode,
    relationships: ErdRelationship[],
): BuilderState {
    const filters =
        node.kind === 'group' && node.id === state.filters.id
            ? node
            : replaceNode(state.filters, node);
    // Rebuild: changing a rule's column can bring a new table into the query,
    // or leave the last user of an old one.
    return rebuildJoins({ ...state, filters }, relationships);
}

/** Add a rule or a nested group to the group with this id. */
export function addFilterNode(
    state: BuilderState,
    groupId: string,
    child: FilterNode,
    relationships: ErdRelationship[],
): BuilderState {
    return rebuildJoins(
        { ...state, filters: addToGroup(state.filters, groupId, child) },
        relationships,
    );
}

/**
 * The HAVING tree gets its own three operations rather than a `which` flag.
 *
 * WHERE and HAVING are edited by the same component but they are different
 * clauses, and a shared mutator taking "which tree" is one argument away from
 * writing a row filter into the group filter — a mistake that produces a query
 * that runs and answers a different question.
 */
export function updateHavingNode(state: BuilderState, node: FilterNode): BuilderState {
    const having =
        node.kind === 'group' && node.id === state.having.id
            ? node
            : replaceNode(state.having, node);
    // No `rebuildJoins`: HAVING can only name columns already selected, so it
    // never brings a table in or lets one go.
    return { ...state, having };
}

export function addHavingNode(
    state: BuilderState,
    groupId: string,
    child: FilterNode,
): BuilderState {
    return { ...state, having: addToGroup(state.having, groupId, child) };
}

export function removeHavingNode(state: BuilderState, id: string): BuilderState {
    return { ...state, having: removeNode(state.having, id) };
}

export function removeFilterNode(
    state: BuilderState,
    id: string,
    relationships: ErdRelationship[],
): BuilderState {
    return rebuildJoins({ ...state, filters: removeNode(state.filters, id) }, relationships);
}

/** Cycle a column through unsorted → asc → desc → unsorted. */
export function cycleSort(state: BuilderState, table: string, column: string): BuilderState {
    const at = state.sort.findIndex(s => eq(s.table, table) && eq(s.column, column));
    if (at < 0) return { ...state, sort: [...state.sort, { table, column, dir: 'asc' }] };
    const current = state.sort[at];
    if (current.dir === 'asc') {
        const sort = [...state.sort];
        sort[at] = { ...current, dir: 'desc' } as SortColumn;
        return { ...state, sort };
    }
    return { ...state, sort: state.sort.filter((_, i) => i !== at) };
}
