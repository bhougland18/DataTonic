// Building one computed column: kind, operation, parameters, name.
//
// The dialog exists for one reason — **a function with unfilled arguments must
// never reach the query**. Everything else here follows from that: the
// confirm button stays disabled until every required parameter has something
// in it, and the SQL fragment is rendered live so the answer to "what did I
// just build" is on screen rather than three sections away.
//
// Every kind comes through here, including `aggregate`, which is only a
// function and a column. Ben's call: six kinds that behave the same way is
// worth more than saving one click on the simplest, and the name gets typed
// here regardless.
//
// Rendered from `transform-ops.ts` rather than from a form per kind. A new
// operation is a row in that table and appears here with no edit to this file;
// a new PARAMETER TYPE is the only thing that needs a change, which is the
// right place for the seam.
//
// Same shape as `NameDialog` / `UnsavedQueryDialog` — backdrop, title, body,
// right-aligned actions with the safe option first — and `createPortal` for
// the same reason. Note `window.prompt` is not an option anywhere in this
// codebase: WebView2 does not implement it and the call fails silently.

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus, Trash2, X } from 'lucide-react';
import FiltersPanel from './FiltersPanel';
import ColumnPicker, { type ColumnOption } from './ColumnPicker';
import { useBackdropDismiss } from './backdrop';
import {
    addToGroup,
    newCaseBranch,
    newGroup,
    newRule,
    newTransform,
    removeNode,
    replaceNode,
    type CaseBranch,
    type ColumnTransform,
    type FilterGroup,
    type TransformArg,
    type TransformKind,
} from './builder-types';
import {
    addrOf,
    argText,
    sourceOfTransform,
    isTransformSource,
    opsFor,
    unaddr,
    suggestedAlias,
    transformExpression,
    transformProblem,
    type TransformOp,
    type TransformParam,
} from './transform-ops';
import type { SqlStudioTable } from '../sqleditor/types';

/** The kinds, in the order the picker lists them. */
const KINDS: { kind: TransformKind; label: string; hint: string }[] = [
    { kind: 'aggregate', label: 'Group by', hint: 'Summarise a column — sum, count, average' },
    { kind: 'function', label: 'Function', hint: 'Transform a value — dates, text, numbers' },
    { kind: 'window', label: 'Window', hint: 'Running totals, ranks, change from previous' },
    { kind: 'regex', label: 'Regex', hint: 'Extract or replace with a pattern' },
    { kind: 'case', label: 'Case', hint: 'Different values under different conditions' },
    { kind: 'literal', label: 'Value', hint: 'A fixed value on every row' },
];

/** Nothing chosen. Renders as an empty field, so it can be typed into. */
const NOTHING: ColumnOption = { table: '', column: '' };

/**
 * Counting every row, as a thing you can pick back.
 *
 * In the LIST but never the value: a bare `count` is a ROW count and that is a
 * real choice, so it has to be reachable again after a column has been picked.
 * As the value it filled the search box and had to be deleted first.
 */
const EVERY_ROW: ColumnOption = { table: '', column: '', label: '— every row —' };

export interface TransformDialogProps {
    /** Editing an existing one, or undefined to create. */
    initial?: ColumnTransform;
    /** Everything selectable as a source column. */
    tables: SqlStudioTable[];
    /** The other computed columns, so a window can be OF one of them. */
    siblings: ColumnTransform[];
    onSubmit: (transform: ColumnTransform) => void;
    onCancel: () => void;
}


