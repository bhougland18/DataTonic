// The ER-model authoring surface: an editable diagram plus the relationship
// side panel (add form, pair filter, grouped list with delete).
//
// Extracted from ErdWorkspace so the Working DB node editor and the Blocks
// studio are the SAME editor rather than two that resemble each other. They
// differ only in where the model comes from and where Save puts it, which is
// what each caller's own toolbar expresses; everything below the toolbar is
// shared, so a fix to the add form or the diagram reaches both.
//
// Deliberately uncontrolled about persistence: it owns no save button and no
// workspace knowledge, only `relationships` and `onRelationshipsChange`.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Bookmark, Filter, Plus, Trash2, X } from 'lucide-react';
import ErDiagram from './ErDiagram';
import { qualifierSql, type ErdQualifier, type ErdRelationship, type ErdTable } from './model';
// Imported here, not left to the caller: this component owns the `erd-ws-*`
// markup, so a second host (the Blocks studio) must not have to know that its
// styles live in another module's stylesheet.
import './erd.css';

interface Pair {
    a: string;
    b: string;
}
interface PairGroup extends Pair {
    key: string;
    rels: ErdRelationship[];
}

const relId = (r: Omit<ErdRelationship, 'id'>) =>
    `${r.fromTable}.${r.fromColumn}->${r.toTable}.${r.toColumn}`;

/** Cap on rendered options. An Infor business class can carry 1000+ columns,
 *  and nobody scrolls past a couple of hundred — they type instead. */
const COMBO_LIMIT = 200;

function ColumnInput({
    value,
    columns,
    placeholder = 'search column…',
    onChange,
}: {
    value: string;
    columns: { name: string }[];
    placeholder?: string;
    onChange: (v: string) => void;
}) {
    const [open, setOpen] = useState(false);
    // Whether the text in the box is something the user is CURRENTLY typing, as
    // opposed to a selection made earlier. This is the whole fix: the list is
    // filtered while typing and unfiltered otherwise. A native <datalist>
    // cannot express that — it always filters by the field's value, so once a
    // column was chosen the dropdown offered only that one and the field could
    // not be changed.
    const [typing, setTyping] = useState(false);

    const list = useMemo(() => {
        if (!typing || !value) return columns;
        const q = value.toLowerCase();
        return columns.filter(c => c.name.toLowerCase().includes(q));
    }, [columns, typing, value]);

    return (
        <div className="erd-combo">
            <input
                value={value}
                placeholder={placeholder}
                onFocus={() => {
                    setTyping(false);
                    setOpen(true);
                }}
                // Closing on blur must not race the option's click, so the
                // option suppresses mousedown rather than this being delayed.
                onBlur={() => {
                    setOpen(false);
                    setTyping(false);
                }}
                onChange={e => {
                    onChange(e.target.value);
                    setTyping(true);
                    setOpen(true);
                }}
                onKeyDown={e => {
                    if (e.key === 'Escape') setOpen(false);
                }}
            />
            {open && list.length > 0 ? (
                <ul className="erd-combo-list">
                    {list.slice(0, COMBO_LIMIT).map(c => (
                        <li key={c.name}>
                            <button
                                type="button"
                                onMouseDown={e => e.preventDefault()}
                                onClick={() => {
                                    onChange(c.name);
                                    setTyping(false);
                                    setOpen(false);
                                }}
                            >
                                {c.name}
                            </button>
                        </li>
                    ))}
                    {list.length > COMBO_LIMIT ? (
                        <li className="erd-combo-more">
                            +{list.length - COMBO_LIMIT} more — keep typing
                        </li>
                    ) : null}
                </ul>
            ) : null}
        </div>
    );
}

/**
 * Compact editor for one qualifier.
 *
 * The table is a choice between the join's TWO tables, never free text: a
 * qualifier constrains one side of this join, and allowing any table would turn
 * it into an arbitrary filter — the abuse the qualifier model exists to avoid.
 */
