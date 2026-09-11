// The saved-join library, as a secondary left panel.
//
// Mirrors the Regex Studio's saved-pattern panel: two scopes side by side,
// export and import, and entries you can apply to what is on screen. The scope
// split is the substance — `workspace` joins belong to this engagement and are
// committed with it, `global` joins are the consultant's own knowledge of a
// source system and follow them between workspaces.
//
// Entries are grouped by TABLE PAIR, the same shape the relationship list on
// the right uses, so the two panels read alike: a library entry and a live
// relationship are the same kind of thing, one saved and one in play.
//
// Entries that cannot apply to the current canvas are still LISTED, greyed,
// rather than filtered out. A library that silently shows fewer entries in some
// workspaces is one you stop trusting; saying "this one needs MMDIST" is the
// more useful answer.

import { useMemo, useState } from 'react';
import {
    Bookmark,
    ChevronDown,
    ChevronRight,
    ChevronsLeft,
    Download,
    Globe,
    Search,
    Trash2,
    Upload,
    FolderGit2,
} from 'lucide-react';
import type { SavedJoin, JoinScope } from './join-library';
import type { ErdTable } from '../erd/model';

export interface JoinLibraryPanelProps {
    joins: SavedJoin[];
    tables: ErdTable[];
    /** Add this entry's relationship to the model. */
    onApply: (join: SavedJoin) => void;
    onRemove: (id: string, scope: JoinScope) => void;
    /** Move an entry between this workspace and the global library. */
    onRescope: (join: SavedJoin, scope: JoinScope) => void;
    onExport: () => void;
    onImport: () => void;
    onClose: () => void;
}

interface PairGroup {
    key: string;
    a: string;
    b: string;
    joins: SavedJoin[];
}

/** Group by unordered table pair, the same rule the relationship list uses. */
function groupByPair(joins: SavedJoin[]): PairGroup[] {
    const m = new Map<string, PairGroup>();
    for (const j of joins) {
        const [a, b] = [j.fromTable, j.toTable].sort((x, y) =>
            x.toLowerCase().localeCompare(y.toLowerCase()),
        );
        const key = `${a.toLowerCase()}||${b.toLowerCase()}`;
        const g = m.get(key);
        if (g) g.joins.push(j);
        else m.set(key, { key, a, b, joins: [j] });
    }
    return [...m.values()].sort((x, y) => x.a.localeCompare(y.a));
}

/** Free-text match over everything a person might type: either table, either
 *  column, or the note. Case-insensitive, substring — a library this size does
 *  not need anything cleverer, and fuzzy matching would surprise. */
function matches(j: SavedJoin, q: string): boolean {
    if (!q) return true;
    const hay = `${j.fromTable}.${j.fromColumn} ${j.toTable}.${j.toColumn} ${j.notes ?? ''}`;
    return hay.toLowerCase().includes(q.toLowerCase());
}