export default function TransformDialog({
    initial,
    tables,
    siblings,
    onSubmit,
    onCancel,
}: TransformDialogProps) {
    const [draft, setDraft] = useState<ColumnTransform>(
        () => initial ?? newTransform('aggregate'),
    );
    // Whether the person has typed a name. Until they do, the name tracks the
    // operation — picking `sum` then `avg` should not leave "sum Line.Quantity"
    // behind. Once they type, it is theirs and nothing overwrites it.
    const [named, setNamed] = useState(() => !!initial?.alias);
    const firstRef = useRef<HTMLSelectElement>(null);

    useEffect(() => {
        firstRef.current?.focus();
    }, []);

    const columnType = useMemo(() => {
        if (!draft.table || !draft.column) return undefined;
        return tables
            .find(t => t.name === draft.table)
            ?.columns.find(c => c.name === draft.column)?.type;
    }, [tables, draft.table, draft.column]);

    // An operation the column cannot take is ABSENT, not disabled. A disabled
    // control invites somebody to work out why it is disabled; an absent one
    // says this column is not that sort of thing.
    const ops = useMemo(
        () => opsFor(draft.kind, columnType),
        [draft.kind, columnType],
    );
    const op: TransformOp | undefined = ops.find(o => o.id === draft.op);

    /** Keep the suggested name in step until the person takes it over. */
    const retitle = (next: ColumnTransform): ColumnTransform =>
        named ? next : { ...next, alias: next.op ? suggestedAlias(next) : '' };

    const setArg = (name: string, value: TransformArg) =>
        setDraft(d => retitle({ ...d, args: { ...d.args, [name]: value } }));

    /** Everything a CASE branch can compare — the same shape WHERE uses. */
    const columnOptions = useMemo(
        () => tables.flatMap(t => t.columns.map(c => ({ table: t.name, column: c.name }))),
        [tables],
    );
    // The column chosen at the top of the dialog. For a CASE it emits nothing
    // by itself - a case names its columns inside its branches - but it is
    // what somebody means by "the column this case is about", so it seeds
    // every new condition and the suggested name.
    const seedColumn: ColumnOption | undefined =
        draft.table && draft.column ? { table: draft.table, column: draft.column } : undefined;

    /**
     * What the Column field can be set to.
     *
     * Only an AGGREGATE gets the every-row entry — it is what makes `count(*)`
     * sayable, and no other kind can do anything without a column.
     */
    const pickableColumns = useMemo(
        () => (draft.kind === 'aggregate' ? [EVERY_ROW, ...columnOptions] : columnOptions),
        [draft.kind, columnOptions],
    );

    /**
     * What a window can be OF.
     *
     * Computed columns LEAD, and that is not a nicety: in a grouped query a
     * window over a raw column fails outright, so the aggregate beside it is
     * almost always the right answer.
     */
    const sourceOptions = useMemo<ColumnOption[]>(
        () => [
            ...siblings.map(s => ({
                table: s.table ?? '',
                column: s.column ?? '',
                transformId: s.id,
                label: s.alias || 'unnamed',
            })),
            ...columnOptions,
        ],
        [siblings, columnOptions],
    );

    const branches = Array.isArray(draft.args.branches)
        ? (draft.args.branches as CaseBranch[])
        : [];

    const problem = transformProblem(draft);
    const complete = problem === null;
    const preview = transformExpression(draft, siblings);

    const submit = () => {
        if (complete) onSubmit(draft);
    };

    // Escape cancels from anywhere in the dialog; Enter is NOT bound globally,
    // because a select with an open list swallows it and a half-built
    // transformation submitted by a stray Enter is exactly what this is for.
    const onKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
        }
    };

    // A press that began inside the dialog is not a click-away, however far
    // the mouse travelled before it was released.
    const backdrop = useBackdropDismiss(onCancel);

    return createPortal(
        <div className="blk-modal-backdrop" {...backdrop}>
            <div
                className="blk-modal blk-xfd"
                role="dialog"
                aria-modal="true"
                onKeyDown={onKeyDown}
            >
                <div className="blk-modal-title">
                    <span>{initial ? 'Edit column' : 'New column'}</span>
                    {/* A way out that does not depend on reaching the bottom.
                        A CASE with several branches is taller than the screen,
                        and Escape is not discoverable. */}
                    <button
                        type="button"
                        className="blk-lib-icon blk-xfd-close"
                        onClick={onCancel}
                        title="Close without saving"
                        aria-label="Close"
                    >
                        <X size={14} />
                    </button>
                </div>
                <div className="blk-modal-body">
                    <label className="blk-ced-field">
                        <span>Kind</span>
                        <select
                            ref={firstRef}
                            value={draft.kind}
                            onChange={e => {
                                const kind = e.target.value as TransformKind;
                                // Operation and arguments belong to the kind, so
                                // changing it clears them rather than carrying a
                                // `sum` into the Regex family.
                                // Straight to the single operation where a kind
                                // has only one. A CASE is always a when/then,
                                // and a dropdown that cannot be changed is a
                                // question with one answer.
                                const only = opsFor(kind, columnType);
                                setDraft(d =>
                                    retitle({
                                        ...d,
                                        kind,
                                        op: only.length === 1 ? only[0].id : '',
                                        args: {},
                                    }),
                                );
                            }}
                        >
                            {KINDS.map(k => (
                                <option key={k.kind} value={k.kind}>
                                    {k.label}
                                </option>
                            ))}
                        </select>
                    </label>
                    <p className="blk-xfd-hint">
                        {KINDS.find(k => k.kind === draft.kind)?.hint}
                    </p>

                    {draft.kind === 'literal' ? null : (
                        <label className="blk-ced-field">
                            <span>Column</span>
                            {/* The same picker the filter and sort rows use, so
                                a catalog of several hundred columns is typed at
                                rather than scrolled through. */}
                            <ColumnPicker
                                value={seedColumn ?? NOTHING}
                                options={pickableColumns}
                                // Empty is a real answer for a bare `count`, so
                                // it is said in the PLACEHOLDER rather than
                                // pre-filled into the box. A default sitting in
                                // the field has to be deleted before the field
                                // can be searched.
                                placeholder={
                                    draft.kind === 'aggregate'
                                        ? 'every row'
                                        : 'Search for a column'
                                }
                                onChange={o =>
                                    setDraft(d =>
                                        retitle({
                                            ...d,
                                            table: o.table || undefined,
                                            column: o.column || undefined,
                                        }),
                                    )
                                }
                            />
                        </label>
                    )}

                    {/* Gone entirely unless there is a choice to make. A CASE is
                        always a when/then and a fixed value is always a fixed
                        value; a dropdown listing one option asks a question that
                        has already been answered. When there are NONE the field
                        goes too, and the message below says why.

                        Rendered conditionally rather than with `hidden`: this
                        class sets `display: flex`, which beats the UA rule for
                        the attribute, so `hidden` here does exactly nothing. */}
                    {ops.length > 1 ? (
                        <label className="blk-ced-field">
                            <span>Operation</span>
                            <select
                                value={draft.op}
                                onChange={e =>
                                    setDraft(d => retitle({ ...d, op: e.target.value, args: {} }))
                                }
                            >
                                <option value="">— pick one —</option>
                                {ops.map(o => (
                                    <option key={o.id} value={o.id}>
                                        {o.label}
                                    </option>
                                ))}
                            </select>
                        </label>
                    ) : null}
                    {/* Said out loud rather than shown as an empty list: an
                        operation list that is empty because of the COLUMN reads
                        as a broken dialog. */}
                    {ops.length === 0 ? (
                        <p className="blk-xfd-none">
                            {draft.kind === 'aggregate' && !columnType
                                ? 'Pick a column first.'
                                : `Nothing in this family works on a ${columnType ?? 'column'} like this one.`}
                        </p>
                    ) : null}

                    {op?.params.map(p =>
                        p.type === 'source' ? (
                            <label className="blk-ced-field" key={p.name}>
                                <span>{p.label}</span>
                                {/* A window is usually OF a computed column —
                                    a running total of a COUNT — because in a
                                    grouped query a window over a raw column
                                    does not run at all. Computed columns lead
                                    the list for that reason. */}
                                <ColumnPicker
                                    value={sourceValue(argText(draft.args, p.name), siblings)}
                                    options={sourceOptions}
                                    placeholder="Search for a column"
                                    onChange={o =>
                                        setArg(
                                            p.name,
                                            o.transformId
                                                ? sourceOfTransform(o.transformId)
                                                : addrOf(o.table, o.column),
                                        )
                                    }
                                />
                                {p.hint ? <em className="blk-xfd-phint">{p.hint}</em> : null}
                            </label>
                        ) : p.type === 'columns' ? (
                            <ColumnList
                                key={p.name}
                                param={p}
                                value={Array.isArray(draft.args[p.name]) ? (draft.args[p.name] as string[]) : []}
                                options={columnOptions}
                                onChange={next => setArg(p.name, next)}
                            />
                        ) : p.type === 'branches' ? (
                            <CaseBranches
                                key={p.name}
                                branches={branches}
                                options={columnOptions}
                                seed={seedColumn}
                                onChange={next => setArg(p.name, next)}
                                otherwise={argText(draft.args, 'else')}
                                otherwiseIsColumn={argText(draft.args, 'elseIsColumn') === 'yes'}
                                onOtherwise={v => setArg('else', v)}
                                onOtherwiseIsColumn={on => setArg('elseIsColumn', on ? 'yes' : '')}
                            />
                        ) : (
                            <ParamField
                                key={p.name}
                                param={p}
                                value={argText(draft.args, p.name)}
                                onChange={v => setArg(p.name, v)}
                            />
                        ),
                    )}

                    <label className="blk-ced-field">
                        <span>Name</span>
                        <input
                            value={draft.alias}
                            placeholder="What this column is called"
                            onChange={e => {
                                setNamed(true);
                                setDraft(d => ({ ...d, alias: e.target.value }));
                            }}
                        />
                    </label>

                    {/* The cheapest honest check there is. Somebody who reads
                        SQL confirms the whole thing here; somebody who does not
                        learns a little by seeing their choices become it. */}
                    <div className="blk-xfd-preview">
                        <span>SQL</span>
                        <code>
                            {preview
                                ? `${preview}${draft.alias.trim() ? ` AS "${draft.alias.trim()}"` : ''}`
                                : '—'}
                        </code>
                    </div>
                </div>
                {/* Said out loud, not only on hover. A disabled button with the
                    reason hidden behind a tooltip is a button people click at
                    twice and then give up on. */}
                {problem ? <p className="blk-xfd-none">{problem}</p> : null}
                {/* `erd-btn`, which is what every other dialog uses. The
                    `blk-btn` these carried before is defined nowhere at all, so
                    they were rendering as bare native buttons — which is why
                    they looked like they came from a different application.
                    They did: they came from no application. */}
                <div className="blk-modal-actions">
                    <button type="button" className="erd-btn" onClick={onCancel}>
                        Cancel
                    </button>
                    <button
                        type="button"
                        className="erd-btn erd-btn--primary"
                        onClick={submit}
                        disabled={!complete}
                        title={problem ?? undefined}
                    >
                        {initial ? 'Save' : 'Add'}
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
}

