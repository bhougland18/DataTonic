// The query builder's panel, for any host that has tables and relationships.
//
// The other half of `useQueryBuilder`: that owns the state, this renders it.
// Between them the builder is mountable anywhere, which is the point — it was
// written against `SqlStudioTable[]` and `ErdRelationship[]` from the start and
// was reachable from one surface only because it happened to be inlined there.
//
// Where the tables come from is the HOST's business, and the one thing that
// genuinely differs between surfaces. Rather than teach this file about attach
// aliases and database switchers, the host passes `groups` — each with its own
// header — so Blocks can offer "which database" and the SQL Studio node can say
// "Working DB" without either concept leaking in here.
//
// Same seam `ErdEditor` cut for the ER model: both hosts mount this, not its
// parts, so a capability added here exists on both surfaces by construction
// rather than by whether a host remembered to pass an optional prop.

import { useMemo, useState, type ReactNode } from 'react';
import { Layers, PanelLeftClose, PanelLeftOpen, Search } from 'lucide-react';
import CatalogTable, { type CatalogSelection } from '../sqleditor/TableCatalog';
import type { SqlStudioTable } from '../sqleditor/types';
import type { ErdRelationship } from '../erd/model';
import JoinsList from './JoinsList';
import PanelSection, { readPanelOpen, writePanelOpen } from './PanelSection';
import type { JoinMode } from './builder-types';

/** Where the panel's own collapsed state lives, beside the sections'. */
const PANEL_KEY = 'duckle.builder.panel';

/**
 * One heading and the tables under it.
 *
 * The header is a node, not a string, because Blocks puts a database SELECT
 * there — "which database am I querying" is the first thing to check when a
 * table is missing, so it is a control rather than a label.
 */
export interface CatalogGroup {
    id: string;
    header: ReactNode;
    tables: SqlStudioTable[];
    /**
     * Keep the header when a search hides every table under it.
     *
     * Set where the header is a CONTROL rather than a label. Blocks' database
     * switcher has to stay reachable precisely when the search found nothing
     * here — the reason there are no matches is often that you are pointed at
     * the wrong database, and hiding the switcher would remove the fix along
     * with the symptom.
     */
    alwaysShow?: boolean;
}

export interface BuilderPanelProps {
    groups: CatalogGroup[];
    /** Real datasets that cannot be read from here, with the reason. */
    unreachable?: { table: SqlStudioTable; reason: string }[];
    /** Empty-catalog message. Hosts fail to have tables for different reasons. */
    emptyHint?: string;

    relationships: ErdRelationship[];
    sql: string;
    onChangeSql: (next: string) => void;

    /** Present only in builder mode — turns the catalog into a column picker. */
    selectionFor?: (table: SqlStudioTable) => CatalogSelection;

    activeJoins?: Map<string, JoinMode>;
    onSetJoinMode?: (relationshipId: string, mode: JoinMode) => void;
    onAddJoinTable?: (relationship: ErdRelationship) => void;
    reasonFor?: (table: string) => string;
    excludedJoins?: Set<string>;
    onExcludeJoin?: (relationshipId: string) => void;
    onRestoreJoin?: (relationshipId: string) => void;
    canExcludeJoin?: (relationshipId: string) => boolean;

    /** The Column Transformations section — every computed column. */
    transforms?: ReactNode;
    transformCount?: number;

    selected?: ReactNode;
    selectedCount?: number;
    filters?: ReactNode;
    filterCount?: number;
    having?: ReactNode;
    havingCount?: number;
    sort?: ReactNode;
    sortCount?: number;
}

