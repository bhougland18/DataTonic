// The WHERE clause: a tree of rules and groups, AND or OR per group.
//
// A flat AND list could not express "Medline items that are either
// discontinued or out of stock" — one AND, one OR — and splitting that into two
// queries is not an answer. The Infor source node's filter builder already
// settled this shape (`playground/providers/infor/FilterBuilder.tsx`); this is
// the same tree over columns rather than Infor fields.
//
// Stacked two lines per rule rather than three controls across: column,
// operator and value side by side give each about ninety, which cannot show
// `VendorItemDescription`. Height is the cheaper thing to spend — the section
// collapses when you are done with it. (The panel was 260px when this was
// decided and is `--builder-panel-w` now; widening it did not change the
// answer, and would need to roughly double to.)

import { useCallback } from 'react';
import { FolderPlus, Plus, Trash2 } from 'lucide-react';
import ColumnPicker, { type ColumnOption } from './ColumnPicker';
import ValuePicker from './ValuePicker';
import type { ValueOption } from './distinct-values';
import {
    arity,
    filterIsComplete,
    isNumericAggregate,
    newGroup,
    newRule,
    operatorsFor,
    type FilterGroup,
    type FilterNode,
    type FilterOperator,
    type FilterRule,
} from './builder-types';

export interface FiltersPanelProps {
    root: FilterGroup;
    /**
     * What a rule can compare, already decided by the caller.
     *
     * The panel used to take tables and flatten them, which is right for WHERE
     * and wrong for HAVING: a group filter compares `count(Item.Item)`, and no
     * list of table columns can say that. The caller knows which clause this is,
     * so it builds the options.
     */
    options: ColumnOption[];
    /** Which column a newly added rule starts on. Defaults to the first. */
    seed?: ColumnOption;
    onUpdate: (node: FilterNode) => void;
    onAdd: (groupId: string, child: FilterNode) => void;
    onRemove: (id: string) => void;
    /**
     * The values actually in a column, for the value box's dropdown.
     *
     * Absent for the GROUPING filter: its left-hand side is `count(...)`, and
     * the distinct values of a count are not something to look up — they are
     * whatever the grouping happens to produce.
     */
    fetchValues?: (table: string, column: string) => Promise<ValueOption[]>;
}

export default function FiltersPanel({
    root,
    options,
    seed,
    onUpdate,
    onAdd,
    onRemove,
    fetchValues,
}: FiltersPanelProps) {
    return (
        <div className="blk-filters">
            <GroupEditor
                group={root}
                options={options}
                seed={seed}
                depth={0}
                onUpdate={onUpdate}
                onAdd={onAdd}
                onRemove={onRemove}
                fetchValues={fetchValues}
            />
        </div>
    );
}

function GroupEditor({
    group,
    options,
    seed,
    depth,
    onUpdate,
    onAdd,
    onRemove,
    fetchValues,
}: {
    group: FilterGroup;
    options: ColumnOption[];
    seed?: ColumnOption;
    depth: number;
    onUpdate: (node: FilterNode) => void;
    onAdd: (groupId: string, child: FilterNode) => void;
    onRemove: (id: string) => void;
    fetchValues?: (table: string, column: string) => Promise<ValueOption[]>;
}) {
    // What a NEW rule starts on. The first option is only a fallback: a CASE
    // branch should start on the column the case is about, and defaulting to
    // whatever happens to be first in the catalog is how somebody builds three
    // conditions on the wrong column without noticing. Seen in the wild.
    const start = seed ?? options[0];
    const first = options[0];
    return (
        <div className={`blk-fgroup${depth > 0 ? ' blk-fgroup--nested' : ''}`}>
            <div className="blk-fgroup-head">
                {/* The conjunction is only a real choice with two children —
                    shown regardless so the group's behaviour is never a
                    surprise once a second condition arrives. */}
                <div className="blk-conj" role="group" aria-label="Combine with">
                    <button
                        type="button"
                        className={group.conj === 'and' ? 'on' : undefined}
                        onClick={() => onUpdate({ ...group, conj: 'and' })}
                    >
                        AND
                    </button>
                    <button
                        type="button"
                        className={group.conj === 'or' ? 'on' : undefined}
                        onClick={() => onUpdate({ ...group, conj: 'or' })}
                    >
                        OR
                    </button>
                </div>
                <span className="blk-join-gap" />
                <button
                    type="button"
                    className="blk-lib-icon"
                    onClick={() =>
                        onAdd(
                            group.id,
                            newRule(start?.table ?? '', start?.column ?? '', start?.aggregate),
                        )
                    }
                    disabled={!first}
                    title={first ? 'Add a condition' : 'Pick some columns first'}
                >
                    <Plus size={13} />
                </button>
                <button
                    type="button"
                    className="blk-lib-icon"
                    onClick={() => onAdd(group.id, newGroup('or'))}
                    title="Add a nested group"
                >
                    <FolderPlus size={13} />
                </button>
                {depth > 0 ? (
                    <button
                        type="button"
                        className="blk-lib-icon"
                        onClick={() => onRemove(group.id)}
                        title="Remove this group"
                    >
                        <Trash2 size={12} />
                    </button>
                ) : null}
            </div>

            {group.children.length === 0 ? (
                <p className="blk-lib-hint">
                    {depth === 0 ? 'No filters. Add a condition to narrow the rows.' : 'Empty group.'}
                </p>
            ) : null}

            {group.children.map(child =>
                child.kind === 'rule' ? (
                    <RuleEditor
                        key={child.id}
                        rule={child}
                        options={options}
                        onUpdate={onUpdate}
                        onRemove={onRemove}
                        fetchValues={fetchValues}
                    />
                ) : (
                    <GroupEditor
                        key={child.id}
                        group={child}
                        options={options}
                        seed={seed}
                        depth={depth + 1}
                        onUpdate={onUpdate}
                        onAdd={onAdd}
                        onRemove={onRemove}
                        fetchValues={fetchValues}
                    />
                ),
            )}
        </div>
    );
}

