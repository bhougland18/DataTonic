// The workspace's dives, as a left panel on the Charts step.
//
// Was a strip of chips, and Ben called it: *"I am almost thinking a side panel
// may be best just like the saved queries on the sql step"* — because a
// workspace will have twenty or thirty of these, and twenty chips wrapping
// across the top of the chart is not a list anybody can use. Same shape as
// `SavedQueriesPanel`, deliberately: search, rows, open, delete.
//
// GROUPED, which is the one thing that panel does not need to do. A dive over
// the query on screen is another FACET of what you are already looking at, and
// opening it costs nothing; a dive over a different query replaces the SQL and
// re-runs. Those are different enough moves that the list says which is which
// rather than leaving somebody to find out by clicking.

import { useMemo, useState } from 'react';
import {
    ChartNoAxesCombined,
    PanelLeftClose,
    PanelLeftOpen,
    Search,
    Trash2,
} from 'lucide-react';
import { markType } from './chart-spec';
import { sameDataset, type BlockDive } from './dive-promote';

export interface DivesPanelProps {
    dives: BlockDive[];
    /** The query on screen, so its own facets can be picked out. */
    currentSql: string;
    activeId?: string | null;
    onOpen: (dive: BlockDive) => void;
    onDelete: (id: string) => void;
    /** Collapsed to a rail rather than hidden — see the render below. */
    collapsed?: boolean;
    onToggle: () => void;
}

/** Coarse age, matching the Sources and Saved Queries panels. */
function age(iso?: string): string | null {
    if (!iso) return null;
    const then = Date.parse(iso);
    if (!Number.isFinite(then)) return null;
    const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    return hrs < 24 ? `${hrs}h ago` : `${Math.round(hrs / 24)}d ago`;
}

export default function DivesPanel({
    dives,
    currentSql,
    activeId,
    onOpen,
    onDelete,
    collapsed,
    onToggle,
}: DivesPanelProps) {
    const [query, setQuery] = useState('');
    // Asks once, in place, like the saved queries: a dive is somebody's work
    // and the list has no undo, but a modal for a sidebar row is heavier than
    // the action deserves.
    const [confirming, setConfirming] = useState<string | null>(null);

    // Searches the SQL as well as the title, for the same reason that panel
    // does: by the time a dive is worth finding again, what you remember is
    // often a table name rather than what you called the picture.
    const shown = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return dives;
        return dives.filter(
            d =>
                d.title.toLowerCase().includes(q) ||
                (d.description ?? '').toLowerCase().includes(q) ||
                d.query.sql.toLowerCase().includes(q),
        );
    }, [dives, query]);

    const mine = shown.filter(d => sameDataset(d.query.sql, currentSql));
    const others = shown.filter(d => !sameDataset(d.query.sql, currentSql));

    const row = (d: BlockDive, other: boolean) => (
        <div
            key={d.id}
            className={`blk-lib-row${d.id === activeId ? ' blk-dive-row--on' : ''}`}
        >
            <button
                type="button"
                className="blk-lib-apply"
                onClick={() => onOpen(d)}
                title={
                    other
                        ? `${d.title} — saved over a different query, so opening it replaces the SQL and re-runs`
                        : `${d.title} — another view of the query on screen`
                }
            >
                <span className="blk-dive-name">
                    <ChartNoAxesCombined size={12} strokeWidth={1.9} />
                    {d.title}
                    {/* The mark, because two facets of one query usually share
                        a title stem and differ only in the picture. */}
                    {markType(d.chart) ? <small>{markType(d.chart)}</small> : null}
                </span>
                <span className="blk-lib-notes">
                    {[d.description, age(d.meta?.updatedAt)].filter(Boolean).join(' · ')}
                </span>
            </button>
            {confirming === d.id ? (
                <>
                    <button
                        type="button"
                        className="blk-lib-icon blk-dive-danger"
                        onClick={() => {
                            onDelete(d.id);
                            setConfirming(null);
                        }}
                        title={`Delete ${d.title}`}
                    >
                        Delete
                    </button>
                    <button
                        type="button"
                        className="blk-lib-icon"
                        onClick={() => setConfirming(null)}
                        title="Keep it"
                    >
                        Keep
                    </button>
                </>
            ) : (
                <button
                    type="button"
                    className="blk-lib-icon"
                    onClick={() => setConfirming(d.id)}
                    title={`Delete ${d.title}`}
                    aria-label={`Delete ${d.title}`}
                >
                    <Trash2 size={13} />
                </button>
            )}
        </div>
    );

    // Collapsed, this becomes a RAIL rather than disappearing — the same
    // treatment the SQL step's builder panel gets, and for the same reason
    // recorded there: a panel that vanishes takes its own reopen control with
    // it. The rail also keeps the count visible, so a collapsed list still says
    // there are four dives rather than looking like there are none.
    if (collapsed) {
        return (
            <button
                type="button"
                className="blk-catalog blk-catalog--rail"
                onClick={onToggle}
                title={`Show the dives panel — ${dives.length} saved`}
                aria-label={`Show the dives panel, ${dives.length} saved`}
                aria-expanded={false}
            >
                <PanelLeftOpen size={15} className="blk-rail-icon" />
                <span className="blk-rail-label">Dives</span>
                {dives.length > 0 ? (
                    <span className="blk-rail-counts">
                        <span className="blk-rail-count">{dives.length}</span>
                    </span>
                ) : null}
            </button>
        );
    }

    return (
        <div className="blk-catalog">
            <div className="blk-catalog-bar">
                <button
                    type="button"
                    className="blk-icon-btn"
                    onClick={onToggle}
                    title="Hide the dives panel"
                    aria-label="Hide the dives panel"
                    aria-expanded
                >
                    <PanelLeftClose size={15} />
                </button>
            </div>
            <div className="blk-lib-head">
                <span>Dives{dives.length > 0 ? ` (${dives.length})` : ''}</span>
            </div>

            {dives.length > 3 ? (
                <label className="blk-lib-search">
                    <Search size={12} />
                    <input
                        value={query}
                        placeholder="Search title, description, SQL…"
                        aria-label="Search dives"
                        onChange={e => setQuery(e.target.value)}
                    />
                </label>
            ) : null}

            {dives.length === 0 ? (
                <p className="blk-lib-hint">
                    No dives yet. A dive is this query plus one chart — save several to keep more
                    than one view of the same data.
                </p>
            ) : null}

            {mine.length > 0 ? (
                <>
                    <div className="blk-dive-group">This query</div>
                    {mine.map(d => row(d, false))}
                </>
            ) : null}

            {others.length > 0 ? (
                <>
                    {/* Said rather than hidden: opening one of these swaps the
                        query as well, and re-runs it. */}
                    <div className="blk-dive-group">
                        Other queries
                        <small>opening one replaces the SQL</small>
                    </div>
                    {others.map(d => row(d, true))}
                </>
            ) : null}

            {dives.length > 0 && shown.length === 0 ? (
                <p className="blk-lib-hint">Nothing matches “{query}”.</p>
            ) : null}
        </div>
    );
}