function ParamField({
    param,
    value,
    onChange,
}: {
    param: TransformParam;
    value: string;
    onChange: (v: string) => void;
}) {
    return (
        <label className="blk-ced-field">
            <span>{param.label}</span>
            {param.type === 'choice' ? (
                <select value={value} onChange={e => onChange(e.target.value)}>
                    <option value="">— pick one —</option>
                    {(param.options ?? []).map(o => (
                        <option key={o} value={o}>
                            {o}
                        </option>
                    ))}
                </select>
            ) : (
                <input
                    value={value}
                    placeholder={param.default}
                    // `inputMode` only changes which keyboard a touch device
                    // offers; the value stays text, because a number input
                    // refuses a partially typed `-` or `1.`.
                    inputMode={param.type === 'number' ? 'decimal' : undefined}
                    onChange={e => onChange(e.target.value)}
                />
            )}
            {param.hint ? <em className="blk-xfd-phint">{param.hint}</em> : null}
        </label>
    );
}

/**
 * The WHEN / THEN rows of a CASE.
 *
 * Each condition is a full `FiltersPanel` over the branch's own `FilterNode` —
 * the same operators, the same column picker, the same completeness marking.
 * A WHEN is a predicate, the builder has a good predicate editor, and a second
 * one would drift from the first within a release.
 *
 * ORDER is load-bearing here in a way it is nowhere else in the builder: CASE
 * takes the FIRST match, so two overlapping conditions give different answers
 * in different orders. Hence the numbers down the left — the same device the
 * Sort list uses, for the same reason.
 */
