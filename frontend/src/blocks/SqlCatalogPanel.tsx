// The SQL step's left panel: the tables and fields a query can actually read.
//
// It replaces the Sources panel rather than sitting beside it, because the two
// answer different questions and only one of them is the SQL step's. Sources
// asks "which datasets go on the ER canvas" â€” a legibility choice about a
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
// `duckle_src`), so the attached database decides what this panel can list â€”
// and the SQL step is where that choice actually bites.

import { useMemo, useState, type ReactNode } from 'react';
import {
    Database,
    FileText,
    Layers,
    PanelLeftClose,
    PanelLeftOpen,
    Search,
} from 'lucide-react';
import CatalogTable, { type CatalogSelection } from '../sqleditor/TableCatalog';
import type { SqlStudioTable } from '../sqleditor/types';
import { ATTACH_ALIAS, type DatabaseGroup } from './sources';
import type { ErdRelationship } from '../erd/model';
import JoinsList from './JoinsList';
import PanelSection, { readPanelOpen, writePanelOpen } from './PanelSection';
import type { JoinMode } from './builder-types';

/** Where the panel's own collapsed state lives, beside the sections'. */
const PANEL_KEY = 'duckle.builder.panel';

export interface SqlCatalogPanelProps {
    /** Tables the current query can read, each carrying its FROM address. */
    tables: SqlStudioTable[];
    /** Real datasets that are not readable from here â€” another database, or no
     *  composable read at all. Listed muted, with the reason. */
    unreachable: { table: SqlStudioTable; reason: string }[];
    groups: DatabaseGroup[];
    activeDb: string | null;
    onSelectDb: (dbPath: string) => void;
    /** The ER model, offered as one-click joins under the tables. */
    relationships: ErdRelationship[];
    sql: string;
    onChangeSql: (next: string) => void;
    /** Present only in builder mode â€” turns the catalog into a column picker. */
    selectionFor?: (table: SqlStudioTable) => CatalogSelection;
    /** The selected-columns list, rendered between tables and joins. */
    selected?: ReactNode;
    /** How many columns are selected, for the section's badge. */
    selectedCount?: number;
    /** The WHERE rows, and how many are switched on. */
    filters?: ReactNode;
    filterCount?: number;
    /** The HAVING rows â€” present only once something is aggregated. */
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
    unreachable,
    groups,
    activeDb,
    onSelectDb,
    relationships,
    sql,
    onChangeSql,
    selectionFor,
    selected,
    selectedCount,
    filters,
    filterCount,
    having,
    havingCount,
    activeJoins,
    onSetJoinMode,
    onAddJoinTable,
    reasonFor,
    excludedJoins,
    onExcludeJoin,
    onRestoreJoin,
    canExcludeJoin,
}: SqlCatalogPanelProps) {
    const activeName = groups.find(g => g.dbPath === activeDb)?.name ?? null;
    const [query, setQuery] = useState('');
    const [open, setOpen] = useState(() => readPanelOpen(PANEL_KEY, true));

    const toggle = () => {
        setOpen(o => {
            writePanelOpen(PANEL_KEY, !o);
            return !o;
        });
    };

    // Filters on COLUMN names as well as table names, because the question that
    // sends you to a catalog is at least as often "which table has VendorName"
    // as "where is Vendor". A table matched only by a column still appears â€” its
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
    // decides â€” anything addressed through the attach alias lives in the
    // database, anything else is a file read where it sits.
    const inDatabase = (t: SqlStudioTable) => !!t.from?.startsWith(`${ATTACH_ALIAS}.`);
    const dbTables = shownTables.filter(inDatabase);
    const fileTables = shownTables.filter(t => !inDatabase(t));

    // Collapsed, the panel becomes a rail rather than disappearing. A panel that
    // vanishes takes its own reopen control with it, leaving the button to bring
    // it back somewhere else entirely — and the rail also keeps the counts
    // visible, so a collapsed builder still says that three filters are on
    // rather than looking like an empty query that happens to return few rows.
    if (!open) {
        // Each count only when its section is actually there: `selectedCount` is
        // passed in either mode, but in SQL-text mode nothing on this panel is
        // selecting columns and a chip would be describing a section that is
        // not rendered.
        const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
        const chips = [
            {
                key: 'cols',
                n: selected != null ? (selectedCount ?? 0) : 0,
                say: (n: number) => `${plural(n, 'column')} selected`,
            },
            {
                key: 'where',
                n: filters != null ? (filterCount ?? 0) : 0,
                say: (n: number) => plural(n, 'row filter'),
            },
            {
                key: 'having',
                n: having != null ? (havingCount ?? 0) : 0,
                say: (n: number) => plural(n, 'grouping filter'),
            },
        ].filter(c => c.n > 0);
        // The counts are digits on a 30px rail, so what they COUNT lives in the
        // tooltip — on the rail itself, since a title inside a button competes
        // with the button's own.
        const summary = chips.map(c => c.say(c.n)).join(', ');

        // The whole rail is the button, rather than a 15px icon inside a strip
        // that also looks clickable. At 30px wide a separate target is mostly a
        // way to miss, and one control means one thing for a screen reader to
        // announce instead of three.
        return (
            <button
                type="button"
                className="blk-catalog blk-catalog--rail"
                onClick={toggle}
                title={
                    summary
                        ? `Show the builder panel — ${summary}`
                        : 'Show the builder panel'
                }
                aria-label={
                    summary
                        ? `Show the builder panel, ${summary}`
                        : 'Show the builder panel'
                }
                aria-expanded={false}
            >
                <PanelLeftOpen size={15} className="blk-rail-icon" />
                <span className="blk-rail-label">
                    {filters != null ? 'Builder' : 'Catalog'}
                </span>
                {chips.length > 0 ? (
                    <span className="blk-rail-counts">
                        {chips.map(c => (
                            <span key={c.key} className="blk-rail-count">
                                {c.n}
                            </span>
                        ))}
                    </span>
                ) : null}
            </button>
        );
    }

    return (
        <aside className="blk-catalog">
            <div className="blk-catalog-bar">
                <button
                    type="button"
                    className="blk-icon-btn"
                    onClick={toggle}
                    title="Hide the builder panel"
                    aria-label="Hide the builder panel"
                    aria-expanded
                >
                    <PanelLeftClose size={15} />
                </button>
            </div>
            <PanelSection
                title="Column Selection"
                storageKey="duckle.builder.sec.columns"
                badge={`${tables.length} readable${
                    unreachable.length > 0 ? ` Â· ${unreachable.length} not` : ''
                }`}
                shrink
            >
            {/* Above the database, because it searches everything below it â€”
                both the database's tables and the loose files. Sitting under
                the database name made it look like it searched only that. */}
            <label className="blk-lib-search">
                <Search size={12} />
                <input
                    value={query}
                    placeholder="Search tables, columnsâ€¦"
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
                            <CatalogTable key={t.name} table={t} selection={selectionFor?.(t)} />
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
                            <CatalogTable key={t.name} table={t} selection={selectionFor?.(t)} />
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
                                ? `Nothing matches â€œ${query.trim()}â€.`
                                : 'No durable datasets yet. Run a pipeline that writes one, then rescan.'}
                        </span>
                    </div>
                ) : null}
            </div>

            </PanelSection>

            {/* Each section is a sibling with its own scroll, so a workspace
                with a dozen tables cannot push the joins off the bottom â€” and
                they are most useful exactly when there are many tables to
                connect. The joins list is passed the UNFILTERED tables: the
                search narrows what you are reading, and a join whose table is
                hidden by a search term still has to insert the real address. */}
            {selected ? (
                <PanelSection
                    title="Column Ordering"
                    storageKey="duckle.builder.sec.ordering"
                    badge={selectedCount}
                >
                    {selected}
                </PanelSection>
            ) : null}

            {relationships.length > 0 ? (
                <PanelSection
                    title="Joins"
                    storageKey="duckle.builder.sec.joins"
                    badge={activeJoins ? `${activeJoins.size} in use` : relationships.length}
                >
                    <JoinsList
                        relationships={relationships}
                        tables={tables}
                        sql={sql}
                        onChangeSql={onChangeSql}
                        active={activeJoins}
                        onSetMode={onSetJoinMode}
                        onAddTable={onAddJoinTable}
                        reasonFor={reasonFor}
                        excluded={excludedJoins}
                        onExclude={onExcludeJoin}
                        onRestore={onRestoreJoin}
                        canExclude={canExcludeJoin}
                    />
                </PanelSection>
            ) : null}

            {/* Last, because it is the last thing decided: which columns, in
                what order, joined how â€” and only then which rows. */}
            {filters ? (
                <PanelSection
                    title="Where"
                    storageKey="duckle.builder.sec.where"
                    badge={filterCount || undefined}
                >
                    {filters}
                </PanelSection>
            ) : null}

            {/* Only once something is aggregated. A filter on groups has no
                meaning without groups, and DuckDB rejects HAVING outright â€”
                so the section appears when it becomes possible, the same way
                Column Ordering waits for a column. */}
            {having ? (
                <PanelSection
                    title="Grouping filter"
                    storageKey="duckle.builder.sec.having"
                    badge={havingCount || undefined}
                >
                    {having}
                </PanelSection>
            ) : null}
        </aside>
    );
}

