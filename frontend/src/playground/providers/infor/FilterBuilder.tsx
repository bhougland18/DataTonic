import { Plus, Trash2, FolderPlus } from 'lucide-react';
import {
    FILTER_OPS,
    newRule,
    newGroup,
    type FilterGroup,
    type FilterNode,
    type FilterRule,
    type FilterOp,
} from './filterModel';

const DATALIST_ID = 'pgi-filter-fields';

// Visual filter builder: a recursive tree of rules and nested groups. The field
// inputs share one datalist of the business class's fields (searchable). Emits
// the whole tree up via onChange; the caller compiles it to LPL.
export default function FilterBuilder({
    root,
    fields,
    onChange,
}: {
    root: FilterGroup;
    fields: string[];
    onChange: (g: FilterGroup) => void;
}) {
    return (
        <div className="pgi-fb">
            <datalist id={DATALIST_ID}>
                {fields.map((f) => (
                    <option key={f} value={f} />
                ))}
            </datalist>
            <GroupEditor group={root} onChange={onChange} depth={0} />
        </div>
    );
}

function GroupEditor({
    group,
    onChange,
    onRemove,
    depth,
}: {
    group: FilterGroup;
    onChange: (g: FilterGroup) => void;
    onRemove?: () => void;
    depth: number;
}) {
    const update = (i: number, child: FilterNode) =>
        onChange({ ...group, children: group.children.map((c, j) => (j === i ? child : c)) });
    const remove = (i: number) =>
        onChange({ ...group, children: group.children.filter((_, j) => j !== i) });
    const addRule = () => onChange({ ...group, children: [...group.children, newRule()] });
    const addGroup = () => onChange({ ...group, children: [...group.children, newGroup()] });
    const setConj = (conj: 'and' | 'or') => onChange({ ...group, conj });

    return (
        <div className={`pgi-fb-group${depth > 0 ? ' pgi-fb-group--nested' : ''}`}>
            <div className="pgi-fb-grouphead">
                <div className="pgi-fb-conj" role="group" aria-label="Join with">
                    <button
                        type="button"
                        className={group.conj === 'and' ? 'is-active' : ''}
                        onClick={() => setConj('and')}
                    >
                        AND
                    </button>
                    <button
                        type="button"
                        className={group.conj === 'or' ? 'is-active' : ''}
                        onClick={() => setConj('or')}
                    >
                        OR
                    </button>
                </div>
                <div className="pgi-fb-groupactions">
                    <button type="button" className="pgi-fb-add" onClick={addRule}>
                        <Plus size={12} /> Rule
                    </button>
                    <button type="button" className="pgi-fb-add" onClick={addGroup}>
                        <FolderPlus size={12} /> Group
                    </button>
                    {onRemove && (
                        <button
                            type="button"
                            className="pg-icon-btn"
                            onClick={onRemove}
                            title="Remove group"
                        >
                            <Trash2 size={12} />
                        </button>
                    )}
                </div>
            </div>
            <div className="pgi-fb-children">
                {group.children.length === 0 && (
                    <div className="pgi-fb-empty">No conditions yet — add a rule.</div>
                )}
                {group.children.map((child, i) =>
                    child.kind === 'rule' ? (
                        <RuleEditor
                            key={child.id}
                            rule={child}
                            onChange={(r) => update(i, r)}
                            onRemove={() => remove(i)}
                        />
                    ) : (
                        <GroupEditor
                            key={child.id}
                            group={child}
                            onChange={(g) => update(i, g)}
                            onRemove={() => remove(i)}
                            depth={depth + 1}
                        />
                    ),
                )}
            </div>
        </div>
    );
}

function RuleEditor({
    rule,
    onChange,
    onRemove,
}: {
    rule: FilterRule;
    onChange: (r: FilterRule) => void;
    onRemove: () => void;
}) {
    // A rule that's been started (field or value typed) but not finished is
    // dropped from the generated filter — flag it so it isn't a silent no-op.
    const hasField = rule.field.trim().length > 0;
    const hasValue = rule.value.trim().length > 0;
    const incomplete = (hasField || hasValue) && !(hasField && hasValue);
    return (
        <div className={`pgi-fb-rule${incomplete ? ' pgi-fb-rule--incomplete' : ''}`}>
            <input
                className="pg-input pgi-fb-field"
                list={DATALIST_ID}
                placeholder="Field"
                value={rule.field}
                onChange={(e) => onChange({ ...rule, field: e.target.value })}
            />
            <div className="pgi-fb-opval">
                <select
                    className="pg-input pgi-fb-op"
                    value={rule.op}
                    onChange={(e) => onChange({ ...rule, op: e.target.value as FilterOp })}
                >
                    {FILTER_OPS.map((o) => (
                        <option key={o.id} value={o.id}>
                            {o.label}
                        </option>
                    ))}
                </select>
                <input
                    className="pg-input pgi-fb-val"
                    placeholder="Value"
                    value={rule.value}
                    onChange={(e) => onChange({ ...rule, value: e.target.value })}
                />
                <button type="button" className="pg-icon-btn" onClick={onRemove} title="Remove rule">
                    <Trash2 size={12} />
                </button>
            </div>
            {incomplete && (
                <div className="pgi-fb-rulehint">
                    {hasValue ? 'Pick a field' : 'Enter a value'} — this rule is skipped until
                    it's complete
                </div>
            )}
        </div>
    );
}