function CaseBranches({
    branches,
    options,
    seed,
    onChange,
    otherwise,
    otherwiseIsColumn,
    onOtherwise,
    onOtherwiseIsColumn,
}: {
    branches: CaseBranch[];
    options: ColumnOption[];
    seed?: ColumnOption;
    onChange: (next: CaseBranch[]) => void;
    otherwise: string;
    otherwiseIsColumn: boolean;
    onOtherwise: (v: string) => void;
    onOtherwiseIsColumn: (on: boolean) => void;
}) {
    const replace = (id: string, patch: Partial<CaseBranch>) =>
        onChange(branches.map(b => (b.id === id ? { ...b, ...patch } : b)));

    return (
        <div className="blk-xfd-branches">
            {branches.map((b, i) => (
                <div className="blk-xfd-branch" key={b.id}>
                    <div className="blk-xfd-branch-head">
                        <span className="blk-sort-rank">{i + 1}</span>
                        <span className="blk-xfd-when">when</span>
                        <span className="blk-join-gap" />
                        <button
                            type="button"
                            className="blk-lib-icon"
                            onClick={() => onChange(branches.filter(x => x.id !== b.id))}
                            title="Remove this condition"
                            aria-label={`Remove condition ${i + 1}`}
                        >
                            <Trash2 size={12} />
                        </button>
                    </div>
                    <FiltersPanel
                        root={b.when as FilterGroup}
                        options={options}
                        seed={seed}
                        onUpdate={node => replace(b.id, { when: replaceNode(b.when as FilterGroup, node) })}
                        onAdd={(groupId, child) =>
                            replace(b.id, { when: addToGroup(b.when as FilterGroup, groupId, child) })
                        }
                        onRemove={id => replace(b.id, { when: removeNode(b.when as FilterGroup, id) })}
                    />
                    <ValueField
                        label="then"
                        value={b.then}
                        isColumn={!!b.thenIsColumn}
                        options={options}
                        seed={seed}
                        onValue={v => replace(b.id, { then: v })}
                        onIsColumn={on => replace(b.id, { thenIsColumn: on })}
                    />
                </div>
            ))}
            <button
                type="button"
                className="blk-xfd-addbranch"
                onClick={() => onChange([...branches, seededBranch(seed)])}
            >
                <Plus size={12} />
                <span>Add a condition</span>
            </button>

            {/* ELSE belongs with the WHENs it completes, not in a field below
                them under a different word. Labelled with the keyword it
                becomes, like the WHEN and THEN above it. */}
            <div className="blk-xfd-else">
                <ValueField
                    label="else"
                    value={otherwise}
                    isColumn={otherwiseIsColumn}
                    options={options}
                    seed={seed}
                    onValue={onOtherwise}
                    onIsColumn={onOtherwiseIsColumn}
                />
            </div>
            <p className="blk-xfd-phint">
                Left empty, anything that matches no condition comes back null.
            </p>
        </div>
    );
}