function RuleEditor({
    rule,
    options,
    onUpdate,
    onRemove,
    fetchValues,
}: {
    rule: FilterRule;
    options: ColumnOption[];
    onUpdate: (node: FilterNode) => void;
    onRemove: (id: string) => void;
    fetchValues?: (table: string, column: string) => Promise<ValueOption[]>;
}) {
    const n = arity(rule.op);
    // A rule that is started but not finished is dropped from the SQL. Marked,
    // so it is not a silent no-op somebody hunts for later.
    const incomplete = !filterIsComplete(rule);
    const operators = operatorsFor(rule.aggregate);
    const numeric = isNumericAggregate(rule.aggregate);

    // Bound to THIS rule's column, and only once the column is chosen — a
    // half-built rule has nothing to look values up in.
    const { table, column } = rule;
    const lookUp = useCallback(
        () => (fetchValues && table && column ? fetchValues(table, column) : Promise.resolve([])),
        [fetchValues, table, column],
    );
    // Undefined, not a function returning nothing: `ValuePicker` uses absence to
    // decide whether the field has a dropdown at all, so handing it a lookup
    // that always comes back empty would open a list saying "No values" where
    // there was never a list to open.
    const fetchOptions = fetchValues && table && column ? lookUp : undefined;

    return (
        <div className={`blk-filter${incomplete ? ' blk-filter--incomplete' : ''}`}>
            <div className="blk-filter-row">
                <input
                    type="checkbox"
                    className="sqlstudio-tick"
                    checked={rule.enabled !== false}
                    onChange={e => onUpdate({ ...rule, enabled: e.target.checked })}
                    title={rule.enabled === false ? 'Switched off' : 'Applied'}
                    aria-label="Apply this condition"
                />
                <ColumnPicker
                    value={
                        // A computed column has no name but the one it was
                        // given, so the field shows the option's own label
                        // rather than deriving `table.column` from two empties.
                        options.find(o => rule.transformId && o.transformId === rule.transformId) ?? {
                            table: rule.table,
                            column: rule.column,
                            aggregate: rule.aggregate,
                        }
                    }
                    options={options}
                    onChange={o =>
                        onUpdate({
                            ...rule,
                            // Carried through so the generator can resolve the
                            // computed column's alias. Explicitly cleared when
                            // switching BACK to a source column — left behind,
                            // it would keep comparing the old transformation
                            // while the row showed the new column.
                            transformId: o.transformId,
                            table: o.table,
                            column: o.column,
                            aggregate: o.aggregate,
                            // Switching from `max` to `count` can strip the
                            // operator out from under the rule. Left as it was
                            // it would still generate — `count(x) LIKE …` — so
                            // it falls back rather than staying invisible.
                            op: operatorsFor(o.aggregate).includes(rule.op) ? rule.op : '=',
                        })
                    }
                />
                <button
                    type="button"
                    className="blk-lib-icon"
                    onClick={() => onRemove(rule.id)}
                    title="Remove this condition"
                    aria-label="Remove condition"
                >
                    <Trash2 size={12} />
                </button>
            </div>
            <div className="blk-filter-row">
                <select
                    className="blk-filter-op"
                    value={rule.op}
                    onChange={e => {
                        const op = e.target.value as FilterOperator;
                        // Values are trimmed to what the new operator uses, so
                        // switching to `is null` does not keep a value that no
                        // longer appears anywhere.
                        const want = arity(op);
                        const values =
                            want === 0 ? [] : want === 'many' ? rule.values : rule.values.slice(0, want);
                        onUpdate({ ...rule, op, values });
                    }}
                    aria-label="Comparison"
                >
                    {operators.map(o => (
                        <option key={o} value={o}>
                            {o}
                        </option>
                    ))}
                </select>
                {n === 0 ? null : n === 'many' ? (
                    <ValuePicker
                        value={rule.values.join(', ')}
                        placeholder="a, b, c"
                        ariaLabel="Values"
                        fetch={fetchOptions}
                        onChange={next =>
                            onUpdate({ ...rule, values: next.split(',').map(v => v.trim()) })
                        }
                        // `in` holds a LIST, so picking adds rather than
                        // replaces — choosing a second vendor should not throw
                        // away the first. Already-present values are skipped so
                        // clicking twice does not duplicate.
                        onPick={picked => {
                            const have = rule.values.map(v => v.trim()).filter(v => v !== '');
                            if (have.includes(picked)) return;
                            onUpdate({ ...rule, values: [...have, picked] });
                        }}
                    />
                ) : (
                    Array.from({ length: n }).map((_, i) => (
                        <ValuePicker
                            key={i}
                            value={rule.values[i] ?? ''}
                            // Still a text input underneath: the value stays
                            // text in the state (plan §7) and a number input
                            // would refuse a partially typed `-` or `1.`.
                            // `inputMode` only changes which keyboard a touch
                            // device offers.
                            inputMode={numeric ? 'decimal' : undefined}
                            placeholder={n === 2 ? (i === 0 ? 'from' : 'to') : numeric ? 'number' : 'value'}
                            ariaLabel={`Value ${i + 1}`}
                            // No list for a numeric comparison: `> 10` is a
                            // threshold somebody chooses, not a value to look
                            // up, and the column's own values would be a
                            // misleading thing to offer.
                            fetch={numeric ? undefined : fetchOptions}
                            onChange={v => {
                                const values = [...rule.values];
                                values[i] = v;
                                onUpdate({ ...rule, values });
                            }}
                        />
                    ))
                )}
            </div>
        </div>
    );
}
