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
}

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

export default function JoinsList({ relationships, tables, sql, onChangeSql }: JoinsListProps) {
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
        <section className="blk-joins">
            <header className="blk-joins-head">
                Joins <span>{usable.length}</span>
            </header>

            {usable.map(r => {
                const mode = modes[r.id] ?? 'inner';
                const spec = MODES.find(m => m.mode === mode) ?? MODES[0];
                const result = insertJoin(sql, r, mode, tables);
                const blocked = result.kind === 'blocked' ? result.reason : null;
                return (
                    <div className="blk-join" key={r.id} title={`ON ${joinSql(r)}`}>
                        {/* The direction sits BETWEEN the two names, where it
                            reads as the relation between them. On the left it
                            read as a control acting on the row — next to a list
                            entry, a dash or an arrow looks like "remove". */}
                        <div className="blk-join-main">
                            <b title={r.fromTable}>{r.fromTable}</b>
                            <button
                                type="button"
                                className="blk-join-dir"
                                title={`Keeps ${spec.hint(r.fromTable, r.toTable)}. Click to change.`}
                                onClick={() =>
                                    setModes(m => {
                                        const i = MODES.findIndex(
                                            x => x.mode === (m[r.id] ?? 'inner'),
                                        );
                                        return { ...m, [r.id]: MODES[(i + 1) % MODES.length].mode };
                                    })
                                }
                            >
                                <spec.Icon size={17} strokeWidth={2.75} />
                            </button>
                            <b title={r.toTable}>{r.toTable}</b>
                            {r.qualifiers?.length ? (
                                <em title="This join carries a qualifier, added to the ON clause">
                                    +{r.qualifiers.length}
                                </em>
                            ) : null}
                            <span className="blk-join-gap" />
                            <button
                                type="button"
                                className="blk-join-add"
                                disabled={!!blocked}
                                // The reason is the whole value when it is
                                // refused — a greyed button with no explanation
                                // reads as broken.
                                title={blocked ?? 'Add this join to the query'}
                                onClick={() => result.kind !== 'blocked' && onChangeSql(result.sql)}
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
        </section>
    );
}