function QualifierForm({
    rel,
    tables,
    onAdd,
    onCancel,
}: {
    rel: ErdRelationship;
    tables: ErdTable[];
    onAdd: (q: ErdQualifier) => void;
    onCancel: () => void;
}) {
    const [table, setTable] = useState(rel.toTable);
    const [column, setColumn] = useState('');
    const [op, setOp] = useState<'=' | '<>'>('=');
    const [value, setValue] = useState('');
    const [numeric, setNumeric] = useState(false);

    const cols = tables.find(t => t.name === table)?.columns ?? [];

    return (
        <div className="erd-ws-qual-form">
            <select value={table} onChange={e => setTable(e.target.value)}>
                <option value={rel.fromTable}>{rel.fromTable}</option>
                <option value={rel.toTable}>{rel.toTable}</option>
            </select>
            <ColumnInput
                value={column}
                columns={cols}
                placeholder="column"
                onChange={setColumn}
            />
            <select value={op} onChange={e => setOp(e.target.value as '=' | '<>')}>
                <option value="=">=</option>
                <option value="<>">≠</option>
            </select>
            <input value={value} placeholder="value" onChange={e => setValue(e.target.value)} />
            <label className="erd-ws-qual-num" title="Emit the value unquoted">
                <input
                    type="checkbox"
                    checked={numeric}
                    onChange={e => setNumeric(e.target.checked)}
                />
                123
            </label>
            <button
                className="erd-btn"
                disabled={!column || !value}
                onClick={() => onAdd({ table, column, op, value, numeric })}
            >
                Add
            </button>
            <button className="erd-btn" onClick={onCancel}>
                Cancel
            </button>
        </div>
    );
}

const samePair = (g: Pair, p: Pair) => {
    const [ga, gb] = [g.a.toLowerCase(), g.b.toLowerCase()];
    const [pa, pb] = [p.a.toLowerCase(), p.b.toLowerCase()];
    return (ga === pa && gb === pb) || (ga === pb && gb === pa);
};

export interface ErdAuthoringProps {
    tables: ErdTable[];
    relationships: ErdRelationship[];
    onRelationshipsChange: (next: ErdRelationship[]) => void;
    /** Tables whose edges are not drawn. Passing `onToggleRelations` is what
     *  puts the per-table toggle on the diagram at all. */
    hiddenRelations?: string[];
    onToggleRelations?: (table: string) => void;
    /** Bump to re-run auto-arrange on the diagram. */
    arrangeNonce?: number;
    /** Save a table pair's joins to the library. Omitted when the host has no
     *  library (the Working DB node edits one model and never reuses it). */
    onSaveJoins?: (rels: ErdRelationship[]) => void;
    /** Join ids already in the library, so the control can say so. */
    savedJoinIds?: Set<string>;
}

