// The SELECT list, in order, as a thing you can rearrange.
//
// Two jobs the catalog tree cannot do. It answers "what have I picked?" at a
// glance — the tree scatters ticks across collapsed tables, so with five
// sources the selection is invisible. And it makes ORDER editable.
//
// Order matters more than it looks: the order of the columns IS the order of
// the output, and needing to switch the builder off to move one would turn the
// toggle from a choice into a workaround. Reordering is a builder operation, so
// it belongs to the builder.

import { useState } from 'react';
import { GripVertical, X } from 'lucide-react';
import type { SelectedColumn } from './builder-types';

export interface SelectedColumnsProps {
    columns: SelectedColumn[];
    onMove: (from: number, to: number) => void;
    onRemove: (column: SelectedColumn) => void;
}

export default function SelectedColumns({ columns, onMove, onRemove }: SelectedColumnsProps) {
    const [dragging, setDragging] = useState<number | null>(null);
    const [over, setOver] = useState<number | null>(null);

    if (columns.length === 0) return null;

    return (
        <div className="blk-selcols">
            {columns.map((c, i) => (
                <div
                    key={`${c.table}.${c.column}`}
                    className={`blk-selcol${over === i && dragging !== i ? ' blk-selcol--over' : ''}${
                        dragging === i ? ' blk-selcol--dragging' : ''
                    }`}
                    draggable
                    onDragStart={() => setDragging(i)}
                    onDragEnd={() => {
                        setDragging(null);
                        setOver(null);
                    }}
                    onDragOver={e => {
                        e.preventDefault();
                        setOver(i);
                    }}
                    onDrop={e => {
                        e.preventDefault();
                        if (dragging !== null) onMove(dragging, i);
                        setDragging(null);
                        setOver(null);
                    }}
                    title={`${c.table}.${c.column}`}
                >
                    <GripVertical size={13} className="blk-selcol-grip" />
                    <span className="blk-selcol-name">
                        {/* The table is dimmed, the column is not: the column is
                            what you are looking for, the table is how you tell
                            two columns of the same name apart. */}
                        <i>{c.table}.</i>
                        {c.column}
                    </span>
                    {c.aggregate && c.aggregate !== 'none' ? (
                        <em className="blk-selcol-agg">{c.aggregate}</em>
                    ) : null}
                    <button
                        type="button"
                        className="blk-lib-icon"
                        onClick={() => onRemove(c)}
                        title="Remove from the query"
                        aria-label={`Remove ${c.table}.${c.column}`}
                    >
                        <X size={12} />
                    </button>
                </div>
            ))}
        </div>
    );
}
