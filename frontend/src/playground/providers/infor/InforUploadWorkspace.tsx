import { useEffect, useMemo, useState } from 'react';
import { Plug, Search, ChevronDown, Loader2 } from 'lucide-react';
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
import { DATA_AREAS, type DataAreaId } from './inforApi';

export interface UploadOpenRequest {
    nonce: number;
    nodeId: string;
    businessClass?: string;
    dataArea?: DataAreaId;
    action?: string;
    /** Columns of the dataset feeding this sink node (its main-input upstream). */
    datasetColumns?: string[];
}

interface InforUploadWorkspaceProps {
    workspacePath: string | null;
    connections?: PlaygroundConnection[];
    onSaveConnection?: (name: string, payload: ReturnType<typeof credentialsToPayload>) => string;
    openRequest?: UploadOpenRequest | null;
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
                                ) : (
                                    <select
                                        className="pg-input pg-input--select"
                                        value={action}
                                        onChange={(e) => setAction(e.target.value)}
                                    >
                                        <option value="">— choose an action —</option>
                                        {actions.map((a) => (
                                            <option key={a.name} value={a.name}>
                                                {a.name}
                                            </option>
                                        ))}
                                    </select>
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

                        {/* ---- Fields of the selected action ---- */}
                        {selectedAction && (
                            <div className="pgi-section">
                                <div className="pgi-lbl">
                                    Fields
                                    <span
                                        style={{
                                            color: 'var(--accent, #e8590c)',
                                            fontWeight: 600,
                                            marginLeft: 8,
                                            fontSize: 11,
                                        }}
                                    >
                                        ● required key
                                    </span>
                                </div>
                                <div className="pgi-classlist" style={{ maxHeight: 360 }}>
                                    {selectedAction.fields.map((f) => (
                                        <div
                                            key={f.name}
                                            className="pgi-class"
                                            style={{
                                                cursor: 'default',
                                                color: f.required ? 'var(--accent, #e8590c)' : undefined,
                                                fontWeight: f.required ? 600 : 400,
                                            }}
                                        >
                                            <span className="pgi-class-nm">{f.name}</span>
                                        </div>
                                    ))}
                                    {!selectedAction.fields.length && (
                                        <div className="pg-note">This action takes no fields.</div>
                                    )}
                                </div>
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
                ) : datasetColumns.length === 0 ? (
                    <div className="pgi-mainempty">
                        <p>
                            Connect a dataset to this node — its columns appear here to map to the action
                            fields.
                        </p>
                    </div>
                ) : (
                    <div className="pgi-results">
                        <div className="pgi-results-bar">
                            Connected dataset — {datasetColumns.length} column
                            {datasetColumns.length === 1 ? '' : 's'}
                        </div>
                        <div className="pgi-grid-wrap">
                            <table className="pgi-grid">
                                <thead>
                                    <tr>
                                        <th>Column</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {datasetColumns.map((c) => (
                                        <tr key={c}>
                                            <td>{c}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                        <div className="pg-note" style={{ padding: '8px 12px' }}>
                            P2: map each field on the left to a column here (Auto-map by name).
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
