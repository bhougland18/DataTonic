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
import {
    sameSortKey,
    type ColumnTransform,
    type SelectedColumn,
    type SortColumn,
    type SortKey,
} from './builder-types';

export interface SortListProps {
    sort: SortColumn[];
    /** What may be sorted on — the columns the query selects. */
    columns: SelectedColumn[];
    /** And the computed ones, which are just as sortable and often the point:
     *  sorting by a total is the commonest thing anybody wants. */
    transforms: ColumnTransform[];
    onAdd: (key: SortKey) => void;
    onRemove: (index: number) => void;
    onChange: (index: number, patch: Partial<SortColumn>) => void;
    onMove: (from: number, to: number) => void;
}

export default function SortList({
    sort,
    columns,
    transforms,
    onAdd,
    onRemove,
    onChange,
    onMove,
}: SortListProps) {
    const [dragging, setDragging] = useState<number | null>(null);
    const [over, setOver] = useState<number | null>(null);

    const options: ColumnOption[] = [
        ...columns.map(c => ({ table: c.table, column: c.column })),
        // Shown by the name the person gave it, which is its only name.
        ...transforms.map(x => ({
            table: x.table ?? '',
            column: x.column ?? '',
            transformId: x.id,
            label: x.alias,
        })),
    ];
    // The first key not already used, so the add button starts somewhere useful
    // rather than on a duplicate that would be ignored.
    const keys: SortKey[] = [
        ...columns.map(c => ({ table: c.table, column: c.column })),
        ...transforms.map(x => ({
            table: x.table ?? '',
            column: x.column ?? '',
            transformId: x.id,
        })),
    ];
    const next = keys.find(k => !sort.some(s => sameSortKey(s, k)));

    return (
        <div className="blk-sortlist">
            <div className="blk-fgroup-head">
                <span className="blk-join-gap" />
                <button
                    type="button"
                    className="blk-lib-icon"
                    onClick={() => next && onAdd(next)}
                    disabled={!next}
                    title={
                        options.length === 0
                            ? 'Pick some columns first'
                            : next
                              ? 'Sort by another column'
                              : 'Everything the query selects is already a sort key'
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
                        value={
                            options.find(
                                o => s.transformId && o.transformId === s.transformId,
                            ) ?? { table: s.table, column: s.column }
                        }
                        options={options}
                        onChange={o =>
                            onChange(i, {
                                // Cleared when switching back to a source
                                // column, or the key would keep pointing at the
                                // transformation while the row showed otherwise.
                                transformId: o.transformId,
                                table: o.table,
                                column: o.column,
                            })
                        }
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
