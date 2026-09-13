// The ER model's joins, as one-click SQL.
//
// Sits under the tables in the SQL step's panel because it is the same
// question one level up: the tables say what you may read, this says how they
// connect. Both answers come from work already done — the catalog from the
// probe, these from the Schema step — so neither is something to retype.
//
// Every join is shown, including ones whose edges are hidden on the diagram:
// hiding is a legibility choice about a picture, and a join you chose not to
// look at is still a join you may want to write.

import { useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, Equal, Plus } from 'lucide-react';
import { joinSql, type ErdRelationship } from '../erd/model';
import type { SqlStudioTable } from '../sqleditor/types';
import { insertJoin, type JoinMode } from './join-insert';

export interface JoinsListProps {
    relationships: ErdRelationship[];
    /** The readable tables, for addresses. */
    tables: SqlStudioTable[];
    /** The editor's current SQL — decides what a join can anchor to. */
    sql: string;
    onChangeSql: (next: string) => void;
    /**
     * Builder mode: which relationships the query is actually using, and how.
     *
     * When present the list stops being a set of things you could insert and
     * becomes a readout of the joins in play — so the direction control is the
     * live setting rather than a staging choice, and changing it changes the
     * query.
     */
    active?: Map<string, JoinMode>;
    onSetMode?: (relationshipId: string, mode: JoinMode) => void;
    /** Builder mode: bring this relationship's tables into the query. */
    onAddTable?: (relationship: ErdRelationship) => void;
    /** Why each table is in the query, so a join nobody asked for says so. */
    reasonFor?: (table: string) => string;
}

/** Short labels; `column` and `anchor` need none — those are the expected case. */
const REASON_LABEL: Record<string, { text: string; title: string }> = {
    filter: { text: 'filter', title: 'Here because a filter names this table' },
    added: { text: 'added', title: 'Added from this list, without selecting columns' },
    route: {
        text: 'route',
        title: 'Not asked for — it is on the path between two tables that were',
    },
};

/**
 * The three directions, in the order clicking cycles them.
 *
 * `=` for inner rather than `-`: a dash between two names reads as a delete
 * affordance, and the control is nothing of the kind. `=` also says the right
 * thing — the join keeps rows that match on both sides.
 */
const MODES: { mode: JoinMode; Icon: typeof Equal; hint: (a: string, b: string) => string }[] = [
    { mode: 'inner', Icon: Equal, hint: (a, b) => `only rows matching in both ${a} and ${b}` },
    { mode: 'keep-from', Icon: ArrowRight, hint: a => `every ${a} row, matched or not` },
    { mode: 'keep-to', Icon: ArrowLeft, hint: (_a, b) => `every ${b} row, matched or not` },
];

function ReasonTag({ reason }: { reason?: string }) {
    const spec = reason ? REASON_LABEL[reason] : undefined;
    if (!spec) return null;
    return (
        <em className="blk-join-why" title={spec.title}>
            {spec.text}
        </em>
    );
}

export default function JoinsList({
    relationships,
    tables,
    sql,
    onChangeSql,
    active,
    onSetMode,
    onAddTable,
    reasonFor,
}: JoinsListProps) {
    // Direction per relationship, defaulting to inner. Held here rather than on
    // the model: it is a choice about the query being written now, not a fact
    // about how the tables relate, and saving it would make one query's shape
    // look like a property of the schema.
    const [modes, setModes] = useState<Record<string, JoinMode>>({});

    // Only joins whose BOTH sides are readable. A row that inserts SQL naming a
    // table this query cannot reach is an offer that always fails.
    const readable = useMemo(() => new Set(tables.map(t => t.name.toLowerCase())), [tables]);
    const usable = useMemo(
        () =>
            relationships.filter(
                r =>
                    readable.has(r.fromTable.toLowerCase()) &&
                    readable.has(r.toTable.toLowerCase()),
            ),
        [relationships, readable],
    );
    const hidden = relationships.length - usable.length;

    if (relationships.length === 0) return null;

    return (
        <div className="blk-joins">
            {usable.map(r => {
                // In builder mode the query owns the mode; otherwise it is a
                // staging choice this list keeps for the next insert.
                const inUse = active?.has(r.id) ?? false;
                const mode = active?.get(r.id) ?? modes[r.id] ?? 'inner';
                const spec = MODES.find(m => m.mode === mode) ?? MODES[0];
                const result = insertJoin(sql, r, mode, tables);
                const blocked = result.kind === 'blocked' ? result.reason : null;
                return (
                    <div
                        className={`blk-join${inUse ? ' blk-join--active' : ''}`}
                        key={r.id}
                        title={`ON ${joinSql(r)}`}
                    >
                        {/* The direction sits BETWEEN the two names, where it
                            reads as the relation between them. On the left it
                            read as a control acting on the row — next to a list
                            entry, a dash or an arrow looks like "remove". */}
                        <div className="blk-join-main">
                            <b title={r.fromTable}>{r.fromTable}</b>
                            <ReasonTag reason={inUse ? reasonFor?.(r.fromTable) : undefined} />
                            <button
                                type="button"
                                className={`blk-join-dir${inUse ? ' blk-join-dir--active' : ''}`}
                                title={`Keeps ${spec.hint(r.fromTable, r.toTable)}. Click to change.`}
                                onClick={() => {
                                    const i = MODES.findIndex(x => x.mode === mode);
                                    const next = MODES[(i + 1) % MODES.length].mode;
                                    // A join in the query changes the query; one
                                    // that is not yet in it just changes what the
                                    // next insert would do.
                                    if (inUse && onSetMode) onSetMode(r.id, next);
                                    else setModes(m => ({ ...m, [r.id]: next }));
                                }}
                            >
                                <spec.Icon size={17} strokeWidth={2.75} />
                            </button>
                            <b title={r.toTable}>{r.toTable}</b>
                            <ReasonTag reason={inUse ? reasonFor?.(r.toTable) : undefined} />
                            {r.qualifiers?.length ? (
                                <em title="This join carries a qualifier, added to the ON clause">
                                    +{r.qualifiers.length}
                                </em>
                            ) : null}
                            <span className="blk-join-gap" />
                            <button
                                type="button"
                                className="blk-join-add"
                                // In builder mode the join is already implied by
                                // the columns; ＋ is only for bringing in a table
                                // to FILTER on without selecting from it, so it
                                // is offered exactly when the join is not in use.
                                disabled={onAddTable ? inUse : !!blocked}
                                // The reason is the whole value when it is
                                // refused — a greyed button with no explanation
                                // reads as broken.
                                title={
                                    onAddTable
                                        ? inUse
                                            ? 'Already in the query'
                                            : 'Bring these tables in so you can filter on them'
                                        : (blocked ?? 'Add this join to the query')
                                }
                                onClick={() => {
                                    if (onAddTable) return onAddTable(r);
                                    if (result.kind !== 'blocked') onChangeSql(result.sql);
                                }}
                            >
                                <Plus size={17} strokeWidth={2.5} />
                            </button>
                        </div>
                    </div>
                );
            })}

            {hidden > 0 ? (
                <p className="blk-joins-note">
                    {hidden} more join{hidden === 1 ? '' : 's'} touch a table this query cannot
                    read.
                </p>
            ) : null}
        </div>
    );
}
