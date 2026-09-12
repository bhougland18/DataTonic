// The SQL step's left panel: the tables and fields a query can actually read.
//
// It replaces the Sources panel rather than sitting beside it, because the two
// answer different questions and only one of them is the SQL step's. Sources
// asks "which datasets go on the ER canvas" — a legibility choice about a
// diagram. The SQL step asks "what may I write after FROM", and the answer
// turns on reachability, not on what someone ticked to tidy a diagram.
//
// Which is why the listing is NOT filtered by the canvas selection: hiding a
// table from the query surface because it was unticked on the Schema step
// would let a decision about diagram clutter silently remove a table from SQL,
// with nothing on this step to put it back.
//
// The database switcher comes along because it has to. A query attaches exactly
// one database (the engine's `src.duckdb` prelude uses the fixed alias
// `duckle_src`), so the attached database decides what this panel can list —
// and the SQL step is where that choice actually bites.

import { useMemo, useState } from 'react';
import { Database, FileText, Layers, Search } from 'lucide-react';
import CatalogTable from '../sqleditor/TableCatalog';
import type { SqlStudioTable } from '../sqleditor/types';
import { ATTACH_ALIAS, type DatabaseGroup } from './sources';
import type { ErdRelationship } from '../erd/model';
import JoinsList from './JoinsList';

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
}

export default function SqlCatalogPanel({
    tables,
    unreachable,
    groups,
    activeDb,
    onSelectDb,
    relationships,
    sql,
    onChangeSql,
}: SqlCatalogPanelProps) {
    const activeName = groups.find(g => g.dbPath === activeDb)?.name ?? null;
    const [query, setQuery] = useState('');

    // Filters on COLUMN names as well as table names, because the question that
    // sends you to a catalog is at least as often "which table has VendorName"
    // as "where is Vendor". A table matched only by a column still appears — its
    // columns are one click away.
    const match = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return null;
        return (t: SqlStudioTable) =>
            t.name.toLowerCase().includes(q) ||
            t.columns.some(c => c.name.toLowerCase().includes(q));
    }, [query]);
    const shownTables = match ? tables.filter(match) : tables;
    const shownUnreachable = match ? unreachable.filter(u => match(u.table)) : unreachable;

    // A parquet/csv/json dataset is read inline, not out of the attached
    // database, so listing it under the database's name said something untrue:
    // `item_norm.parquet` is not a table in `infor.duckdb`. The address is what
    // decides — anything addressed through the attach alias lives in the
    // database, anything else is a file read where it sits.
    const inDatabase = (t: SqlStudioTable) => !!t.from?.startsWith(`${ATTACH_ALIAS}.`);
    const dbTables = shownTables.filter(inDatabase);
    const fileTables = shownTables.filter(t => !inDatabase(t));

    return (
        <aside className="blk-catalog">
            <div className="blk-sources-head">
                Tables
                <span>
                    {tables.length} readable
                    {unreachable.length > 0 ? ` · ${unreachable.length} not` : ''}
                </span>
            </div>

            {/* Above the database, because it searches everything below it —
                both the database's tables and the loose files. Sitting under
                the database name made it look like it searched only that. */}
            <label className="blk-lib-search">
                <Search size={12} />
                <input
                    value={query}
                    placeholder="Search tables, columns…"
                    onChange={e => setQuery(e.target.value)}
                />
            </label>

            <div className="blk-catalog-list">
                {dbTables.length > 0 || groups.length > 0 ? (
                    <>
                        {/* One database at a time, so this is a choice and not a
                            label. A single group still names itself: "which
                            database am I querying" is the first thing to check
                            when a table is missing. */}
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
                        {dbTables.map(t => (
                            <CatalogTable key={t.name} table={t} />
                        ))}
                    </>
                ) : null}

                {fileTables.length > 0 ? (
                    <>
                        <div className="blk-catalog-db blk-catalog-db--files" title="Read in place, not through the attached database">
                            <FileText size={13} strokeWidth={1.75} />
                            <span className="blk-catalog-db-name">Files</span>
                        </div>
                        {fileTables.map(t => (
                            <CatalogTable key={t.name} table={t} />
                        ))}
                    </>
                ) : null}

                {shownUnreachable.length > 0 ? (
                    <section className="blk-catalog-off">
                        <header>Not readable here</header>
                        {shownUnreachable.map(({ table, reason }) => (
                            <div key={table.name} title={reason}>
                                <CatalogTable table={table} muted />
                                <span className="blk-catalog-why">{reason}</span>
                            </div>
                        ))}
                    </section>
                ) : null}

                {shownTables.length === 0 && shownUnreachable.length === 0 ? (
                    <div className="blk-src-empty">
                        <Layers size={14} />
                        <span>
                            {match
                                ? `Nothing matches “${query.trim()}”.`
                                : 'No durable datasets yet. Run a pipeline that writes one, then rescan.'}
                        </span>
                    </div>
                ) : null}
            </div>

            {/* The joins are a SIBLING of the table list, not the last thing
                inside it. Sharing one scroll meant a workspace with a dozen
                tables pushed them off the bottom — and they are most useful
                exactly when there are many tables to connect. Each region now
                scrolls on its own, and the joins keep their share of the
                height. The tables list is passed UNFILTERED: the search narrows
                what you are reading, and a join whose table is hidden by a
                search term still has to insert the real address. */}
            <JoinsList
                relationships={relationships}
                tables={tables}
                sql={sql}
                onChangeSql={onChangeSql}
            />
        </aside>
    );
}
