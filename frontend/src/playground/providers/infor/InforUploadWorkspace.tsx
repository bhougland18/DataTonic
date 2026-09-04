import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Plug, Search, ChevronDown, Loader2, ArrowUpToLine } from 'lucide-react';
import InforProvider from '../InforProvider';
import type { PlaygroundConnection, credentialsToPayload } from '../../connectionBridge';
import type { IonApiConfig } from './ionapi';
import type { IonApiToken } from './inforAuth';
import { fetchClassSwagger, type BusinessClass } from './discovery';
import {
    cacheAvailable,
    fetchAllBusinessClasses,
    loadCachedClasses,
    saveCachedClasses,
} from './classCache';
import { parsePostActions, type InforAction } from './inforActions';
import { DATA_AREAS, restBase, type DataAreaId } from './inforApi';
import { sendRequest } from '../../sendClient';

function fmtCell(v: unknown): string {
    if (v === null || v === undefined) return '';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
}

interface TestRecordResult {
    id: string;
    message: string;
    ok: boolean;
}
interface TestSummary {
    httpStatus: number;
    batchStatus?: string;
    records: TestRecordResult[];
    overallOk: boolean;
    raw?: string;
}

// Parse the Action Batch Service response - an array of { _fields, message } per
// record plus a trailing { batchStatus } (0 = success). The FULL message is kept:
// error messages are long and descriptive and the user needs every word. Falls
// back to the raw body when the shape differs.
function summarizeBatch(status: number, body: string): TestSummary {
    try {
        const parsed: unknown = JSON.parse(body);
        if (Array.isArray(parsed)) {
            let batchStatus: string | undefined;
            const records: TestRecordResult[] = [];
            for (const el of parsed) {
                if (!el || typeof el !== 'object') continue;
                const o = el as Record<string, unknown>;
                if ('batchStatus' in o) {
                    batchStatus = String(o.batchStatus);
                    continue;
                }
                // A failed record comes back as {"exception": {...}} (Landmark
                // ViewException) — no _fields, no top-level message, and
                // batchStatus stays "0". This is the only per-record failure
                // signal, so detect it before the success shape.
                const exc =
                    o.exception && typeof o.exception === 'object'
                        ? (o.exception as Record<string, unknown>)
                        : null;
                if (exc) {
                    const base = String(exc.viewMessage ?? exc.message ?? 'upload failed');
                    const field = String(exc.fieldName ?? '');
                    records.push({
                        id: '',
                        message: field ? `${base} (field ${field})` : base,
                        ok: false,
                    });
                    continue;
                }
                const fields =
                    o._fields && typeof o._fields === 'object'
                        ? (o._fields as Record<string, unknown>)
                        : {};
                const message = String(o.message ?? '');
                const id = String(fields.Item ?? Object.values(fields)[0] ?? '');
                const ok = !/error|fail|invalid|denied|cannot|unable|reject/i.test(message);
                records.push({ id, message, ok });
            }
            const overallOk =
                status >= 200 &&
                status < 300 &&
                (batchStatus === undefined || batchStatus === '0') &&
                records.every((r) => r.ok);
            return { httpStatus: status, batchStatus, records, overallOk, raw: body };
        }
    } catch {
        /* not JSON - fall through to raw */
    }
    return { httpStatus: status, records: [], overallOk: status >= 200 && status < 300, raw: body };
}

export interface UploadOpenRequest {
    nonce: number;
    nodeId: string;
    businessClass?: string;
    dataArea?: DataAreaId;
    action?: string;
    /** Columns of the dataset feeding this sink node (its main-input upstream). */
    datasetColumns?: string[];
    /** Cached preview rows from the upstream node (populated after a run). */
    datasetRows?: Record<string, unknown>[];
    /** The sink node's OWN cached output after a run: the results relation
     *  (input columns + _status + _message), shown in the Results tab. */
    resultRows?: Record<string, unknown>[];
    /** The node's saved mapping/options, to restore on re-open. */
    mapping?: Record<string, string>;
    confirmWarnings?: boolean;
    trimAlpha?: boolean;
}

// What "Apply to node" writes back to the snk.infor node's props.
export interface UploadApplyConfig {
    dataArea: DataAreaId;
    businessClass: string;
    action: string;
    /** API field -> dataset column. A field is uploaded iff it is mapped. */
    mapping: Record<string, string>;
    confirmWarnings: boolean;
    trimAlpha: boolean;
}