/**
 * The value half of a THEN or an ELSE.
 *
 * Ticking the column box swaps the text field for a picker rather than
 * asking somebody to type Table.Column. Typing it cannot be made safe: a
 * table in this very workspace is called item_norm.parquet, so there is no
 * dot to split on that is right in both directions. Picking sidesteps the
 * parse entirely.
 */
function ValueField({
    label,
    value,
    isColumn,
    options,
    seed,
    onValue,
    onIsColumn,
}: {
    label: string;
    value: string;
    isColumn: boolean;
    options: ColumnOption[];
    /** What ticking the column box starts from — the case's own column. */
    seed?: ColumnOption;
    onValue: (v: string) => void;
    onIsColumn: (on: boolean) => void;
}) {
    const [table, column] = unaddr(value);
    return (
        <div className="blk-xfd-then">
            <span>{label}</span>
            {isColumn ? (
                <ColumnPicker
                    value={{ table, column }}
                    options={options}
                    onChange={o => onValue(addrOf(o.table, o.column))}
                />
            ) : (
                <input
                    value={value}
                    placeholder="a value"
                    onChange={e => onValue(e.target.value)}
                    aria-label={label}
                />
            )}
            {/* Without the flag the generator cannot tell the WORD Vendor
                from the COLUMN Vendor, and guessing wrong is silent — you
                get the word, on every row.

                Ticking it starts from the column the case is about, which is
                right far more often than starting from nothing. It cannot
                simply KEEP what was there: a typed literal is not a column
                address, and leaving it would show an empty picker while the
                query still used the old text. */}
            <label className="blk-xfd-iscol" title="Use a column's value rather than this text">
                <input
                    type="checkbox"
                    className="sqlstudio-tick"
                    checked={isColumn}
                    onChange={e => {
                        const on = e.target.checked;
                        onIsColumn(on);
                        onValue(on && seed ? addrOf(seed.table, seed.column) : '');
                    }}
                />
                <span>column</span>
            </label>
        </div>
    );
}

