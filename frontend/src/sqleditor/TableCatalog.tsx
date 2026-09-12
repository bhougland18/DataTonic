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

import { useState } from 'react';
import { ChevronDown, ChevronRight, Table2 } from 'lucide-react';
import type { SqlStudioTable } from './types';

export interface CatalogTableProps {
    table: SqlStudioTable;
    /** Start expanded. Defaults to true for the `input` relation, which is the
     *  one a node's SQL almost certainly references. */
    defaultOpen?: boolean;
    /** Dimmed, for a table that exists but cannot be read from here. */
    muted?: boolean;
}

export default function CatalogTable({ table, defaultOpen, muted }: CatalogTableProps) {
    const [open, setOpen] = useState(defaultOpen ?? table.kind === 'input');
    return (
        <div className={`sqlstudio-tnode-wrap${muted ? ' sqlstudio-tnode-wrap--muted' : ''}`}>
            <button className="sqlstudio-tnode" onClick={() => setOpen(o => !o)}>
                {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                <Table2 size={13} className="sqlstudio-tbl-icon" />
                <span className="nm">{table.name}</span>
                {table.kind === 'input' && <span className="tag">input</span>}
                <span className="ct">{table.columns.length}</span>
            </button>
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
                    {table.columns.map(c => (
                        <div className="sqlstudio-col" key={c.name}>
                            <span className="cn">{c.name}</span>
                            {c.primaryKey && <span className="pk">PK</span>}
                            {c.type && <span className="ty">{c.type}</span>}
                        </div>
                    ))}
                    {table.columns.length === 0 && (
                        <div className="sqlstudio-col sqlstudio-col--empty">schema unknown</div>
                    )}
                </div>
            )}
        </div>
    );
}