interface InforUploadWorkspaceProps {
    workspacePath: string | null;
    connections?: PlaygroundConnection[];
    onSaveConnection?: (name: string, payload: ReturnType<typeof credentialsToPayload>) => string;
    openRequest?: UploadOpenRequest | null;
    onApply?: (nodeId: string, cfg: UploadApplyConfig) => void;
}

const PAGE_SIZE = 25;

// P1 of the Infor upload sink: prove the write-side discovery in the rail. Sign
// in, pick a business class, fetch its swagger, and list the POST actions plus
// the selected action's fields. Mirrors InforWorkspace's layout (pgi-* classes),
// class discovery, and its ranked + paginated class picker so the look, feel and
// search behaviour match the query Playground. The column->field mapper + write-
// back land in P2, the batch upload in P3.
export default function InforUploadWorkspace({
    workspacePath,
    connections = [],
    onSaveConnection,
    openRequest,
    onApply,
}: InforUploadWorkspaceProps) {
    const [session, setSession] = useState<{ config: IonApiConfig; token: IonApiToken } | null>(null);
    const [dataArea, setDataArea] = useState<DataAreaId>(openRequest?.dataArea ?? 'FSM');
    const [classes, setClasses] = useState<BusinessClass[] | null>(null);
    const [classesLoading, setClassesLoading] = useState(false);
    const [search, setSearch] = useState('');
    const [page, setPage] = useState(1);
    const [pickerOpen, setPickerOpen] = useState(false);
    const [selectedClass, setSelectedClass] = useState<BusinessClass | null>(null);
    const [actions, setActions] = useState<InforAction[]>([]);
    const [action, setAction] = useState(openRequest?.action ?? '');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [note, setNote] = useState<string | null>(null);

    // Pre-fill the class search from the node's saved class on (re)open.
    useEffect(() => {
        if (openRequest?.businessClass) setSearch(openRequest.businessClass);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [openRequest?.nonce]);

    // Load the class list once signed in (cache-first, same path as the source).
    useEffect(() => {
        if (!session) return;
        let cancelled = false;
        setClassesLoading(true);
        void (async () => {
            const tenant = session.config.tenant;
            let list: BusinessClass[] | null = null;
            if (workspacePath) {
                const cached = await loadCachedClasses(workspacePath, tenant, dataArea);
                if (cached) list = cached.classes;
            }
            if (!list && cacheAvailable()) {
                const res = await fetchAllBusinessClasses(
                    session.config,
                    session.token.accessToken,
                    workspacePath,
                    dataArea,
                );
                if (res.ok) {
                    list = res.classes;
                    if (workspacePath) {
                        await saveCachedClasses(
                            workspacePath,
                            tenant,
                            res.classes,
                            new Date().toISOString(),
                            dataArea,
                        );
                    }
                }
            }
            if (!cancelled) {
                setClasses(list ?? []);
                setClassesLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [session, dataArea, workspacePath]);

    // Ranked search (exact -> startsWith -> contains, then alphabetical), matching
    // the source picker, then paginate — no more silent 50-item cap.
    const filtered = useMemo(() => {
        const all = classes ?? [];
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
    }, [classes, search]);

    const totalFiltered = filtered.length;
    const totalPages = Math.max(1, Math.ceil(totalFiltered / PAGE_SIZE));
    const pageItems = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

    async function pickClass(cls: BusinessClass) {
        if (!session) return;
        setSelectedClass(cls);
        setPickerOpen(false);
        setActions([]);
        setAction('');
        setError(null);
        setNote(null);
        if (!cls.swaggerEndpoint) {
            setError(`"${cls.entity}" has no swaggerEndpoint to read actions from.`);
            return;
        }
        setBusy(true);
        const res = await fetchClassSwagger(
            session.config,
            session.token.accessToken,
            cls.swaggerEndpoint,
            workspacePath,
            dataArea,
        );
        setBusy(false);
        if (!res.ok) {
            setError(res.error);
            return;
        }
        const parsed = parsePostActions(res.swagger);
        setActions(parsed.actions);
        if (!parsed.actions.length) setNote('No actions found in this class swagger.');
        else if (!parsed.batchSupported) setNote('Heads-up: this class exposes no batch upload service.');
    }

    const selectedAction = useMemo(
        () => actions.find((a) => a.name === action) ?? null,
        [actions, action],
    );

    const datasetColumns = openRequest?.datasetColumns ?? [];
    const datasetRows = openRequest?.datasetRows ?? [];

    // --- P2: field -> column mapping + upload options ---
    const [mapping, setMapping] = useState<Record<string, string>>({});
    const [fieldSearch, setFieldSearch] = useState('');
    const [showMappedOnly, setShowMappedOnly] = useState(false);
    const [actionPickerOpen, setActionPickerOpen] = useState(false);
    const [actionSearch, setActionSearch] = useState('');
    const [confirmWarnings, setConfirmWarnings] = useState(openRequest?.confirmWarnings ?? false);
    const [trimAlpha, setTrimAlpha] = useState(openRequest?.trimAlpha ?? true);
    const [appliedNonce, setAppliedNonce] = useState(0);
    const [testRows, setTestRows] = useState(2);
    const [testing, setTesting] = useState(false);
    const [testResult, setTestResult] = useState<TestSummary | null>(null);

    // Right-pane tabs: the connected dataset (map-from source) vs the per-record
    // results of the last pipeline run (the sink node's own output relation).
    const [mainTab, setMainTab] = useState<'dataset' | 'results'>('dataset');
    // The results grid can be filtered to a single message ("error type") by
    // clicking a segment of the roll-up bar; null = show all.
    const [msgFilter, setMsgFilter] = useState<string | null>(null);
    const resultRows = openRequest?.resultRows ?? [];
    const hasResults = resultRows.length > 0;
    const statusOf = (r: Record<string, unknown>) =>
        String(r['_status'] ?? '').toLowerCase();
    const messageOf = (r: Record<string, unknown>) => String(r['_message'] ?? '');
    // Result columns in first-seen order: input columns, then _status / _message
    // as the engine appends them.
    const resultColumns: string[] = [];
    for (const r of resultRows)
        for (const k of Object.keys(r)) if (!resultColumns.includes(k)) resultColumns.push(k);
    const resultCounts = { ok: 0, error: 0, skipped: 0, other: 0 };
    for (const r of resultRows) {
        const s = statusOf(r);
        if (s === 'ok') resultCounts.ok++;
        else if (s === 'error') resultCounts.error++;
        else if (s === 'skipped') resultCounts.skipped++;
        else resultCounts.other++;
    }
    // Roll up by message ("error type"). Status is a deterministic function of
    // the message, so each group carries one status -> one colour. Sorted by
    // count so the biggest buckets read left-to-right.
    const msgGroups: { message: string; status: string; count: number }[] = [];
    {
        const idx = new Map<string, number>();
        for (const r of resultRows) {
            const message = messageOf(r);
            let i = idx.get(message);
            if (i === undefined) {
                i = msgGroups.length;
                idx.set(message, i);
                msgGroups.push({ message, status: statusOf(r), count: 0 });
            }
            msgGroups[i].count++;
        }
        msgGroups.sort((a, b) => b.count - a.count);
    }
    const filteredResults =
        msgFilter == null ? resultRows : resultRows.filter(r => messageOf(r) === msgFilter);

    // On (re)open, surface the Results tab when the last run produced results.
    useEffect(() => {
        setMainTab(openRequest?.resultRows?.length ? 'results' : 'dataset');
        setMsgFilter(null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [openRequest?.nonce]);

    // Auto-map fields -> columns by name (case-insensitive). A field is uploaded
    // iff it is mapped, so this is also the include/exclude.
    const autoMap = () => {
        const byLower = new Map(datasetColumns.map((c) => [c.toLowerCase(), c] as const));
        const next: Record<string, string> = {};
        for (const f of selectedAction?.fields ?? []) {
            const hit = byLower.get(f.name.toLowerCase());
            if (hit) next[f.name] = hit;
        }
        setMapping(next);
    };

    // On (re)open or action switch: restore the node's saved mapping if it is for
    // this action, otherwise auto-map by name.
    useEffect(() => {
        if (!selectedAction) return;
        const saved = openRequest?.mapping;
        if (saved && openRequest?.action === selectedAction.name && Object.keys(saved).length) {
            setMapping(saved);
        } else {
            autoMap();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedAction?.name, datasetColumns.length, openRequest?.nonce]);

    const setField = (field: string, column: string) =>
        setMapping((m) => {
            const next = { ...m };
            if (column) next[field] = column;
            else delete next[field];
            return next;
        });

    const filteredActions = useMemo(() => {
        const q = actionSearch.trim().toLowerCase();
        if (!q) return actions;
        const rank = (n: string) => {
            const s = n.toLowerCase();
            if (s === q) return 0;
            if (s.startsWith(q)) return 1;
            return 2;
        };
        return actions
            .filter((a) => a.name.toLowerCase().includes(q))
            .sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
    }, [actions, actionSearch]);

    const visibleFields = useMemo(() => {
        const q = fieldSearch.trim().toLowerCase();
        let list = selectedAction?.fields ?? [];
        if (showMappedOnly) list = list.filter((f) => mapping[f.name]);
        if (q) list = list.filter((f) => f.name.toLowerCase().includes(q));
        return list;
    }, [selectedAction, fieldSearch, showMappedOnly, mapping]);

    const mappedCount = useMemo(
        () => (selectedAction?.fields ?? []).filter((f) => mapping[f.name]).length,
        [selectedAction, mapping],
    );
    const unmappedRequired = useMemo(
        () => (selectedAction?.fields ?? []).filter((f) => f.required && !mapping[f.name]),
        [selectedAction, mapping],
    );

    const apply = () => {
        if (!onApply || !openRequest || !selectedClass || !selectedAction) return;
        onApply(openRequest.nodeId, {
            dataArea,
            businessClass: selectedClass.entity,
            action: selectedAction.name,
            mapping,
            confirmWarnings,
            trimAlpha,
        });
        setAppliedNonce((n) => n + 1);
    };

    // Fire a REAL batch upload of the first N preview rows to validate the mapping
    // live (Infor has no dry-run; these records are actually created/updated).
    const testUpload = async () => {
        if (!session || !selectedClass || !selectedAction) return;
        const rows = datasetRows.slice(0, Math.max(1, testRows));
        if (!rows.length) {
            setTestResult({
                httpStatus: 0,
                records: [],
                overallOk: false,
                raw: 'No preview rows to test — run the pipeline once so the upstream data is available.',
            });
            return;
        }
        const records = rows.map((row) => {
            const fields: Record<string, string> = {};
            for (const [apiField, col] of Object.entries(mapping)) {
                let v = fmtCell(row[col]);
                if (trimAlpha) v = v.trim();
                fields[apiField] = v;
            }
            return { _fields: fields };
        });
        const url =
            `${restBase(session.config, dataArea)}/classes/${encodeURIComponent(selectedClass.entity)}` +
            `/actions/${encodeURIComponent(selectedAction.name)}/batch?_maxFailures=-1`;
        setTesting(true);
        setTestResult(null);
        const outcome = await sendRequest(
            {
                url,
                method: 'POST',
                headers: [{ key: 'Content-Type', value: 'application/json' }],
                body: JSON.stringify({ _records: records }),
                authType: 'bearer',
                authToken: session.token.accessToken,
            },
            workspacePath,
        );
        setTesting(false);
        if (outcome.kind === 'unavailable') {
            setTestResult({
                httpStatus: 0,
                records: [],
                overallOk: false,
                raw: 'Send backend unavailable in this session.',
            });
            return;
        }
        if (outcome.kind === 'network-error') {
            setTestResult({
                httpStatus: 0,
                records: [],
                overallOk: false,
                raw: `Network error: ${outcome.message}`,
            });
            return;
        }
        setTestResult(summarizeBatch(outcome.response.status, outcome.response.body));
    };

    return (
        <div className="pgi">
            {/* ---- Left: provider + credentials + upload target + fields ---- */}
            <div className="pgi-props" style={{ width: 540 }}>
                <header className="pg-sidebar-head">
                    <Plug size={16} strokeWidth={1.75} />
                    <h2>Infor Upload</h2>
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
                                onChange={(e) => {
                                    setDataArea(e.target.value as DataAreaId);
                                    setClasses(null);
                                    setSelectedClass(null);
                                    setActions([]);
                                    setAction('');
                                    setPickerOpen(false);
                                }}
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
                            {selectedClass && !pickerOpen ? (
                                <button
                                    type="button"
                                    className="pgi-selected"
                                    onClick={() => setPickerOpen(true)}
                                >
                                    <span className="pgi-selected-nm">{selectedClass.entity}</span>
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
                                    {classesLoading && !classes ? (
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
                                                        className={`pgi-class${
                                                            selectedClass?.entity === c.entity ? ' pgi-class--sel' : ''
                                                        }`}
                                                        onClick={() => void pickClass(c)}
                                                        title={c.desc}
                                                    >
                                                        <span className="pgi-class-nm">{c.entity}</span>
                                                        {c.category && (
                                                            <span className="pgi-class-cat">{c.category}</span>
                                                        )}
                                                    </button>
                                                ))}
                                                {classes && totalFiltered === 0 && (
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
                                        </>
                                    )}
                                </>
                            )}
                        </div>

                        {/* ---- Action ---- */}
                        {selectedClass && (
                            <div className="pgi-section">
                                <div className="pgi-lbl">Action</div>
                                {busy ? (
                                    <div className="pg-note">
                                        <Loader2 size={13} className="pg-spin" /> Loading actions…
                                    </div>
                                ) : action && !actionPickerOpen ? (
                                    <button
                                        type="button"
                                        className="pgi-selected"
                                        onClick={() => {
                                            setActionSearch('');
                                            setActionPickerOpen(true);
                                        }}
                                    >
                                        <span className="pgi-selected-nm">{action}</span>
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
                                                placeholder="Search actions…"
                                                value={actionSearch}
                                                onChange={(e) => setActionSearch(e.target.value)}
                                            />
                                        </div>
                                        <div className="pgi-classlist" style={{ maxHeight: 240 }}>
                                            {filteredActions.map((a) => (
                                                <button
                                                    key={a.name}
                                                    type="button"
                                                    className={`pgi-class${
                                                        a.name === action ? ' pgi-class--sel' : ''
                                                    }`}
                                                    onClick={() => {
                                                        setAction(a.name);
                                                        setActionPickerOpen(false);
                                                        setActionSearch('');
                                                    }}
                                                >
                                                    <span className="pgi-class-nm">{a.name}</span>
                                                </button>
                                            ))}
                                            {!filteredActions.length && (
                                                <div className="pg-note">
                                                    No actions match “{actionSearch}”.
                                                </div>
                                            )}
                                        </div>
                                    </>
                                )}
                                {error && (
                                    <div
                                        className="pg-note"
                                        style={{ color: 'var(--danger)', whiteSpace: 'pre-line' }}
                                    >
                                        {error}
                                    </div>
                                )}
                                {note && (
                                    <div className="pg-note" style={{ whiteSpace: 'pre-line' }}>
                                        {note}
                                    </div>
                                )}
                            </div>
                        )}

                        {/* ---- Field map: field -> dataset column ---- */}
                        {selectedAction && (
                            <div className="pgi-section">
                                <div
                                    className="pgi-lbl"
                                    style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                                >
                                    <span style={{ flex: 1 }}>Field map</span>
                                    <label
                                        style={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: 4,
                                            fontWeight: 400,
                                            textTransform: 'none',
                                            letterSpacing: 0,
                                        }}
                                    >
                                        <input
                                            type="checkbox"
                                            checked={showMappedOnly}
                                            onChange={(e) => setShowMappedOnly(e.target.checked)}
                                        />
                                        mapped only
                                    </label>
                                    <button
                                        type="button"
                                        className="pg-btn"
                                        onClick={autoMap}
                                        disabled={!datasetColumns.length}
                                    >
                                        Auto-map
                                    </button>
                                </div>
                                {!datasetColumns.length && (
                                    <div className="pg-note">
                                        Connect a dataset to this node to map fields to its columns.
                                    </div>
                                )}
                                <div className="pgi-search">
                                    <Search size={13} strokeWidth={2} />
                                    <input
                                        placeholder="Search fields…"
                                        value={fieldSearch}
                                        onChange={(e) => setFieldSearch(e.target.value)}
                                    />
                                </div>
                                <div className="pgi-classlist" style={{ maxHeight: 300 }}>
                                    {visibleFields.map((f) => (
                                        <div
                                            key={f.name}
                                            style={{
                                                display: 'flex',
                                                alignItems: 'center',
                                                gap: 8,
                                                padding: '4px 8px',
                                            }}
                                        >
                                            <span
                                                title={f.name}
                                                style={{
                                                    flex: 1,
                                                    minWidth: 0,
                                                    overflow: 'hidden',
                                                    textOverflow: 'ellipsis',
                                                    whiteSpace: 'nowrap',
                                                    color: f.required ? 'var(--accent, #e8590c)' : undefined,
                                                    fontWeight: f.required ? 600 : 400,
                                                }}
                                            >
                                                {f.name}
                                                {f.required && !mapping[f.name] ? ' ⚠' : ''}
                                            </span>
                                            <select
                                                className="pg-input pg-input--select"
                                                style={{ width: 200, flexShrink: 0 }}
                                                value={mapping[f.name] ?? ''}
                                                onChange={(e) => setField(f.name, e.target.value)}
                                            >
                                                <option value=""></option>
                                                {datasetColumns.map((c) => (
                                                    <option key={c} value={c}>
                                                        {c}
                                                    </option>
                                                ))}
                                            </select>
                                        </div>
                                    ))}
                                </div>
                                <div className="pg-note">
                                    {mappedCount} of {selectedAction.fields.length} fields mapped
                                    {unmappedRequired.length
                                        ? ` · ${unmappedRequired.length} required key${
                                              unmappedRequired.length === 1 ? '' : 's'
                                          } unmapped`
                                        : ''}
                                </div>
                            </div>
                        )}

                        {/* ---- Upload options + apply to node ---- */}
                        {selectedAction && (
                            <div className="pgi-section">
                                <div className="pgi-lbl">Upload options</div>
                                <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                    <input
                                        type="checkbox"
                                        checked={confirmWarnings}
                                        onChange={(e) => setConfirmWarnings(e.target.checked)}
                                    />
                                    Confirm all warnings
                                </label>
                                <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                    <input
                                        type="checkbox"
                                        checked={trimAlpha}
                                        onChange={(e) => setTrimAlpha(e.target.checked)}
                                    />
                                    Trim alpha fields
                                </label>

                                {/* ---- Test: send a couple real records to validate ---- */}
                                <div
                                    style={{
                                        marginTop: 10,
                                        paddingTop: 8,
                                        borderTop: '1px solid var(--border)',
                                        display: 'flex',
                                        flexDirection: 'column',
                                        gap: 6,
                                    }}
                                >
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                        Test
                                        <input
                                            type="number"
                                            min={1}
                                            value={testRows}
                                            onChange={(e) =>
                                                setTestRows(Math.max(1, Number(e.target.value) || 1))
                                            }
                                            style={{ width: 60 }}
                                        />
                                        rows
                                        <button
                                            type="button"
                                            className="pg-btn"
                                            onClick={testUpload}
                                            disabled={testing || !mappedCount || !datasetRows.length}
                                        >
                                            {testing ? 'Testing…' : 'Test upload'}
                                        </button>
                                    </div>
                                    <div className="pg-note" style={{ color: 'var(--danger)' }}>
                                        ⚠ Sends the first {testRows} row{testRows === 1 ? '' : 's'} to Infor for
                                        real ({selectedAction.name} creates/updates records) — Infor has no
                                        dry-run. Use it to validate the mapping before Apply.
                                    </div>
                                </div>

                                <button
                                    type="button"
                                    className="pg-btn pg-btn--primary"
                                    style={{ marginTop: 8 }}
                                    onClick={apply}
                                    disabled={!onApply || !mappedCount}
                                >
                                    <ArrowUpToLine size={14} /> Apply to node
                                </button>
                                {appliedNonce > 0 && (
                                    <div className="pg-note" style={{ color: 'var(--ok, #2b8a3e)' }}>
                                        Applied {mappedCount} mapped field{mappedCount === 1 ? '' : 's'} to the
                                        node.
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* ---- Right: the connected dataset (maps to the fields on the left) ---- */}
            <div className="pgi-main">
                {!session ? (
                    <div className="pgi-mainempty">
                        <Plug size={40} strokeWidth={1.25} />
                        <h3>Sign in to upload</h3>
                        <p>Authenticate on the left, then pick a business class and an action.</p>
                    </div>
                ) : datasetColumns.length === 0 && !hasResults ? (
                    <div className="pgi-mainempty">
                        <p>Connect a dataset to this node — its data appears here to map from.</p>
                    </div>
                ) : (
                    <>
                        <div className="pgi-tabs" role="tablist" aria-label="Upload panes">
                            <button
                                type="button"
                                role="tab"
                                aria-selected={mainTab === 'dataset'}
                                className="pgi-tab"
                                onClick={() => setMainTab('dataset')}
                            >
                                Dataset{datasetRows.length ? ` · ${datasetRows.length}` : ''}
                            </button>
                            <button
                                type="button"
                                role="tab"
                                aria-selected={mainTab === 'results'}
                                className="pgi-tab"
                                disabled={!hasResults}
                                title={
                                    hasResults
                                        ? undefined
                                        : 'Run the pipeline to see per-record upload results'
                                }
                                onClick={() => setMainTab('results')}
                            >
                                Results{hasResults ? ` · ${resultRows.length}` : ''}
                            </button>
                        </div>
                        {mainTab === 'results' && hasResults ? (
                            <div className="pgi-results">
                                {/* Single stacked bar: one segment per message
                                    ("error type"), width ∝ count, colour by
                                    status. Hover = message + count; click =
                                    filter the grid to that message. */}
                                <div
                                    className="pgi-msgbar"
                                    role="group"
                                    aria-label="Results by message — click a segment to filter"
                                >
                                    {msgGroups.map((g) => {
                                        const selected = msgFilter === g.message;
                                        return (
                                            <button
                                                key={g.message || '(none)'}
                                                type="button"
                                                className={
                                                    `pgi-msgseg pgi-msgseg-${g.status || 'other'}` +
                                                    (selected ? ' is-selected' : '') +
                                                    (msgFilter && !selected ? ' is-dim' : '')
                                                }
                                                style={{ flexGrow: g.count }}
                                                title={`${g.message || '(no message)'} — ${g.count} of ${resultRows.length}`}
                                                aria-pressed={selected}
                                                onClick={() =>
                                                    setMsgFilter(selected ? null : g.message)
                                                }
                                            >
                                                <span className="pgi-msgseg-label">{g.count}</span>
                                            </button>
                                        );
                                    })}
                                </div>
                                <div className="pgi-results-bar">
                                    {resultRows.length} record{resultRows.length === 1 ? '' : 's'}
                                    {resultCounts.ok ? ` · ${resultCounts.ok} ok` : ''}
                                    {resultCounts.error ? ` · ${resultCounts.error} error` : ''}
                                    {resultCounts.skipped ? ` · ${resultCounts.skipped} skipped` : ''}
                                    {msgFilter != null && (
                                        <>
                                            <span style={{ flex: 1 }} />
                                            <span
                                                style={{
                                                    fontWeight: 500,
                                                    maxWidth: 360,
                                                    overflow: 'hidden',
                                                    textOverflow: 'ellipsis',
                                                    whiteSpace: 'nowrap',
                                                }}
                                                title={msgFilter || '(no message)'}
                                            >
                                                Showing {filteredResults.length}: {msgFilter || '(no message)'}
                                            </span>
                                            <button
                                                type="button"
                                                className="pgi-clearfilter"
                                                onClick={() => setMsgFilter(null)}
                                            >
                                                Clear
                                            </button>
                                        </>
                                    )}
                                </div>
                                <div className="pgi-grid-wrap">
                                    <table className="pgi-grid">
                                        <thead>
                                            <tr>
                                                {resultColumns.map((c) => (
                                                    <th key={c}>{c}</th>
                                                ))}
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {filteredResults.length ? (
                                                filteredResults.slice(0, 500).map((row, i) => {
                                                    const s = statusOf(row);
                                                    return (
                                                        <tr
                                                            key={i}
                                                            className={
                                                                s === 'error'
                                                                    ? 'pgi-row-error'
                                                                    : s === 'skipped'
                                                                      ? 'pgi-row-skipped'
                                                                      : ''
                                                            }
                                                        >
                                                            {resultColumns.map((c) => (
                                                                <td
                                                                    key={c}
                                                                    className={
                                                                        c === '_status'
                                                                            ? `pgi-status pgi-status-${s || 'other'}`
                                                                            : undefined
                                                                    }
                                                                >
                                                                    {fmtCell(row[c])}
                                                                </td>
                                                            ))}
                                                        </tr>
                                                    );
                                                })
                                            ) : (
                                                <tr>
                                                    <td
                                                        colSpan={resultColumns.length || 1}
                                                        style={{ color: 'var(--text-3)' }}
                                                    >
                                                        No records match this status.
                                                    </td>
                                                </tr>
                                            )}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        ) : datasetColumns.length === 0 ? (
                            <div className="pgi-mainempty">
                                <p>
                                    Connect a dataset to this node — its data appears here to
                                    map from.
                                </p>
                            </div>
                        ) : (
                            <div className="pgi-results">
                                <div className="pgi-results-bar">
                                    Connected dataset — {datasetColumns.length} column
                                    {datasetColumns.length === 1 ? '' : 's'}
                                    {datasetRows.length
                                        ? ` · ${datasetRows.length} preview row${datasetRows.length === 1 ? '' : 's'}`
                                        : ''}
                                </div>
                                <div className="pgi-grid-wrap">
                                    <table className="pgi-grid">
                                        <thead>
                                            <tr>
                                                {datasetColumns.map((c) => (
                                                    <th key={c}>{c}</th>
                                                ))}
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {datasetRows.length ? (
                                                datasetRows.slice(0, 100).map((row, i) => (
                                                    <tr key={i}>
                                                        {datasetColumns.map((c) => (
                                                            <td key={c}>{fmtCell(row[c])}</td>
                                                        ))}
                                                    </tr>
                                                ))
                                            ) : (
                                                <tr>
                                                    <td
                                                        colSpan={datasetColumns.length}
                                                        style={{ color: 'var(--text-3)' }}
                                                    >
                                                        Run the pipeline once to preview the
                                                        upstream data here.
                                                    </td>
                                                </tr>
                                            )}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        )}
                    </>
                )}
            </div>

            {testResult &&
                createPortal(
                    <div
                        onClick={() => setTestResult(null)}
                        style={{
                            position: 'fixed',
                            inset: 0,
                            background: 'rgba(0,0,0,0.4)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            zIndex: 1000,
                        }}
                    >
                        <div
                            onClick={(e) => e.stopPropagation()}
                            style={{
                                background: 'var(--bg-1, #fff)',
                                color: 'var(--text-1)',
                                width: 'min(760px, 92vw)',
                                maxHeight: '80vh',
                                overflow: 'auto',
                                borderRadius: 10,
                                padding: 18,
                                boxShadow: '0 12px 40px rgba(0,0,0,0.3)',
                            }}
                        >
                            <div
                                style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}
                            >
                                <h3 style={{ margin: 0, flex: 1 }}>Test upload result</h3>
                                <button
                                    type="button"
                                    className="pg-btn"
                                    onClick={() => setTestResult(null)}
                                >
                                    Close
                                </button>
                            </div>
                            <div
                                style={{
                                    fontWeight: 600,
                                    marginBottom: 10,
                                    color: testResult.overallOk ? 'var(--ok, #2b8a3e)' : 'var(--danger)',
                                }}
                            >
                                {testResult.overallOk ? '✓ Success' : '✗ Issues'} · HTTP{' '}
                                {testResult.httpStatus}
                                {testResult.batchStatus !== undefined
                                    ? ` · batchStatus ${testResult.batchStatus}`
                                    : ''}
                                {testResult.records.length
                                    ? ` · ${testResult.records.filter((r) => r.ok).length}/${
                                          testResult.records.length
                                      } ok`
                                    : ''}
                            </div>
                            {testResult.records.length > 0 && (
                                <table className="pgi-grid" style={{ width: '100%' }}>
                                    <thead>
                                        <tr>
                                            <th style={{ width: 120 }}>Record</th>
                                            <th>Result</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {testResult.records.map((r, i) => (
                                            <tr key={i}>
                                                <td style={{ whiteSpace: 'nowrap', verticalAlign: 'top' }}>
                                                    {r.id || `#${i + 1}`}
                                                </td>
                                                <td
                                                    style={{
                                                        color: r.ok ? undefined : 'var(--danger)',
                                                        whiteSpace: 'pre-wrap',
                                                        wordBreak: 'break-word',
                                                    }}
                                                >
                                                    {r.message}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            )}
                            {testResult.raw && testResult.records.length === 0 && (
                                <pre
                                    style={{
                                        whiteSpace: 'pre-wrap',
                                        wordBreak: 'break-word',
                                        fontSize: 12,
                                        margin: 0,
                                    }}
                                >
                                    {testResult.raw}
                                </pre>
                            )}
                            {testResult.raw && testResult.records.length > 0 && (
                                <details style={{ marginTop: 10 }}>
                                    <summary style={{ cursor: 'pointer', fontSize: 12 }}>
                                        Raw response
                                    </summary>
                                    <pre
                                        style={{
                                            whiteSpace: 'pre-wrap',
                                            wordBreak: 'break-word',
                                            fontSize: 11,
                                            margin: '6px 0 0',
                                        }}
                                    >
                                        {testResult.raw}
                                    </pre>
                                </details>
                            )}
                        </div>
                    </div>,
                    document.body,
                )}
        </div>
    );
}
