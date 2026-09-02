import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, ChevronDown, ChevronLeft, ChevronRight, Play, Loader2, Plus, Trash2, Boxes, RefreshCw, Plug, Check, ArrowUpToLine, Save, Download, Upload, Bookmark } from 'lucide-react';
import InforProvider from '../InforProvider';
import type { PlaygroundConnection, credentialsToPayload } from '../../connectionBridge';
import type { IonApiConfig } from './ionapi';
import type { IonApiToken } from './inforAuth';
import type { BusinessClass } from './discovery';
import {
    cacheAvailable,
    fetchAllBusinessClasses,
    loadCachedClasses,
    saveCachedClasses,
} from './classCache';
import { runGenericQuery, sampleFields, type InforNodeQuery } from './query';
import FilterBuilder from './FilterBuilder';
import {
    emptyFilter,
    filterToLpl,
    isEmptyFilter,
    hydrateFilter,
    filterFromSimple,
    type FilterGroup,
} from './filterModel';
import { DATA_AREAS, type DataAreaId, type GenericPage } from './inforApi';
import {
    savedQueriesAvailable,
    loadSavedQueries,
    saveSavedQueries,
    exportQueryFile,
    parseImportedQuery,
    type SavedQuery,
} from './savedQueries';

interface InforWorkspaceProps {
    workspacePath: string | null;
    connections?: PlaygroundConnection[];
    onSaveConnection?: (name: string, payload: ReturnType<typeof credentialsToPayload>) => string;
    // Set when the Playground was opened from a Canvas Infor node: carries the
    // node's current query to pre-load, and the node id to write back to.
    openRequest?: { nonce: number; nodeId: string; query?: InforNodeQuery } | null;
    // Write the built query back to the originating node's props.
    onApplyToNode?: (nodeId: string, query: InforNodeQuery) => void;
}

const PAGE_SIZE = 25;
const DEFAULT_LIMIT = 25;

