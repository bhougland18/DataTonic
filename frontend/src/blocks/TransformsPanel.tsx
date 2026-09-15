// The computed columns, as a list you can read back.
//
// Rows, not chips — the same reason the Sort and Filter lists are rows: height
// has to follow the number of TRANSFORMATIONS, which is small, rather than the
// number of columns, which is not. A chip per computed column reads well with
// four and becomes a wall at forty.
//
// Each row says what the column IS, in the order somebody would say it out
// loud: the name they gave it, then what it was built from. The name leads
// because that is what they will look for; the source is how they tell two
// similar ones apart — the same reasoning `SelectedColumns` uses for dimming
// the table name.

import { useState } from 'react';
import { Pencil, Plus, X } from 'lucide-react';
import TransformDialog from './TransformDialog';
import type { ColumnTransform } from './builder-types';
import { opById, transformExpression, transformIsComplete } from './transform-ops';
import type { SqlStudioTable } from '../sqleditor/types';

export interface TransformsPanelProps {
    transforms: ColumnTransform[];
    /** Source columns the dialog can pick from. */
    tables: SqlStudioTable[];
    onUpsert: (transform: ColumnTransform) => void;
    onRemove: (id: string) => void;
    onToggle: (id: string, enabled: boolean) => void;
}

export default function TransformsPanel({
    transforms,
    tables,
    onUpsert,
    onRemove,
    onToggle,
}: TransformsPanelProps) {
    // The dialog lives HERE rather than in each host. It is pure UI state with
    // no bearing on the query, and putting it in the two hosts would be two
    // copies of the same wiring — which is exactly how the builder drifted
    // apart before it was shared (handoff §2).
    //
    // `null` is closed. An OBJECT with no `transform` means "creating", which a
    // bare null could not tell apart from closed.
    const [editing, setEditing] = useState<{ transform?: ColumnTransform } | null>(null);

    return (
        <div className="blk-xforms">
            {transforms.map(t => {
                const expr = transformExpression(t);
                // Incomplete means it will be DROPPED from the SQL, not that it
                // will fail. Marked for the same reason a half-built filter rule
                // is: a silent no-op is something somebody hunts for later.
                const incomplete = !transformIsComplete(t);
                return (
                    <div
                        key={t.id}
                        className={`blk-xform${incomplete ? ' blk-xform--incomplete' : ''}`}
                        title={expr ?? 'This operation is no longer available'}
                    >
                        <input
                            type="checkbox"
                            className="sqlstudio-tick"
                            checked={t.enabled !== false}
                            onChange={e => onToggle(t.id, e.target.checked)}
                            title={t.enabled === false ? 'Switched off' : 'In the query'}
                            aria-label={`Include ${t.alias || 'this column'}`}
                        />
                        <button
                            type="button"
                            className="blk-xform-main"
                            onClick={() => setEditing({ transform: t })}
                            title={expr ?? 'Edit this column'}
                        >
                            <span className="blk-xform-name">
                                {t.alias || <i>unnamed</i>}
                            </span>
                            <span className="blk-xform-from">
                                {opById(t.op)?.label ?? (t.op || '—')}
                                {t.table && t.column ? (
                                    <>
                                        {' '}
                                        <i>
                                            {t.table}.{t.column}
                                        </i>
                                    </>
                                ) : null}
                            </span>
                        </button>
                        <button
                            type="button"
                            className="blk-lib-icon"
                            onClick={() => setEditing({ transform: t })}
                            title="Edit this column"
                            aria-label={`Edit ${t.alias || 'column'}`}
                        >
                            <Pencil size={12} />
                        </button>
                        <button
                            type="button"
                            className="blk-lib-icon"
                            onClick={() => onRemove(t.id)}
                            title="Remove this column"
                            aria-label={`Remove ${t.alias || 'column'}`}
                        >
                            <X size={12} />
                        </button>
                    </div>
                );
            })}
            <button
                type="button"
                className="blk-xform-add"
                onClick={() => setEditing({})}
            >
                <Plus size={13} />
                <span>New column</span>
            </button>
            {transforms.length === 0 ? (
                <p className="blk-xform-empty">
                    Totals, dates, labels — anything the source columns do not
                    already say.
                </p>
            ) : null}
            {editing ? (
                <TransformDialog
                    initial={editing.transform}
                    tables={tables}
                    onSubmit={next => {
                        onUpsert(next);
                        setEditing(null);
                    }}
                    onCancel={() => setEditing(null)}
                />
            ) : null}
        </div>
    );
}
