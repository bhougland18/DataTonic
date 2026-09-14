// Blocks' source chrome for the builder panel: which database, and what is a
// file rather than a table in it.
//
// Everything else — search, the column picker, ordering, joins, where, grouping
// filter, the collapse rail — is `BuilderPanel`, which the SQL Studio node
// mounts too. This file is only the part that is true HERE and nowhere else.
//
// It replaces the Sources panel rather than sitting beside it, because the two
// answer different questions and only one of them is the SQL step's. Sources
// asks "which datasets go on the ER canvas" — a legibility choice about a
// diagram. The SQL step asks "what may I write after FROM", and the answer
// turns on reachability, not on what someone ticked to tidy a diagram.
//
// Which is why the listing is NOT filtered by the canvas selection: hiding a
// table from the query surface because it was unticked on the Schema step would
// let a decision about diagram clutter silently remove a table from SQL, with
// nothing on this step to put it back.
//
// The database switcher comes along because it has to. A query attaches exactly
// one database (the engine's `src.duckdb` prelude uses the fixed alias
// `duckle_src`), so the attached database decides what this panel can list —
// and the SQL step is where that choice actually bites. A node has no such
// choice, which is exactly why it lives here and not in `BuilderPanel`.

import { useMemo, type ReactNode } from 'react';
import { Database, FileText } from 'lucide-react';
import type { SqlStudioTable } from '../sqleditor/types';
import type { CatalogSelection } from '../sqleditor/TableCatalog';
import { ATTACH_ALIAS, type DatabaseGroup } from './sources';
import type { ErdRelationship } from '../erd/model';
import BuilderPanel, { type CatalogGroup } from './BuilderPanel';
import type { JoinMode } from './builder-types';

export interface SqlCatalogPanelProps {
    /** Tables the current query can read, each carrying its FROM address. */
    tables: SqlStudioTable[];
    /** Real datasets that are not readable from here — another database, or no
     *  composable read at all. Listed muted, with the reason. */
    unreachable: { table: SqlStudioTable; reason: string }[];
    groups: DatabaseGroup[];
    activeDb: string | null;
    onSelectDb: (dbPath: string) => void;
    /** The ER model, offered as one-click joins under the tables. */
    relationships: ErdRelationship[];
    sql: string;
    onChangeSql: (next: string) => void;
    /** Present only in builder mode — turns the catalog into a column picker. */
    selectionFor?: (table: SqlStudioTable) => CatalogSelection;
    /** The selected-columns list, rendered between tables and joins. */
    selected?: ReactNode;
    /** How many columns are selected, for the section's badge. */
    selectedCount?: number;
    /** The WHERE rows, and how many are switched on. */
    filters?: ReactNode;
    filterCount?: number;
    /** The HAVING rows — present only once something is aggregated. */
    having?: ReactNode;
    havingCount?: number;
    /** Builder mode: which joins are in the query, and how to change them. */
    activeJoins?: Map<string, JoinMode>;
    onSetJoinMode?: (relationshipId: string, mode: JoinMode) => void;
    onAddJoinTable?: (relationship: ErdRelationship) => void;
    /** Why each table is in the query — shown as a tag on the join. */
    reasonFor?: (table: string) => string;
    /** Routes the person ruled out, and how to rule one out or put it back. */
    excludedJoins?: Set<string>;
    onExcludeJoin?: (relationshipId: string) => void;
    onRestoreJoin?: (relationshipId: string) => void;
    canExcludeJoin?: (relationshipId: string) => boolean;
}

export default function SqlCatalogPanel({
    tables,
    groups,
    activeDb,
    onSelectDb,
    ...rest
}: SqlCatalogPanelProps) {
    const activeName = groups.find(g => g.dbPath === activeDb)?.name ?? null;

    // A parquet/csv/json dataset is read inline, not out of the attached
    // database, so listing it under the database's name said something untrue:
    // `item_norm.parquet` is not a table in `infor.duckdb`. The address is what
    // decides — anything addressed through the attach alias lives in the
    // database, anything else is a file read where it sits.
    const catalogGroups = useMemo((): CatalogGroup[] => {
        const inDatabase = (t: SqlStudioTable) => !!t.from?.startsWith(`${ATTACH_ALIAS}.`);
        const dbTables = tables.filter(inDatabase);
        const fileTables = tables.filter(t => !inDatabase(t));
        const out: CatalogGroup[] = [];

        if (dbTables.length > 0 || groups.length > 0) {
            out.push({
                id: 'database',
                tables: dbTables,
                // The switcher stays put when a search matches nothing here:
                // being pointed at the wrong database is a common reason for no
                // matches, and it is the control that fixes it.
                alwaysShow: true,
                header: (
                    // One database at a time, so this is a choice and not a
                    // label. A single group still names itself: "which database
                    // am I querying" is the first thing to check when a table is
                    // missing.
                    <div className="blk-catalog-db" title="The database this query attaches">
                        <Database size={13} strokeWidth={1.75} />
                        {groups.length > 1 ? (
                            <select
                                value={activeDb ?? ''}
                                onChange={e => onSelectDb(e.target.value)}
                                aria-label="Database this query attaches"
                            >
                                {groups.map(g => (
                                    <option key={g.dbPath} value={g.dbPath}>
                                        {g.name}
                                    </option>
                                ))}
                            </select>
                        ) : (
                            <span className="blk-catalog-db-name">
                                {activeName ?? 'no database'}
                            </span>
                        )}
                    </div>
                ),
            });
        }

        if (fileTables.length > 0) {
            out.push({
                id: 'files',
                tables: fileTables,
                header: (
                    <div
                        className="blk-catalog-db blk-catalog-db--files"
                        title="Read in place, not through the attached database"
                    >
                        <FileText size={13} strokeWidth={1.75} />
                        <span className="blk-catalog-db-name">Files</span>
                    </div>
                ),
            });
        }
        return out;
    }, [tables, groups, activeDb, activeName, onSelectDb]);

    return (
        <BuilderPanel
            {...rest}
            groups={catalogGroups}
            emptyHint="No durable datasets yet. Run a pipeline that writes one, then rescan."
        />
    );
}
