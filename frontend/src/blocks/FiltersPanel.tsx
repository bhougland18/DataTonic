// The WHERE clause: a tree of rules and groups, AND or OR per group.
//
// A flat AND list could not express "Medline items that are either
// discontinued or out of stock" — one AND, one OR — and splitting that into two
// queries is not an answer. The Infor source node's filter builder already
// settled this shape (`playground/providers/infor/FilterBuilder.tsx`); this is
// the same tree over columns rather than Infor fields.
//
// Stacked two lines per rule rather than three controls across: the panel is
// 260px, and column/operator/value side by side gives each about eighty, which
// cannot show `VendorItemDescription`. Height is the cheaper thing to spend —
// the section collapses when you are done with it.

import { FolderPlus, Plus, Trash2 } from 'lucide-react';
import ColumnPicker, { type ColumnOption } from './ColumnPicker';
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
    onUpdate: (node: FilterNode) => void;
    onAdd: (groupId: string, child: FilterNode) => void;
    onRemove: (id: string) => void;
}

export default function FiltersPanel({
    root,
    options,
    onUpdate,
    onAdd,
    onRemove,
}: FiltersPanelProps) {
    return (
        <div className="blk-filters">
            <GroupEditor
                group={root}
                options={options}
                depth={0}
                onUpdate={onUpdate}
                onAdd={onAdd}
                onRemove={onRemove}
            />
        </div>
    );
}

function GroupEditor({
    group,
    options,
    depth,
    onUpdate,
    onAdd,
    onRemove,
}: {
    group: FilterGroup;
    options: ColumnOption[];
    depth: number;
    onUpdate: (node: FilterNode) => void;
    onAdd: (groupId: string, child: FilterNode) => void;
    onRemove: (id: string) => void;
}) {
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
                            newRule(first?.table ?? '', first?.column ?? '', first?.aggregate),
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
                    />
                ) : (
                    <GroupEditor
                        key={child.id}
                        group={child}
                        options={options}
                        depth={depth + 1}
                        onUpdate={onUpdate}
                        onAdd={onAdd}
                        onRemove={onRemove}
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
}: {
    rule: FilterRule;
    options: ColumnOption[];
    onUpdate: (node: FilterNode) => void;
    onRemove: (id: string) => void;
}) {
    const n = arity(rule.op);
    // A rule that is started but not finished is dropped from the SQL. Marked,
    // so it is not a silent no-op somebody hunts for later.
    const incomplete = !filterIsComplete(rule);
    const operators = operatorsFor(rule.aggregate);
    const numeric = isNumericAggregate(rule.aggregate);

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
                    value={{ table: rule.table, column: rule.column, aggregate: rule.aggregate }}
                    options={options}
                    onChange={o =>
                        onUpdate({
                            ...rule,
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
                    <input
                        className="blk-filter-val"
                        value={rule.values.join(', ')}
                        placeholder="a, b, c"
                        onChange={e =>
                            onUpdate({
                                ...rule,
                                values: e.target.value.split(',').map(v => v.trim()),
                            })
                        }
                        aria-label="Values"
                    />
                ) : (
                    Array.from({ length: n }).map((_, i) => (
                        <input
                            key={i}
                            className="blk-filter-val"
                            value={rule.values[i] ?? ''}
                            // Still a text input: the value stays text in the
                            // state (plan §7) and a number input would refuse a
                            // partially typed `-` or `1.`. `inputMode` only
                            // changes which keyboard a touch device offers.
                            inputMode={numeric ? 'decimal' : undefined}
                            placeholder={n === 2 ? (i === 0 ? 'from' : 'to') : numeric ? 'number' : 'value'}
                            onChange={e => {
                                const values = [...rule.values];
                                values[i] = e.target.value;
                                onUpdate({ ...rule, values });
                            }}
                            aria-label={`Value ${i + 1}`}
                        />
                    ))
                )}
            </div>
        </div>
    );
}
