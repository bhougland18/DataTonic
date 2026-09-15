// ORDER BY, as rows rather than as a gallery.
//
// Shaped like the filter list and for the same reason: a section whose height
// grows with the number of COLUMNS is unusable on a real table. Offering every
// selected column as its own chip read well with four and became a wall with
// forty. A row per sort key, with a searchable picker in it, costs the same
// whether the query has four columns or four hundred.
//
// Without the filter list's groups or AND/OR: ORDER BY is a flat, ordered list
// of keys. There is nothing to nest and nothing to combine.
//
// Priority is why the rows drag. ORDER BY is POSITIONAL — the first key decides
// and later ones only break its ties — so "vendor then date" and "date then
// vendor" answer different questions. The rank badge says which is which.
//
// Not the same as Column Ordering above it, which sets the order columns come
// back in. One is about rows, the other about columns; they sit together
// because that is exactly what gets confused, so each says what it is.

import { useState } from 'react';
import { ArrowDown, ArrowUp, GripVertical, Plus, Trash2 } from 'lucide-react';
import ColumnPicker, { type ColumnOption } from './ColumnPicker';
import type { SelectedColumn, SortColumn } from './builder-types';

export interface SortListProps {
    sort: SortColumn[];
    /** What may be sorted on — the columns the query selects. */
    columns: SelectedColumn[];
    onAdd: (table: string, column: string) => void;
    onRemove: (index: number) => void;
    onChange: (index: number, patch: Partial<SortColumn>) => void;
    onMove: (from: number, to: number) => void;
}

const same = (a: { table: string; column: string }, b: { table: string; column: string }) =>
    a.table.toLowerCase() === b.table.toLowerCase() &&
    a.column.toLowerCase() === b.column.toLowerCase();

export default function SortList({
    sort,
    columns,
    onAdd,
    onRemove,
    onChange,
    onMove,
}: SortListProps) {
    const [dragging, setDragging] = useState<number | null>(null);
    const [over, setOver] = useState<number | null>(null);

    const options: ColumnOption[] = columns.map(c => ({ table: c.table, column: c.column }));
    // The first column not already a key, so the add button starts somewhere
    // useful rather than on a duplicate that would be ignored.
    const next = columns.find(c => !sort.some(s => same(s, c)));

    return (
        <div className="blk-sortlist">
            <div className="blk-fgroup-head">
                <span className="blk-join-gap" />
                <button
                    type="button"
                    className="blk-lib-icon"
                    onClick={() => next && onAdd(next.table, next.column)}
                    disabled={!next}
                    title={
                        columns.length === 0
                            ? 'Pick some columns first'
                            : next
                              ? 'Sort by another column'
                              : 'Every selected column is already a sort key'
                    }
                >
                    <Plus size={13} />
                </button>
            </div>

            {sort.length === 0 ? (
                <p className="blk-lib-hint">
                    No sort. Rows come back in whatever order the database finds them.
                </p>
            ) : null}

            {sort.map((s, i) => (
                <div
                    key={`${s.table}.${s.column}`}
                    className={`blk-sort${over === i && dragging !== i ? ' blk-sort--over' : ''}${
                        dragging === i ? ' blk-sort--dragging' : ''
                    }`}
                    onDragOver={e => {
                        e.preventDefault();
                        setOver(i);
                    }}
                    onDrop={e => {
                        e.preventDefault();
                        if (dragging != null && dragging !== i) onMove(dragging, i);
                        setDragging(null);
                        setOver(null);
                    }}
                >
                    {/* Only the grip drags, not the whole row — the row holds a
                        text input, and a draggable parent eats the drag that
                        selects text inside it. */}
                    <span
                        className="blk-sort-grip"
                        draggable
                        onDragStart={() => setDragging(i)}
                        onDragEnd={() => {
                            setDragging(null);
                            setOver(null);
                        }}
                        title="Drag to change which key decides first"
                    >
                        <GripVertical size={12} />
                    </span>
                    <span className="blk-sort-rank">{i + 1}</span>
                    <ColumnPicker
                        value={{ table: s.table, column: s.column }}
                        options={options}
                        onChange={o => onChange(i, { table: o.table, column: o.column })}
                    />
                    <button
                        type="button"
                        className="blk-sort-dir"
                        onClick={() => onChange(i, { dir: s.dir === 'asc' ? 'desc' : 'asc' })}
                        title={
                            s.dir === 'asc'
                                ? 'Smallest first. Click for largest first.'
                                : 'Largest first. Click for smallest first.'
                        }
                        aria-label={s.dir === 'asc' ? 'Ascending' : 'Descending'}
                    >
                        {s.dir === 'asc' ? <ArrowUp size={13} /> : <ArrowDown size={13} />}
                    </button>
                    <button
                        type="button"
                        className="blk-lib-icon"
                        onClick={() => onRemove(i)}
                        title="Stop sorting by this column"
                        aria-label="Remove this sort key"
                    >
                        <Trash2 size={12} />
                    </button>
                </div>
            ))}
        </div>
    );
}