export default function BuilderPanel({
    groups,
    unreachable = [],
    emptyHint,
    relationships,
    sql,
    onChangeSql,
    selectionFor,
    transforms,
    transformCount,
    activeJoins,
    onSetJoinMode,
    onAddJoinTable,
    reasonFor,
    excludedJoins,
    onExcludeJoin,
    onRestoreJoin,
    canExcludeJoin,
    selected,
    selectedCount,
    filters,
    filterCount,
    having,
    havingCount,
    sort,
    sortCount,
}: BuilderPanelProps) {
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
    // as "where is Vendor". A table matched only by a column still appears — its
    // columns are one click away.
    const match = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return null;
        return (t: SqlStudioTable) =>
            t.name.toLowerCase().includes(q) ||
            t.columns.some(c => c.name.toLowerCase().includes(q));
    }, [query]);

    const shownGroups = match
        ? groups.map(g => ({ ...g, tables: g.tables.filter(match) }))
        : groups;
    const shownUnreachable = match ? unreachable.filter(u => match(u.table)) : unreachable;
    const allTables = useMemo(() => groups.flatMap(g => g.tables), [groups]);
    const shownCount = shownGroups.reduce((n, g) => n + g.tables.length, 0);

    // Collapsed, the panel becomes a rail rather than disappearing. A panel that
    // vanishes takes its own reopen control with it, and the rail also keeps the
    // counts visible — a collapsed builder still says that three filters are on
    // rather than looking like an empty query that returns few rows.
    if (!open) {
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
        const summary = chips.map(c => c.say(c.n)).join(', ');

        return (
            <button
                type="button"
                className="blk-catalog blk-catalog--rail"
                onClick={toggle}
                title={summary ? `Show the builder panel — ${summary}` : 'Show the builder panel'}
                aria-label={
                    summary ? `Show the builder panel, ${summary}` : 'Show the builder panel'
                }
                aria-expanded={false}
            >
                <PanelLeftOpen size={15} className="blk-rail-icon" />
                <span className="blk-rail-label">{filters != null ? 'Builder' : 'Catalog'}</span>
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
                badge={`${allTables.length} readable${
                    unreachable.length > 0 ? ` · ${unreachable.length} not` : ''
                }`}
                shrink
            >
                {/* Above the groups, because it searches everything below it.
                    Sitting under a group's name made it look like it searched
                    only that group. */}
                <label className="blk-lib-search">
                    <Search size={12} />
                    <input
                        value={query}
                        placeholder="Search tables, columns…"
                        onChange={e => setQuery(e.target.value)}
                    />
                </label>

                <div className="blk-catalog-list">
                    {shownGroups.map(g =>
                        g.tables.length > 0 || g.alwaysShow ? (
                            <div key={g.id}>
                                {g.header}
                                {g.tables.map(t => (
                                    <CatalogTable
                                        key={t.name}
                                        table={t}
                                        selection={selectionFor?.(t)}
                                    />
                                ))}
                            </div>
                        ) : null,
                    )}

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

                    {shownCount === 0 && shownUnreachable.length === 0 ? (
                        <div className="blk-src-empty">
                            <Layers size={14} />
                            <span>
                                {match
                                    ? `Nothing matches “${query.trim()}”.`
                                    : (emptyHint ?? 'No tables to query.')}
                            </span>
                        </div>
                    ) : null}
                </div>
            </PanelSection>

            {/* Each section is a sibling with its own scroll, so a workspace
                with a dozen tables cannot push the joins off the bottom — and
                they are most useful exactly when there are many tables to
                connect. The joins list is passed the UNFILTERED tables: the
                search narrows what you are reading, and a join whose table is
                hidden by a search term still has to insert the real address. */}
            {/* Above Column Ordering, because this is where a column comes
                INTO existence and that section only arranges what exists. Also
                labelled `select`: both build the same clause, and pretending
                otherwise to avoid the repetition would be the dishonest half
                of the convention. */}
            {transforms ? (
                <PanelSection
                    title="Column Transformations"
                    sqlName="select"
                    storageKey="duckle.builder.sec.transforms"
                    badge={transformCount}
                >
                    {transforms}
                </PanelSection>
            ) : null}

            {selected ? (
                <PanelSection
                    title="Column Ordering"
                    sqlName="select"
                    storageKey="duckle.builder.sec.ordering"
                    badge={selectedCount}
                >
                    {selected}
                </PanelSection>
            ) : null}

            {relationships.length > 0 ? (
                <PanelSection
                    title="Joins"
                    // `from`, not `join`: this section decides the whole FROM
                    // chain, and the anchor table lands in FROM rather than in
                    // a JOIN. Labelling it `join` would also have been the same
                    // word twice.
                    sqlName="from"
                    storageKey="duckle.builder.sec.joins"
                    badge={activeJoins ? `${activeJoins.size} in use` : relationships.length}
                >
                    <JoinsList
                        relationships={relationships}
                        tables={allTables}
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
                what order, joined how — and only then which rows. */}
            {filters ? (
                <PanelSection
                    title="Filter"
                    sqlName="where"
                    storageKey="duckle.builder.sec.where"
                    badge={filterCount || undefined}
                >
                    {filters}
                </PanelSection>
            ) : null}

            {/* Only once something is aggregated. A filter on groups has no
                meaning without groups, and DuckDB rejects HAVING outright —
                so the section appears when it becomes possible, the same way
                Column Ordering waits for a column. */}
            {having ? (
                <PanelSection
                    title="Grouping Filter"
                    sqlName="having"
                    storageKey="duckle.builder.sec.having"
                    badge={havingCount || undefined}
                >
                    {having}
                </PanelSection>
            ) : null}

            {/* Last, and last in the SQL too: ORDER BY is the only clause that
                runs after the rows are decided. Putting it below the grouping
                filter keeps the panel in the order the query is read, which is
                the cheapest way to teach the shape of a SELECT. */}
            {sort ? (
                <PanelSection
                    title="Sort"
                    sqlName="order by"
                    storageKey="duckle.builder.sec.sort"
                    badge={sortCount || undefined}
                >
                    {sort}
                </PanelSection>
            ) : null}
        </aside>
    );
}
