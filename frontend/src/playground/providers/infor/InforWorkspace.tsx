import { useEffect, useMemo, useState } from 'react';
import { Search, ChevronDown, Play, Loader2, Plus, Trash2, Boxes, RefreshCw, Plug, Check, ArrowUpToLine } from 'lucide-react';
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
import {
    runGenericQuery,
    sampleFields,
    buildSimpleFilter,
    parseSimpleFilter,
    type FilterCondition,
    type InforNodeQuery,
} from './query';
import type { GenericPage } from './inforApi';

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
    const [conds, setConds] = useState<FilterCondition[]>([]);
    const [limit, setLimit] = useState(DEFAULT_LIMIT);
    const [running, setRunning] = useState(false);
    const [result, setResult] = useState<GenericPage | null>(null);
    const [queryError, setQueryError] = useState<string | null>(null);

    // ---- round-trip with a Canvas node (opened via "Open in Playground") ----
    // The node we'll write back to, and its query held until sign-in + the
    // class list are ready (the user may open before signing in).
    const [applyNodeId, setApplyNodeId] = useState<string | null>(null);
    const [pendingQuery, setPendingQuery] = useState<InforNodeQuery | null>(null);
    const [applied, setApplied] = useState(false);

    const applyFetched = async (config: IonApiConfig, classes: BusinessClass[]) => {
        setAllClasses(classes);
        const now = new Date().toISOString();
        setCacheInfo({ fetchedAt: now, fromCache: false });
        if (workspacePath && cacheAvailable()) {
            try {
                await saveCachedClasses(workspacePath, config.tenant, classes, now);
            } catch {
                /* cache write is best-effort */
            }
        }
    };

    // On sign-in, load the full class list once (cache first, else download).
    useEffect(() => {
        if (!session) return;
        const { config, token } = session;
        let cancelled = false;
        (async () => {
            setClassesLoading(true);
            setClassesError(null);
            if (workspacePath && cacheAvailable()) {
                const cached = await loadCachedClasses(workspacePath, config.tenant);
                if (cancelled) return;
                if (cached) {
                    setAllClasses(cached.classes);
                    setCacheInfo({ fetchedAt: cached.fetchedAt, fromCache: true });
                    setClassesLoading(false);
                    return;
                }
            }
            const res = await fetchAllBusinessClasses(config, token.accessToken, workspacePath);
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
    }, [session, workspacePath]);

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
        // New / unconfigured node → start blank (do NOT carry over prior state).
        if (!q.businessClass) {
            setSelected(null);
            setPickerOpen(true);
            setSearch('');
            setPage(1);
            setFields([]);
            setChecked(new Set());
            setFieldSearch('');
            setConds([]);
            setLimit(DEFAULT_LIMIT);
            return;
        }
        // Saved query → populate the builder from it.
        setLimit(typeof q.limit === 'number' && q.limit > 0 ? q.limit : DEFAULT_LIMIT);
        setConds(parseSimpleFilter(q.filter));
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
    }, [checked, conds, limit, selected]);

    const applyToNode = () => {
        if (!onApplyToNode || !applyNodeId || !selected) return;
        const activeFields = fields.length ? fields.filter((f) => checked.has(f)) : Array.from(checked);
        onApplyToNode(applyNodeId, {
            businessClass: selected.entity,
            fields: activeFields.join(','),
            filter: buildSimpleFilter(conds),
            limit,
        });
        setApplied(true);
    };

    const refreshClasses = async () => {
        if (!session) return;
        setClassesLoading(true);
        setClassesError(null);
        const res = await fetchAllBusinessClasses(
            session.config,
            session.token.accessToken,
            workspacePath,
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
        setResult(null);
        setQueryError(null);
        setConds([]);
        setFields([]);
        setChecked(new Set());
        setFieldSearch('');
        setFieldsLoading(true);
        const res = await sampleFields(session.config, session.token.accessToken, bc.entity, workspacePath);
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
            { fields: fields.filter((f) => checked.has(f)), filter: conds, limit },
            workspacePath,
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
                                            Filter <span className="pgi-maps">→ _filter</span>
                                        </div>
                                    </div>
                                    <div className="pgi-filters">
                                        {conds.map((c, i) => (
                                            <div className="pgi-frow" key={i}>
                                                <input
                                                    className="pg-input"
                                                    placeholder="Field"
                                                    value={c.field}
                                                    onChange={(e) =>
                                                        setConds((cs) =>
                                                            cs.map((x, j) =>
                                                                j === i ? { ...x, field: e.target.value } : x,
                                                            ),
                                                        )
                                                    }
                                                />
                                                <span className="pgi-op">::</span>
                                                <input
                                                    className="pg-input"
                                                    placeholder="Value"
                                                    value={c.value}
                                                    onChange={(e) =>
                                                        setConds((cs) =>
                                                            cs.map((x, j) =>
                                                                j === i ? { ...x, value: e.target.value } : x,
                                                            ),
                                                        )
                                                    }
                                                />
                                                <button
                                                    type="button"
                                                    className="pg-icon-btn"
                                                    onClick={() => setConds((cs) => cs.filter((_, j) => j !== i))}
                                                >
                                                    <Trash2 size={13} />
                                                </button>
                                            </div>
                                        ))}
                                        <button
                                            type="button"
                                            className="pgi-add"
                                            onClick={() => setConds((cs) => [...cs, { field: '', value: '' }])}
                                        >
                                            <Plus size={13} /> Add condition
                                        </button>
                                    </div>
                                </div>

                                {/* ---- Run ---- */}
                                <div className="pgi-run">
                                    <label className="pgi-limit">
                                        <span>Limit</span>
                                        <input
                                            type="number"
                                            min={1}
                                            value={limit}
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
                            </>
                        )}
                    </div>
                )}
            </div>

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
