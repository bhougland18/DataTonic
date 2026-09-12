// The saved queries, as a second left panel.
//
// Same shape as the Join Library beside the Schema step and the pattern library
// in the Regex Studio: a toggled panel of things you keep, next to the surface
// that makes them. Toggled rather than always-on because the SQL step already
// has a catalog on the left and can have the AI on the right, and three panes
// around one editor leaves no editor.

import { useMemo, useState } from 'react';
import {
    ChevronsLeft,
    Download,
    FileCode2,
    Pencil,
    Play,
    Search,
    Trash2,
    Upload,
} from 'lucide-react';
import type { SavedQuery } from './query-io';

export interface SavedQueriesPanelProps {
    queries: SavedQuery[];
    /** Load one into the editor. */
    onOpen: (q: SavedQuery) => void;
    onRename: (id: string, title: string) => void;
    onDelete: (id: string) => void;
    onClose: () => void;
    onExport: () => void;
    onImport: () => void;
    /** The query currently in the editor, so the list can mark it. */
    activeId?: string | null;
}

/** Coarse age, matching the Sources panel: precision invites false confidence. */
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

/** First meaningful line of the SQL, for a one-line preview. */
function firstLine(sql: string): string {
    const line = sql
        .split('\n')
        .map(l => l.trim())
        .find(l => l && !l.startsWith('--'));
    return line ?? '';
}

export default function SavedQueriesPanel({
    queries,
    onOpen,
    onRename,
    onDelete,
    onClose,
    onExport,
    onImport,
    activeId,
}: SavedQueriesPanelProps) {
    const [editing, setEditing] = useState<string | null>(null);
    const [draft, setDraft] = useState('');
    // Deleting asks once, in place. A saved query is somebody's work and the
    // list has no undo — but a modal for a sidebar row is heavier than the
    // action deserves, so the row itself becomes the confirmation.
    const [confirming, setConfirming] = useState<string | null>(null);
    const [query, setQuery] = useState('');

    // Searches the SQL as well as the title and description. By the time a
    // query is worth finding again, what you remember is often a table name or
    // a filter value rather than what you called the thing.
    const shown = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return queries;
        return queries.filter(
            x =>
                x.title.toLowerCase().includes(q) ||
                (x.description ?? '').toLowerCase().includes(q) ||
                x.query.sql.toLowerCase().includes(q),
        );
    }, [queries, query]);

    return (
        <aside className="blk-lib">
            <div className="blk-lib-head">
                <FileCode2 size={14} />
                <span>Saved queries</span>
                <button
                    className="blk-lib-icon"
                    onClick={onImport}
                    title="Import queries from a file"
                    aria-label="Import queries"
                >
                    <Upload size={13} />
                </button>
                <button
                    className="blk-lib-icon"
                    onClick={onExport}
                    title="Export these queries to a file"
                    aria-label="Export queries"
                >
                    <Download size={13} />
                </button>
                <button
                    className="blk-lib-icon"
                    onClick={onClose}
                    title="Hide saved queries"
                    aria-label="Hide saved queries"
                >
                    <ChevronsLeft size={14} />
                </button>
            </div>

            {queries.length > 0 ? (
                <label className="blk-lib-search">
                    <Search size={12} />
                    <input
                        value={query}
                        placeholder="Search title, description, SQL…"
                        onChange={e => setQuery(e.target.value)}
                    />
                </label>
            ) : null}

            {queries.length === 0 ? (
                <p className="blk-lib-hint">
                    Nothing saved yet. Write a query and press Save — it keeps the SQL so a chart
                    can be added to it later, which is what makes it a dive.
                </p>
            ) : null}

            {queries.length > 0 && shown.length === 0 ? (
                <p className="blk-lib-hint">Nothing matches “{query.trim()}”.</p>
            ) : null}

            {shown.map(q => (
                <div
                    key={q.id}
                    className={`blk-lib-row${q.id === activeId ? ' blk-sq-row--active' : ''}`}
                >
                    {editing === q.id ? (
                        <input
                            className="blk-sq-rename"
                            value={draft}
                            autoFocus
                            onChange={e => setDraft(e.target.value)}
                            onBlur={() => {
                                if (draft.trim()) onRename(q.id, draft.trim());
                                setEditing(null);
                            }}
                            onKeyDown={e => {
                                if (e.key === 'Enter') e.currentTarget.blur();
                                if (e.key === 'Escape') setEditing(null);
                            }}
                        />
                    ) : (
                        <button
                            className="blk-lib-apply"
                            onClick={() => onOpen(q)}
                            title="Load this query into the editor"
                        >
                            <span className="blk-sq-title">{q.title}</span>
                            {/* The description when there is one, the SQL only
                                as a fallback: a sentence about what the query
                                answers tells you whether this is the one you
                                want; `SELECT *` does not. */}
                            {q.description ? (
                                <span className="blk-sq-desc">{q.description}</span>
                            ) : (
                                <code>{firstLine(q.query.sql)}</code>
                            )}
                            {age(q.meta?.updatedAt) ? (
                                <span className="blk-lib-notes">{age(q.meta?.updatedAt)}</span>
                            ) : null}
                        </button>
                    )}

                    {confirming === q.id ? (
                        <button
                            className="blk-lib-icon blk-sq-confirm"
                            onClick={() => {
                                onDelete(q.id);
                                setConfirming(null);
                            }}
                            title="Delete for good"
                        >
                            Sure?
                        </button>
                    ) : (
                        <>
                            <button
                                className="blk-lib-icon"
                                onClick={() => {
                                    setEditing(q.id);
                                    setDraft(q.title);
                                }}
                                title="Rename"
                                aria-label={`Rename ${q.title}`}
                            >
                                <Pencil size={12} />
                            </button>
                            <button
                                className="blk-lib-icon"
                                onClick={() => onOpen(q)}
                                title="Load into the editor"
                                aria-label={`Open ${q.title}`}
                            >
                                <Play size={12} />
                            </button>
                            <button
                                className="blk-lib-icon"
                                onClick={() => setConfirming(q.id)}
                                title="Delete"
                                aria-label={`Delete ${q.title}`}
                            >
                                <Trash2 size={12} />
                            </button>
                        </>
                    )}
                </div>
            ))}
        </aside>
    );
}