/**
 * A new branch, already pointed at the column the case is about.
 *
 * An empty branch means two more clicks and a decision nobody wanted to make
 * again — and the decision defaulted to whatever was first in the catalog,
 * which is how three conditions end up on the wrong column while the query
 * still runs and still returns something plausible.
 */
function seededBranch(seed?: ColumnOption): CaseBranch {
    const b = newCaseBranch();
    if (!seed) return b;
    return { ...b, when: newGroup('and', [newRule(seed.table, seed.column)]) };
}

/**
 * An ORDERED list of columns — what a window partitions or orders by.
 *
 * A list rather than one picker, because both of these genuinely take several:
 * "within company and location", "ordered by year then month". Order matters
 * for ORDER BY and not for PARTITION BY, but one control for both is worth more
 * than two that differ in a way nobody would notice.
 */
function ColumnList({
    param,
    value,
    options,
    onChange,
}: {
    param: TransformParam;
    value: string[];
    options: ColumnOption[];
    onChange: (next: string[]) => void;
}) {
    return (
        <div className="blk-ced-field">
            <span>{param.label}</span>
            {value.map((v, i) => {
                const [table, column] = unaddr(v);
                return (
                    <div className="blk-xfd-collist-row" key={`${v}-${i}`}>
                        <ColumnPicker
                            value={{ table, column }}
                            options={options}
                            onChange={o =>
                                onChange(value.map((x, k) => (k === i ? addrOf(o.table, o.column) : x)))
                            }
                        />
                        <button
                            type="button"
                            className="blk-lib-icon"
                            onClick={() => onChange(value.filter((_, k) => k !== i))}
                            title="Remove"
                            aria-label={`Remove ${column || 'column'}`}
                        >
                            <Trash2 size={12} />
                        </button>
                    </div>
                );
            })}
            <button
                type="button"
                className="blk-xfd-addbranch"
                onClick={() => onChange([...value, ''])}
            >
                <Plus size={12} />
                <span>{value.length === 0 ? `Add a column` : `Add another`}</span>
            </button>
            {param.hint ? <em className="blk-xfd-phint">{param.hint}</em> : null}
        </div>
    );
}

/** A stored `source` argument as something the picker can show. */
function sourceValue(v: string, siblings: ColumnTransform[]): ColumnOption {
    if (!v) return { table: '', column: '' };
    if (isTransformSource(v)) {
        const id = v.slice('tx:'.length);
        const found = siblings.find(s => s.id === id);
        return found
            ? { table: '', column: '', transformId: found.id, label: found.alias || 'unnamed' }
            : { table: '', column: '' };
    }
    const [table, column] = unaddr(v);
    return { table, column };
}