export default function ErdAuthoring({
    tables,
    relationships,
    onRelationshipsChange,
    hiddenRelations,
    onToggleRelations,
    arrangeNonce,
    onSaveJoins,
    savedJoinIds,
}: ErdAuthoringProps) {
    const [selectedPair, setSelectedPair] = useState<Pair | null>(null);
    /** Relationship id whose qualifier form is open, if any. */
    const [qualifying, setQualifying] = useState<string | null>(null);

    // Panel width, draggable. The qualifier row alone wants a table, a column,
    // an operator and a value, which does not fit 320px — and a user with long
    // ERP column names needs more room than one with short ones.
    const [sideWidth, setSideWidth] = useState(320);
    const dragFrom = useRef<{ x: number; w: number } | null>(null);

    const onDrag = useCallback((e: PointerEvent) => {
        const d = dragFrom.current;
        if (!d) return;
        // Dragging LEFT widens: the panel is anchored to the right edge.
        setSideWidth(Math.min(720, Math.max(260, d.w + (d.x - e.clientX))));
    }, []);
    const endDrag = useCallback(() => {
        dragFrom.current = null;
    }, []);
    useEffect(() => {
        window.addEventListener('pointermove', onDrag);
        window.addEventListener('pointerup', endDrag);
        return () => {
            window.removeEventListener('pointermove', onDrag);
            window.removeEventListener('pointerup', endDrag);
        };
    }, [onDrag, endDrag]);
    const [fromTable, setFromTable] = useState('');
    const [fromCol, setFromCol] = useState('');
    const [toTable, setToTable] = useState('');
    const [toCol, setToCol] = useState('');

    // The table pickers default to the first two tables, but the table list
    // arrives asynchronously (a catalog read, a node open) and may change under
    // us. Resolving the selection at render rather than seeding state in an
    // effect means the pickers are never left pointing at a table that is gone.
    const names = useMemo(() => tables.map(t => t.name), [tables]);
    const fromSel = names.includes(fromTable) ? fromTable : (names[0] ?? '');
    const toSel = names.includes(toTable) ? toTable : (names[1] ?? names[0] ?? '');

    const colsOf = (name: string) => tables.find(t => t.name === name)?.columns ?? [];

    // Two INDEPENDENT filters, applied in order.
    //
    // Hiding a table removes its joins from the list as well as the canvas —
    // otherwise the panel still lists edges the diagram refuses to draw. The
    // pair filter then narrows what remains, and clearing it returns to the
    // hidden-filtered set rather than to everything. That ordering is the whole
    // point: "show all" means all of what is visible, not all of what exists.
    const hidden = useMemo(() => new Set(hiddenRelations ?? []), [hiddenRelations]);
    const visible = useMemo(
        () => relationships.filter(r => !hidden.has(r.fromTable) && !hidden.has(r.toTable)),
        [relationships, hidden],
    );

    // Group relationships by unordered table pair for the list.
    const groups = useMemo<PairGroup[]>(() => {
        const m = new Map<string, PairGroup>();
        for (const r of visible) {
            const [a, b] = [r.fromTable, r.toTable].sort((x, y) =>
                x.toLowerCase().localeCompare(y.toLowerCase()),
            );
            const key = `${a.toLowerCase()}||${b.toLowerCase()}`;
            const g = m.get(key);
            if (g) g.rels.push(r);
            else m.set(key, { key, a, b, rels: [r] });
        }
        return Array.from(m.values());
    }, [visible]);

    const shownGroups = selectedPair ? groups.filter(g => samePair(g, selectedPair)) : groups;

    const removeRel = (id: string) => onRelationshipsChange(relationships.filter(r => r.id !== id));

    const replaceRel = (rel: ErdRelationship, next: ErdRelationship) =>
        onRelationshipsChange(relationships.map(r => (r.id === rel.id ? next : r)));

    const addQualifier = (rel: ErdRelationship, q: ErdQualifier) =>
        replaceRel(rel, { ...rel, qualifiers: [...(rel.qualifiers ?? []), q] });

    const removeQualifier = (rel: ErdRelationship, i: number) => {
        const next = (rel.qualifiers ?? []).filter((_, n) => n !== i);
        // Dropped entirely when empty rather than left as `[]`, so a
        // relationship without qualifiers serialises the same as one that never
        // had any and the two compare equal in the library.
        replaceRel(rel, { ...rel, qualifiers: next.length ? next : undefined });
    };

    const addManual = () => {
        if (!fromSel || !fromCol || !toSel || !toCol) return;
        const base = {
            fromTable: fromSel,
            fromColumn: fromCol,
            toTable: toSel,
            toColumn: toCol,
            inferred: false,
        };
        const id = relId(base);
        // Adding the same pair twice is a no-op rather than a duplicate row:
        // the id IS the join, so two entries would be the same fact listed
        // twice and would draw two edges on one link.
        if (!relationships.some(r => r.id === id)) {
            onRelationshipsChange([...relationships, { id, ...base }]);
        }
        setFromCol('');
        setToCol('');
    };


    return (
        <div className="erd-ws-body" data-tour="erd-diagram">
            <ErDiagram
                tables={tables}
                relationships={relationships}
                readOnly={false}
                onRelationshipsChange={onRelationshipsChange}
                onPairSelect={(a, b) => setSelectedPair({ a, b })}
                hiddenRelations={hiddenRelations}
                onToggleRelations={onToggleRelations}
                arrangeNonce={arrangeNonce}
            />
            <div
                className="erd-ws-grip"
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize the relationships panel"
                onPointerDown={e => {
                    dragFrom.current = { x: e.clientX, w: sideWidth };
                    e.preventDefault();
                }}
            />
            <aside
                className="erd-ws-side"
                data-tour="erd-side"
                style={{ width: sideWidth, flexBasis: sideWidth }}
            >
                <div className="erd-ws-side-head">
                    Relationships <span>{visible.length}</span>
                </div>

                <div className="erd-ws-add">
                    <div className="erd-ws-add-row">
                        <select value={fromSel} onChange={e => setFromTable(e.target.value)}>
                            {tables.map(t => (
                                <option key={t.name} value={t.name}>
                                    {t.name}
                                </option>
                            ))}
                        </select>
                        <ColumnInput
                            value={fromCol}
                            columns={colsOf(fromSel)}
                            onChange={setFromCol}
                        />
                    </div>
                    <div className="erd-ws-add-arrow">
                        <ArrowRight size={13} />
                    </div>
                    <div className="erd-ws-add-row">
                        <select value={toSel} onChange={e => setToTable(e.target.value)}>
                            {tables.map(t => (
                                <option key={t.name} value={t.name}>
                                    {t.name}
                                </option>
                            ))}
                        </select>
                        <ColumnInput
                            value={toCol}
                            columns={colsOf(toSel)}
                            onChange={setToCol}
                        />
                    </div>
                    <button
                        className="erd-btn erd-ws-add-btn"
                        onClick={addManual}
                        disabled={!fromCol || !toCol}
                    >
                        <Plus size={13} /> Add relationship
                    </button>
                </div>

                {selectedPair ? (
                    <div className="erd-ws-filter">
                        Showing{' '}
                        <b>
                            {selectedPair.a} ↔ {selectedPair.b}
                        </b>
                        <button onClick={() => setSelectedPair(null)} aria-label="Clear filter">
                            <X size={12} /> Show all
                        </button>
                    </div>
                ) : (
                    <div className="erd-ws-hint">
                        Drag a table onto another to add a join; click a diagram link to filter.
                    </div>
                )}

                {visible.length === 0 ? (
                    <div className="erd-ws-empty-list">No relationships yet.</div>
                ) : (
                    <div className="erd-ws-groups">
                        {shownGroups.map(g => (
                            <div className="erd-ws-group" key={g.key}>
                                <div className="erd-ws-group-head">
                                    <span className="pair">
                                        {g.a} ↔ {g.b}
                                    </span>
                                    {/* A count of one is the default case and
                                        tells the reader nothing — the single
                                        row below already says as much. */}
                                    {g.rels.length > 1 ? (
                                        <span className="cnt">{g.rels.length}</span>
                                    ) : null}
                                    {onSaveJoins ? (
                                        <button
                                            type="button"
                                            className={`erd-ws-save${
                                                g.rels.every(r => savedJoinIds?.has(r.id))
                                                    ? ' erd-ws-save--on'
                                                    : ''
                                            }`}
                                            title={
                                                g.rels.every(r => savedJoinIds?.has(r.id))
                                                    ? 'Already in the join library'
                                                    : `Save ${g.a} ↔ ${g.b} to the join library`
                                            }
                                            aria-label="Save to the join library"
                                            onClick={() => onSaveJoins(g.rels)}
                                        >
                                            <Bookmark size={12} />
                                        </button>
                                    ) : null}
                                </div>
                                {g.rels.map(r => (
                                    <div className="erd-ws-rel-wrap" key={r.id}>
                                        <div className="erd-ws-rel">
                                            <code>
                                                {r.fromTable}.{r.fromColumn} → {r.toTable}.
                                                {r.toColumn}
                                            </code>
                                            {r.inferred && <span className="tag">inferred</span>}
                                            <button
                                                className="erd-ws-rel-rm"
                                                onClick={() =>
                                                    setQualifying(q => (q === r.id ? null : r.id))
                                                }
                                                title="Add a constant qualifier (e.g. source = 'RQ')"
                                                aria-label="Add a qualifier"
                                            >
                                                <Filter size={12} />
                                            </button>
                                            <button
                                                className="erd-ws-rel-rm"
                                                onClick={() => removeRel(r.id)}
                                                aria-label="Remove"
                                            >
                                                <Trash2 size={12} />
                                            </button>
                                        </div>

                                        {(r.qualifiers ?? []).map((q, i) => (
                                            <div className="erd-ws-qual" key={`${q.table}.${q.column}${i}`}>
                                                <code>AND {qualifierSql(q)}</code>
                                                <button
                                                    className="erd-ws-rel-rm"
                                                    onClick={() => removeQualifier(r, i)}
                                                    aria-label="Remove qualifier"
                                                >
                                                    <X size={11} />
                                                </button>
                                            </div>
                                        ))}

                                        {qualifying === r.id ? (
                                            <QualifierForm
                                                rel={r}
                                                tables={tables}
                                                onAdd={q => {
                                                    addQualifier(r, q);
                                                    setQualifying(null);
                                                }}
                                                onCancel={() => setQualifying(null)}
                                            />
                                        ) : null}
                                    </div>
                                ))}
                            </div>
                        ))}
                    </div>
                )}
            </aside>
        </div>
    );
}