// The full Infor experience in one place: the left panel holds the
// credentials/connection and the whole query builder (business class → fields
// → filter → run); the right pane is the results grid. Matches the approved
// Query-Properties mockup.
export default function InforWorkspace({
    workspacePath,
    connections = [],
    onSaveConnection,
    openRequest,
    onApplyToNode,
}: InforWorkspaceProps) {
    const [session, setSession] = useState<{ config: IonApiConfig; token: IonApiToken } | null>(null);

    // Data area (FSM / HCM) — the variable middle of the REST base. Discovery
    // and queries both hang off it, so switching it re-fetches the class list.
    const [dataArea, setDataArea] = useState<DataAreaId>('FSM');

    // ---- business-class discovery (full list cached, searched client-side) ----
    const [search, setSearch] = useState('');
    const [page, setPage] = useState(1);
    const [allClasses, setAllClasses] = useState<BusinessClass[] | null>(null);
    const [classesLoading, setClassesLoading] = useState(false);
    const [classesError, setClassesError] = useState<string | null>(null);
    const [cacheInfo, setCacheInfo] = useState<{ fetchedAt: string; fromCache: boolean } | null>(null);
    const [selected, setSelected] = useState<BusinessClass | null>(null);
    const [pickerOpen, setPickerOpen] = useState(true);

    // ---- query state (per selected class) ----
    const [fields, setFields] = useState<string[]>([]);
    const [checked, setChecked] = useState<Set<string>>(new Set());
    const [fieldSearch, setFieldSearch] = useState('');
    const [fieldsLoading, setFieldsLoading] = useState(false);
    const [filterTree, setFilterTree] = useState<FilterGroup>(() => emptyFilter());
    const [limit, setLimit] = useState(DEFAULT_LIMIT);
    // The limit checkbox (on by default). Off omits _limit — server default/all.
    const [limitEnabled, setLimitEnabled] = useState(true);
    const [running, setRunning] = useState(false);
    const [result, setResult] = useState<GenericPage | null>(null);
    const [queryError, setQueryError] = useState<string | null>(null);

    // ---- round-trip with a Canvas node (opened via "Open in Playground") ----
    // The node we'll write back to, and its query held until sign-in + the
    // class list are ready (the user may open before signing in).
    const [applyNodeId, setApplyNodeId] = useState<string | null>(null);
    const [pendingQuery, setPendingQuery] = useState<InforNodeQuery | null>(null);
    const [applied, setApplied] = useState(false);

    // ---- saved queries (task 1q): per-tenant list, filtered by data area ----
    const [savedQueries, setSavedQueries] = useState<SavedQuery[]>([]);
    const [savedOpen, setSavedOpen] = useState(true);
    const [savedSearch, setSavedSearch] = useState('');
    const [saveDesc, setSaveDesc] = useState('');
    const importRef = useRef<HTMLInputElement>(null);

    const applyFetched = async (config: IonApiConfig, classes: BusinessClass[]) => {
        setAllClasses(classes);
        const now = new Date().toISOString();
        setCacheInfo({ fetchedAt: now, fromCache: false });
        if (workspacePath && cacheAvailable()) {
            try {
                await saveCachedClasses(workspacePath, config.tenant, classes, now, dataArea);
            } catch {
                /* cache write is best-effort */
            }
        }
    };

    // On sign-in (or a data-area switch), load that area's class list once
    // (cache first, else download).
    useEffect(() => {
        if (!session) return;
        const { config, token } = session;
        let cancelled = false;
        (async () => {
            setClassesLoading(true);
            setClassesError(null);
            if (workspacePath && cacheAvailable()) {
                const cached = await loadCachedClasses(workspacePath, config.tenant, dataArea);
                if (cancelled) return;
                if (cached) {
                    setAllClasses(cached.classes);
                    setCacheInfo({ fetchedAt: cached.fetchedAt, fromCache: true });
                    setClassesLoading(false);
                    return;
                }
            }
            const res = await fetchAllBusinessClasses(config, token.accessToken, workspacePath, dataArea);
            if (cancelled) return;
            setClassesLoading(false);
            if (!res.ok) {
                setClassesError(res.error);
                return;
            }
            await applyFetched(config, res.classes);
        })();
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [session, workspacePath, dataArea]);

    // Switch data area: reset the query builder and let the effect above
    // re-fetch the new area's classes (clearing allClasses shows the loader).
    const changeDataArea = (next: DataAreaId) => {
        if (next === dataArea) return;
        setDataArea(next);
        setAllClasses(null);
        setSelected(null);
        setPickerOpen(true);
        setSearch('');
        setPage(1);
        setFields([]);
        setChecked(new Set());
        setFieldSearch('');
        setFilterTree(emptyFilter());
        setResult(null);
        setQueryError(null);
    };

    // Capture an "Open in Playground" request from a Canvas node; hold the
    // query until we can apply it (below).
    useEffect(() => {
        if (!openRequest) return;
        setApplyNodeId(openRequest.nodeId);
        setPendingQuery(openRequest.query ?? {});
        setApplied(false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [openRequest?.nonce]);

    // Apply the held node query once signed in. A blank query (a freshly
    // created node) resets the builder to empty so it never inherits the
    // previously opened node's class/fields/filter; a saved query auto-populates
    // it — loading the class's field list (union'd with the node's saved fields
    // so none silently drop).
    useEffect(() => {
        if (!session || !pendingQuery) return;
        const q = pendingQuery;
        setPendingQuery(null);
        setResult(null);
        setQueryError(null);
        const wanted = (q.fields ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        // New / unconfigured node → start blank (do NOT carry over prior state)
        // and open the saved-queries panel so the user can pick one.
        if (!q.businessClass) {
            setDataArea('FSM');
            setSavedOpen(true);
            setSelected(null);
            setPickerOpen(true);
            setSearch('');
            setPage(1);
            setFields([]);
            setChecked(new Set());
            setFieldSearch('');
            setFilterTree(emptyFilter());
            setLimit(DEFAULT_LIMIT);
            return;
        }
        // Configured node → populate the builder; the panel stays collapsed
        // since the user is editing an existing query, not browsing.
        const area: DataAreaId = q.dataArea ?? 'FSM';
        setDataArea(area);
        setSavedOpen(false);
        setLimit(typeof q.limit === 'number' && q.limit > 0 ? q.limit : DEFAULT_LIMIT);
        setFilterTree(q.filterTree ? hydrateFilter(q.filterTree) : filterFromSimple(q.filter));
        setChecked(new Set(wanted));
        setFieldSearch('');
        const businessClass = q.businessClass;
        const bc =
            (allClasses ?? []).find((c) => c.entity === businessClass) ?? { entity: businessClass };
        setSelected(bc);
        setPickerOpen(false);
        (async () => {
            setFieldsLoading(true);
            const res = await sampleFields(
                session.config,
                session.token.accessToken,
                businessClass,
                workspacePath,
                area,
            );
            setFieldsLoading(false);
            if (res.ok) {
                const union = [...res.fields];
                for (const w of wanted) if (!union.includes(w)) union.push(w);
                setFields(union);
            } else {
                setFields(wanted);
            }
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [session, allClasses, pendingQuery]);

    // Any manual edit clears the "Applied ✓" confirmation.
    useEffect(() => {
        setApplied(false);
    }, [checked, filterTree, limit, selected]);

    const applyToNode = () => {
        if (!onApplyToNode || !applyNodeId || !selected) return;
        const activeFields = fields.length ? fields.filter((f) => checked.has(f)) : Array.from(checked);
        onApplyToNode(applyNodeId, {
            dataArea,
            businessClass: selected.entity,
            fields: activeFields.join(','),
            // The structured tree round-trips for editing; the derived LPL runs.
            filterTree: isEmptyFilter(filterTree) ? undefined : filterTree,
            lplFilter: filterToLpl(filterTree),
            limit: limitEnabled ? limit : undefined,
        });
        setApplied(true);
    };

    // Load this tenant's saved queries once signed in.
    useEffect(() => {
        if (!session || !workspacePath || !savedQueriesAvailable()) return;
        let cancelled = false;
        (async () => {
            const list = await loadSavedQueries(workspacePath, session.config.tenant);
            if (!cancelled) setSavedQueries(list);
        })();
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [session, workspacePath]);

    const persistQueries = (next: SavedQuery[]) => {
        setSavedQueries(next);
        if (session && workspacePath && savedQueriesAvailable()) {
            void saveSavedQueries(workspacePath, session.config.tenant, next).catch(() => {});
        }
    };

    const saveCurrentQuery = () => {
        if (!selected || !saveDesc.trim()) return;
        const q: SavedQuery = {
            id: crypto.randomUUID(),
            description: saveDesc.trim(),
            dataArea,
            businessClass: selected.entity,
            fields: fields.filter((f) => checked.has(f)),
            filter: filterTree,
            limit: limitEnabled ? limit : undefined,
            savedAt: new Date().toISOString(),
        };
        persistQueries([q, ...savedQueries]);
        setSaveDesc('');
    };

    // Load a saved query into the builder, then collapse the panel.
    const loadSavedQuery = async (q: SavedQuery) => {
        if (!session) return;
        setSavedOpen(false);
        setResult(null);
        setQueryError(null);
        setFilterTree(hydrateFilter(q.filter));
        setChecked(new Set(q.fields));
        if (typeof q.limit === 'number' && q.limit > 0) {
            setLimit(q.limit);
            setLimitEnabled(true);
        } else {
            setLimitEnabled(false);
        }
        const bc =
            (allClasses ?? []).find((c) => c.entity === q.businessClass) ?? { entity: q.businessClass };
        setSelected(bc);
        setPickerOpen(false);
        setFieldSearch('');
        setFieldsLoading(true);
        const res = await sampleFields(
            session.config,
            session.token.accessToken,
            q.businessClass,
            workspacePath,
            q.dataArea,
        );
        setFieldsLoading(false);
        if (res.ok) {
            const union = [...res.fields];
            for (const w of q.fields) if (!union.includes(w)) union.push(w);
            setFields(union);
        } else {
            setFields(q.fields);
        }
    };

    const deleteSavedQuery = (id: string) => {
        persistQueries(savedQueries.filter((q) => q.id !== id));
    };

    const handleImportQuery = async (file: File | null) => {
        if (!file) return;
        const q = parseImportedQuery(await file.text());
        if (q) persistQueries([q, ...savedQueries]);
    };

    const filteredSaved = useMemo(() => {
        const s = savedSearch.trim().toLowerCase();
        return savedQueries
            .filter((q) => q.dataArea === dataArea)
            .filter(
                (q) =>
                    !s ||
                    q.businessClass.toLowerCase().includes(s) ||
                    q.description.toLowerCase().includes(s),
            );
    }, [savedQueries, dataArea, savedSearch]);

    const refreshClasses = async () => {
        if (!session) return;
        setClassesLoading(true);
        setClassesError(null);
        const res = await fetchAllBusinessClasses(
            session.config,
            session.token.accessToken,
            workspacePath,
            dataArea,
        );
        setClassesLoading(false);
        if (!res.ok) {
            setClassesError(res.error);
            return;
        }
        await applyFetched(session.config, res.classes);
    };

    const selectClass = async (bc: BusinessClass) => {
        if (!session) return;
        setSelected(bc);
        setPickerOpen(false);
        setSavedOpen(false);
        setResult(null);
        setQueryError(null);
        setFilterTree(emptyFilter());
        setFields([]);
        setChecked(new Set());
        setFieldSearch('');
        setFieldsLoading(true);
        const res = await sampleFields(
            session.config,
            session.token.accessToken,
            bc.entity,
            workspacePath,
            dataArea,
        );
        setFieldsLoading(false);
        if (res.ok) setFields(res.fields);
    };

    const toggleField = (f: string) =>
        setChecked((prev) => {
            const next = new Set(prev);
            if (next.has(f)) next.delete(f);
            else next.add(f);
            return next;
        });

    const runQuery = async () => {
        if (!session || !selected) return;
        setRunning(true);
        setQueryError(null);
        setResult(null);
        const res = await runGenericQuery(
            session.config,
            session.token.accessToken,
            selected.entity,
            {
                fields: fields.filter((f) => checked.has(f)),
                filter: [],
                lpl: filterToLpl(filterTree),
                limit: limitEnabled ? limit : undefined,
            },
            workspacePath,
            dataArea,
        );
        setRunning(false);
        if (!res.ok) {
            setQueryError(`HTTP ${res.status} — ${res.error}`);
            return;
        }
        setResult(res.page);
    };

    const columns = useMemo(() => {
        const active = fields.filter((f) => checked.has(f));
        if (active.length) return active;
        return result?.rows.length ? Object.keys(result.rows[0]) : [];
    }, [fields, checked, result]);

    const filtered = useMemo(() => {
        const all = allClasses ?? [];
        const q = search.trim().toLowerCase();
        if (!q) return all;
        const rank = (name: string) => {
            const n = name.toLowerCase();
            if (n === q) return 0;
            if (n.startsWith(q)) return 1;
            return 2;
        };
        return all
            .filter((c) => c.entity.toLowerCase().includes(q))
            .sort((a, b) => rank(a.entity) - rank(b.entity) || a.entity.localeCompare(b.entity));
    }, [allClasses, search]);

    const totalFiltered = filtered.length;
    const totalPages = Math.max(1, Math.ceil(totalFiltered / PAGE_SIZE));
    const pageItems = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

    const visibleFields = useMemo(() => {
        const q = fieldSearch.trim().toLowerCase();
        return q ? fields.filter((f) => f.toLowerCase().includes(q)) : fields;
    }, [fields, fieldSearch]);

    return (
        <div className="pgi">
            {/* ---- Left: provider + credentials + query properties ---- */}
            <div className="pgi-props">
                <header className="pg-sidebar-head">
                    <Plug size={16} strokeWidth={1.75} />
                    <h2>API Playground</h2>
                </header>
                <InforProvider
                    workspacePath={workspacePath}
                    onSignedIn={(config, token) => setSession({ config, token })}
                    connections={connections}
                    onSaveConnection={onSaveConnection}
                />

                {session && (
                    <div className="pgi-query">
                        {/* ---- Data area ---- */}
                        <div className="pgi-section">
                            <div className="pgi-lbl">Data area</div>
                            <select
                                className="pg-input pg-input--select"
                                value={dataArea}
                                onChange={(e) => changeDataArea(e.target.value as DataAreaId)}
                            >
                                {DATA_AREAS.map((a) => (
                                    <option key={a.id} value={a.id}>
                                        {a.label}
                                    </option>
                                ))}
                            </select>
                        </div>

                        {/* ---- Business class ---- */}
                        <div className="pgi-section">
                            <div className="pgi-lbl">Business class</div>
                            {selected && !pickerOpen ? (
                                <button
                                    type="button"
                                    className="pgi-selected"
                                    onClick={() => setPickerOpen(true)}
                                >
                                    <span className="pgi-selected-nm">{selected.entity}</span>
                                    <span className="pgi-selected-change">
                                        change <ChevronDown size={13} />
                                    </span>
                                </button>
                            ) : (
                                <>
                                    <div className="pgi-search">
                                        <Search size={13} strokeWidth={2} />
                                        <input
                                            autoFocus
                                            placeholder="Search business classes…"
                                            value={search}
                                            onChange={(e) => {
                                                setSearch(e.target.value);
                                                setPage(1);
                                            }}
                                        />
                                        {classesLoading && <Loader2 size={13} className="pg-spin" />}
                                    </div>
                                    {classesError && (
                                        <div className="pg-note" style={{ color: 'var(--danger)' }}>
                                            {classesError}
                                        </div>
                                    )}
                                    {classesLoading && !allClasses ? (
                                        <div className="pg-note">
                                            <Loader2 size={13} className="pg-spin" /> Downloading the
                                            business-class list…
                                        </div>
                                    ) : (
                                        <>
                                            <div className="pgi-classlist">
                                                {pageItems.map((c) => (
                                                    <button
                                                        key={c.entity}
                                                        type="button"
                                                        className={`pgi-class${selected?.entity === c.entity ? ' pgi-class--sel' : ''}`}
                                                        onClick={() => void selectClass(c)}
                                                        title={c.desc}
                                                    >
                                                        <span className="pgi-class-nm">{c.entity}</span>
                                                        {c.category && (
                                                            <span className="pgi-class-cat">{c.category}</span>
                                                        )}
                                                    </button>
                                                ))}
                                                {allClasses && totalFiltered === 0 && (
                                                    <div className="pg-note">
                                                        No business classes match “{search}”.
                                                    </div>
                                                )}
                                            </div>
                                            <div className="pgi-pager">
                                                <button
                                                    type="button"
                                                    disabled={page <= 1}
                                                    onClick={() => setPage((p) => p - 1)}
                                                >
                                                    ‹
                                                </button>
                                                <span>
                                                    {totalFiltered.toLocaleString()} match
                                                    {totalFiltered === 1 ? '' : 'es'} · page {page}/{totalPages}
                                                </span>
                                                <button
                                                    type="button"
                                                    disabled={page >= totalPages}
                                                    onClick={() => setPage((p) => p + 1)}
                                                >
                                                    ›
                                                </button>
                                            </div>
                                            {cacheInfo && (
                                                <div className="pgi-cacheinfo">
                                                    <span>
                                                        {(allClasses?.length ?? 0).toLocaleString()} classes{' '}
                                                        {cacheInfo.fromCache ? 'cached' : 'downloaded'}{' '}
                                                        {new Date(cacheInfo.fetchedAt).toLocaleString()}
                                                    </span>
                                                    <button
                                                        type="button"
                                                        className="pgi-refresh"
                                                        disabled={classesLoading}
                                                        onClick={() => void refreshClasses()}
                                                    >
                                                        <RefreshCw
                                                            size={12}
                                                            className={classesLoading ? 'pg-spin' : undefined}
                                                        />
                                                        Refresh
                                                    </button>
                                                </div>
                                            )}
                                        </>
                                    )}
                                </>
                            )}
                        </div>

                        {selected && !pickerOpen && (
                            <>
                                {/* ---- Fields ---- */}
                                <div className="pgi-section">
                                    <div className="pgi-section-head">
                                        <div className="pgi-lbl">
                                            Fields <span className="pgi-maps">→ _fields</span>
                                        </div>
                                        <div className="pgi-acts">
                                            <a onClick={() => setChecked(new Set(fields))}>All</a>
                                            <a onClick={() => setChecked(new Set())}>None</a>
                                        </div>
                                    </div>
                                    {fieldsLoading ? (
                                        <div className="pg-note">
                                            <Loader2 size={13} className="pg-spin" /> Loading fields…
                                        </div>
                                    ) : (
                                        <>
                                            {fields.length > 0 && (
                                                <div className="pgi-search">
                                                    <Search size={13} strokeWidth={2} />
                                                    <input
                                                        placeholder={`Search ${fields.length} fields…`}
                                                        value={fieldSearch}
                                                        onChange={(e) => setFieldSearch(e.target.value)}
                                                    />
                                                </div>
                                            )}
                                            <div className="pgi-fieldbox">
                                                {visibleFields.map((f) => (
                                                    <label key={f} className="pgi-fl">
                                                        <input
                                                            type="checkbox"
                                                            checked={checked.has(f)}
                                                            onChange={() => toggleField(f)}
                                                        />
                                                        <span>{f}</span>
                                                    </label>
                                                ))}
                                                {fields.length === 0 && (
                                                    <div className="pg-note">
                                                        No sample fields — the class may have no rows.
                                                    </div>
                                                )}
                                                {fields.length > 0 && visibleFields.length === 0 && (
                                                    <div className="pg-note">No fields match “{fieldSearch}”.</div>
                                                )}
                                            </div>
                                        </>
                                    )}
                                    <div className="pgi-foot">
                                        {checked.size} selected
                                        {fieldSearch && ` · ${visibleFields.length} shown`}
                                    </div>
                                </div>

                                {/* ---- Filter ---- */}
                                <div className="pgi-section">
                                    <div className="pgi-section-head">
                                        <div className="pgi-lbl">
                                            Filter <span className="pgi-maps">→ _lplFilter</span>
                                        </div>
                                    </div>
                                    <FilterBuilder
                                        root={filterTree}
                                        fields={fields}
                                        onChange={setFilterTree}
                                    />
                                    {!isEmptyFilter(filterTree) && (
                                        <div
                                            className="pgi-fb-preview"
                                            title="Generated LPL, sent as _lplFilter"
                                        >
                                            {filterToLpl(filterTree)}
                                        </div>
                                    )}
                                </div>

                                {/* ---- Run ---- */}
                                <div className="pgi-run">
                                    <input
                                        type="checkbox"
                                        className="pgi-limitchk"
                                        checked={limitEnabled}
                                        onChange={(e) => setLimitEnabled(e.target.checked)}
                                        title="Apply a row limit (off = server default / all rows)"
                                        aria-label="Apply limit"
                                    />
                                    <label className="pgi-limit">
                                        <span>Limit</span>
                                        <input
                                            type="number"
                                            min={1}
                                            value={limit}
                                            disabled={!limitEnabled}
                                            onChange={(e) => setLimit(Math.max(1, Number(e.target.value) || 1))}
                                        />
                                    </label>
                                    <button
                                        type="button"
                                        className="pg-btn pg-btn--primary"
                                        disabled={running || checked.size === 0}
                                        onClick={() => void runQuery()}
                                    >
                                        {running ? (
                                            <Loader2 size={14} className="pg-spin" />
                                        ) : (
                                            <Play size={14} strokeWidth={2} />
                                        )}
                                        Run query
                                    </button>
                                    {applyNodeId && onApplyToNode && (
                                        <button
                                            type="button"
                                            className={`pg-btn${applied ? '' : ' pg-btn--primary'}`}
                                            onClick={applyToNode}
                                            disabled={!selected || checked.size === 0}
                                            title="Write this query back to the Infor node on the canvas"
                                        >
                                            {applied ? (
                                                <>
                                                    <Check size={14} strokeWidth={2} /> Applied to node
                                                </>
                                            ) : (
                                                <>
                                                    <ArrowUpToLine size={14} strokeWidth={2} /> Apply to node
                                                </>
                                            )}
                                        </button>
                                    )}
                                </div>

                                {/* ---- Save query (requires a description) ---- */}
                                <div className="pgi-saverow">
                                    <input
                                        className="pg-input"
                                        placeholder="Describe this query to save it…"
                                        value={saveDesc}
                                        onChange={(e) => setSaveDesc(e.target.value)}
                                    />
                                    <button
                                        type="button"
                                        className="pg-btn"
                                        disabled={!selected || checked.size === 0 || !saveDesc.trim()}
                                        onClick={saveCurrentQuery}
                                        title="Save this query (data area, business class, fields, filter) for reuse"
                                    >
                                        <Save size={14} strokeWidth={1.75} /> Save query
                                    </button>
                                </div>
                            </>
                        )}
                    </div>
                )}
            </div>

            {/* ---- Middle: saved queries (collapsible) ---- */}
            {session &&
                (savedOpen ? (
                    <div className="pgi-saved">
                        <div className="pgi-saved-head">
                            <span className="pgi-saved-title">
                                <Bookmark size={13} strokeWidth={2} /> Saved queries
                            </span>
                            <button
                                type="button"
                                className="pg-icon-btn"
                                onClick={() => setSavedOpen(false)}
                                title="Collapse"
                            >
                                <ChevronLeft size={14} />
                            </button>
                        </div>
                        <div className="pgi-search">
                            <Search size={13} strokeWidth={2} />
                            <input
                                placeholder="Search saved queries…"
                                value={savedSearch}
                                onChange={(e) => setSavedSearch(e.target.value)}
                            />
                        </div>
                        <div className="pgi-saved-list">
                            {filteredSaved.length === 0 ? (
                                <div className="pg-note">
                                    No saved queries for {dataArea}. Build one on the left and use
                                    “Save query”.
                                </div>
                            ) : (
                                filteredSaved.map((q) => (
                                    <div key={q.id} className="pgi-saved-item">
                                        <button
                                            type="button"
                                            className="pgi-saved-open"
                                            onClick={() => void loadSavedQuery(q)}
                                            title="Load this query"
                                        >
                                            <span className="pgi-saved-bc">{q.businessClass}</span>
                                            {q.description && (
                                                <span className="pgi-saved-desc">{q.description}</span>
                                            )}
                                            <span className="pgi-saved-cols">
                                                {q.fields.length} column{q.fields.length === 1 ? '' : 's'}
                                            </span>
                                        </button>
                                        <div className="pgi-saved-actions">
                                            <button
                                                type="button"
                                                className="pg-icon-btn"
                                                onClick={() => exportQueryFile(q)}
                                                title="Export as JSON"
                                            >
                                                <Download size={12} />
                                            </button>
                                            <button
                                                type="button"
                                                className="pg-icon-btn"
                                                onClick={() => deleteSavedQuery(q.id)}
                                                title="Delete"
                                            >
                                                <Trash2 size={12} />
                                            </button>
                                        </div>
                                    </div>
                                ))
                            )}
                        </div>
                        <button
                            type="button"
                            className="pg-btn pgi-saved-import"
                            onClick={() => importRef.current?.click()}
                            title="Import a query JSON file"
                        >
                            <Upload size={13} strokeWidth={1.75} /> Import query…
                        </button>
                        <input
                            ref={importRef}
                            type="file"
                            accept="application/json,.json"
                            hidden
                            onChange={(e) => {
                                void handleImportQuery(e.target.files?.[0] ?? null);
                                e.target.value = '';
                            }}
                        />
                    </div>
                ) : (
                    <button
                        type="button"
                        className="pgi-saved-rail"
                        onClick={() => setSavedOpen(true)}
                        title="Saved queries"
                    >
                        <ChevronRight size={14} />
                        <Bookmark size={13} strokeWidth={2} />
                    </button>
                ))}

            {/* ---- Right: results grid ---- */}
            <div className="pgi-main">
                {!session ? (
                    <div className="pgi-mainempty">
                        <Plug size={34} strokeWidth={1.25} />
                        <p>Import your ION API .ionapi and sign in on the left to browse business classes and run queries.</p>
                    </div>
                ) : !selected || pickerOpen ? (
                    <div className="pgi-mainempty">
                        <Boxes size={34} strokeWidth={1.25} />
                        <p>Pick a business class to build a query.</p>
                    </div>
                ) : queryError ? (
                    <div className="pg-errors" role="alert">
                        <div className="pg-errors-head">Query failed</div>
                        <ul>
                            <li>
                                <span>{queryError}</span>
                            </li>
                        </ul>
                    </div>
                ) : result ? (
                    <div className="pgi-results">
                        <div className="pgi-results-bar">
                            <Boxes size={13} strokeWidth={2} /> {result.rows.length} row
                            {result.rows.length === 1 ? '' : 's'}
                            {result.next ? ' · more available' : ''}
                        </div>
                        <div className="pgi-grid-wrap">
                            <table className="pgi-grid">
                                <thead>
                                    <tr>
                                        <th className="pgi-rownum">#</th>
                                        {columns.map((col) => (
                                            <th key={col}>{col}</th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {result.rows.map((row, i) => (
                                        <tr key={i}>
                                            <td className="pgi-rownum">{i + 1}</td>
                                            {columns.map((col) => (
                                                <td key={col}>{formatCell(row[col])}</td>
                                            ))}
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                ) : (
                    <div className="pgi-mainempty">
                        <Play size={34} strokeWidth={1.25} />
                        <p>Choose fields and run the query to see results.</p>
                    </div>
                )}
            </div>
        </div>
    );
}

function formatCell(v: unknown): string {
    if (v === null || v === undefined) return '';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
}