function Section({
    scope,
    label,
    hint,
    joins,
    query,
    canApply,
    onApply,
    onRemove,
    onRescope,
}: {
    scope: JoinScope;
    label: string;
    hint: string;
    joins: SavedJoin[];
    query: string;
    canApply: (j: SavedJoin) => boolean;
    onApply: (j: SavedJoin) => void;
    onRemove: (id: string, scope: JoinScope) => void;
    onRescope: (j: SavedJoin, scope: JoinScope) => void;
}) {
    const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
    const other: JoinScope = scope === 'global' ? 'workspace' : 'global';
    const groups = useMemo(() => groupByPair(joins), [joins]);

    const toggle = (key: string) =>
        setCollapsed(prev => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });

    return (
        <section className="blk-lib-section">
            <header className="blk-lib-section-head">
                {scope === 'global' ? <Globe size={12} /> : <FolderGit2 size={12} />}
                <span>{label}</span>
                <small>{joins.length}</small>
            </header>

            {joins.length === 0 ? (
                // Distinguishes "nothing saved" from "nothing matched", which
                // otherwise look identical and mean opposite things.
                <p className="blk-lib-hint">{query ? 'No matches here.' : hint}</p>
            ) : (
                groups.map(g => {
                    const shut = collapsed.has(g.key);
                    return (
                        <div className="blk-lib-group" key={g.key}>
                            <button
                                type="button"
                                className="blk-lib-group-head"
                                onClick={() => toggle(g.key)}
                                aria-expanded={!shut}
                            >
                                {shut ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                                <span className="pair">
                                    {g.a} ↔ {g.b}
                                </span>
                                {g.joins.length > 1 ? (
                                    <span className="cnt">{g.joins.length}</span>
                                ) : null}
                            </button>
                            {shut
                                ? null
                                : g.joins.map(j => {
                                      const ok = canApply(j);
                                      return (
                                          <div
                                              key={`${j.scope}:${j.id}`}
                                              className={`blk-lib-row${ok ? '' : ' blk-lib-row--off'}`}
                                          >
                                              <button
                                                  type="button"
                                                  className="blk-lib-apply"
                                                  disabled={!ok}
                                                  title={
                                                      ok
                                                          ? 'Add this join to the model'
                                                          : `Needs ${j.fromTable} and ${j.toTable} on the canvas`
                                                  }
                                                  onClick={() => onApply(j)}
                                              >
                                                  <code>
                                                      {j.fromTable}.{j.fromColumn} → {j.toTable}.
                                                      {j.toColumn}
                                                  </code>
                                                  {j.notes ? (
                                                      <span className="blk-lib-notes">{j.notes}</span>
                                                  ) : null}
                                              </button>
                                              <button
                                                  type="button"
                                                  className="blk-lib-icon"
                                                  title={
                                                      other === 'global'
                                                          ? 'Promote to the global library (every workspace)'
                                                          : 'Move into this workspace'
                                                  }
                                                  aria-label="Change scope"
                                                  onClick={() => onRescope(j, other)}
                                              >
                                                  {other === 'global' ? (
                                                      <Globe size={12} />
                                                  ) : (
                                                      <FolderGit2 size={12} />
                                                  )}
                                              </button>
                                              <button
                                                  type="button"
                                                  className="blk-lib-icon"
                                                  title="Remove from the library"
                                                  aria-label="Remove from the library"
                                                  onClick={() => onRemove(j.id, j.scope)}
                                              >
                                                  <Trash2 size={12} />
                                              </button>
                                          </div>
                                      );
                                  })}
                        </div>
                    );
                })
            )}
        </section>
    );
}

export default function JoinLibraryPanel({
    joins,
    tables,
    onApply,
    onRemove,
    onRescope,
    onExport,
    onImport,
    onClose,
}: JoinLibraryPanelProps) {
    const [query, setQuery] = useState('');

    const cols = useMemo(
        () => new Map(tables.map(t => [t.name, new Set(t.columns.map(c => c.name))])),
        [tables],
    );
    const canApply = (j: SavedJoin) =>
        !!cols.get(j.fromTable)?.has(j.fromColumn) && !!cols.get(j.toTable)?.has(j.toColumn);

    const found = useMemo(() => joins.filter(j => matches(j, query)), [joins, query]);

    return (
        <aside className="blk-lib">
            <div className="blk-lib-head">
                <Bookmark size={13} />
                <span>Join library</span>
                <button type="button" className="blk-lib-icon" title="Import" onClick={onImport}>
                    <Upload size={13} />
                </button>
                <button type="button" className="blk-lib-icon" title="Export" onClick={onExport}>
                    <Download size={13} />
                </button>
                <button
                    type="button"
                    className="blk-lib-icon"
                    title="Collapse panel"
                    aria-label="Collapse panel"
                    onClick={onClose}
                >
                    <ChevronsLeft size={14} />
                </button>
            </div>

            <label className="blk-lib-search">
                <Search size={12} />
                <input
                    value={query}
                    placeholder="Search tables, columns, notes…"
                    onChange={e => setQuery(e.target.value)}
                />
            </label>

            <Section
                scope="workspace"
                label="This workspace"
                hint="Joins saved here are committed with the workspace."
                joins={found.filter(j => j.scope === 'workspace')}
                query={query}
                canApply={canApply}
                onApply={onApply}
                onRemove={onRemove}
                onRescope={onRescope}
            />
            <Section
                scope="global"
                label="Global"
                hint="Joins that hold in every workspace — an ERP's own keys, saved once."
                joins={found.filter(j => j.scope === 'global')}
                query={query}
                canApply={canApply}
                onApply={onApply}
                onRemove={onRemove}
                onRescope={onRescope}
            />
        </aside>
    );
}
