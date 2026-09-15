// The table → column tree, shared by both SQL surfaces.
//
// Extracted from `SqlEditor` when Blocks grew a SQL step, on the same principle
// as `erd/ErdAuthoring`: the two surfaces should *share* the catalog rather than
// resemble it, so a fix to the tree reaches the node Studio and Blocks alike.
//
// Only the row is shared, not the list. The node Studio's catalog is one flat
// set — everything in the working DB is readable by name — whereas Blocks has
// to group by whether a dataset is reachable from the attached database at all.
// A shared list would have to model that distinction for a surface that does
// not have it.

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Table2 } from 'lucide-react';
import type { SqlStudioTable } from './types';

/**
 * Turning the catalog into a picker.
 *
 * Optional, so the node's SQL Studio — which has no builder — gets exactly the
 * read-only tree it had before. When present, every row grows a checkbox.
 *
 * A checkbox and nothing else, deliberately. This tree answers WHICH COLUMNS;
 * what they become is Column Transformations' question, and for a while this
 * row answered both — an aggregate dropdown, then a date bucket beside it — in
 * a list that scrolls past several hundred entries. Anything tempted back in
 * here belongs there instead.
 */
export interface CatalogSelection {
    /** Is this column in the query? */
    isSelected: (column: string) => boolean;
    onToggle: (column: string) => void;
    /** The table-level checkbox: tick or clear every column. */
    onToggleAll: () => void;
    /** Off when the ER model cannot connect this table to the query. */
    reachable?: boolean;
}

export interface CatalogTableProps {
    table: SqlStudioTable;
    /** Start expanded. Defaults to true for the `input` relation, which is the
     *  one a node's SQL almost certainly references. */
    defaultOpen?: boolean;
    /** Dimmed, for a table that exists but cannot be read from here. */
    muted?: boolean;
    selection?: CatalogSelection;
}

export default function CatalogTable({
    table,
    defaultOpen,
    muted,
    selection,
}: CatalogTableProps) {
    const [open, setOpen] = useState(defaultOpen ?? table.kind === 'input');
    const unreachable = selection?.reachable === false;
    const picked = selection ? table.columns.filter(c => selection.isSelected(c.name)).length : 0;
    const all = picked > 0 && picked === table.columns.length;
    // Some but not all: the box says "partly", which is the true answer and
    // stops the table checkbox looking like it lost the individual ticks.
    const someRef = useRef<HTMLInputElement>(null);
    useEffect(() => {
        if (someRef.current) someRef.current.indeterminate = picked > 0 && !all;
    }, [picked, all]);
    return (
        <div
            className={`sqlstudio-tnode-wrap${muted ? ' sqlstudio-tnode-wrap--muted' : ''}${
                unreachable ? ' sqlstudio-tnode-wrap--unreachable' : ''
            }`}
        >
            <div className="sqlstudio-tnode-row">
                {selection ? (
                    <input
                        ref={someRef}
                        type="checkbox"
                        className="sqlstudio-tick"
                        checked={all}
                        disabled={unreachable}
                        onChange={() => selection.onToggleAll()}
                        title={
                            unreachable
                                ? `No relationship connects ${table.name} to this query`
                                : all
                                  ? `Clear all ${table.name} columns`
                                  : `Select all ${table.name} columns`
                        }
                        aria-label={`All columns from ${table.name}`}
                    />
                ) : null}
                <button className="sqlstudio-tnode" onClick={() => setOpen(o => !o)}>
                    {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    <Table2 size={13} className="sqlstudio-tbl-icon" />
                    <span className="nm">{table.name}</span>
                    {table.kind === 'input' && <span className="tag">input</span>}
                    <span className="ct">{table.columns.length}</span>
                </button>
            </div>
            {/* The address, when it is not simply the name. In a node the table
                IS what you write after FROM; above the graph it is not — the
                query reads `"duckle_src"."Item"` or a parquet path — and a
                catalog that showed only the name would be listing something the
                SQL cannot actually say. */}
            {table.from && table.from !== table.name ? (
                <code className="sqlstudio-tfrom" title={`FROM ${table.from}`}>
                    {table.from}
                </code>
            ) : null}
            {open && (
                <div className="sqlstudio-cols">
                    {table.columns.map(c => {
                        const ticked = selection?.isSelected(c.name) ?? false;
                        return (
                            <div className="sqlstudio-col" key={c.name}>
                                {selection ? (
                                    <input
                                        type="checkbox"
                                        className="sqlstudio-tick"
                                        checked={ticked}
                                        disabled={unreachable}
                                        onChange={() => selection.onToggle(c.name)}
                                        aria-label={`${table.name}.${c.name}`}
                                    />
                                ) : null}
                                <span className="cn">{c.name}</span>
                                {c.primaryKey && <span className="pk">PK</span>}
                                {/* The TYPE is back, and now it earns its place.
                                    It was dropped when this row carried an
                                    aggregate dropdown, on the grounds that every
                                    column was VARCHAR so the type distinguished
                                    nothing. Both halves of that have changed:
                                    columns are properly typed since 2af12706,
                                    and the controls have moved to Column
                                    Transformations - so the space is free and
                                    the type is the thing that tells you what you
                                    can DO with the column. */}
                                {c.type && <span className="ty">{c.type}</span>}
                            </div>
                        );
                    })}
                    {table.columns.length === 0 && (
                        <div className="sqlstudio-col sqlstudio-col--empty">schema unknown</div>
                    )}
                </div>
            )}
        </div>
    );
}
