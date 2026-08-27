import { useMemo, useState } from 'react';
import { Info, Plus, Trash2, Save, ShieldCheck, ShieldAlert } from 'lucide-react';
import type { EndpointOperation } from './types';
import { buildRequestModel, sortParams, starterBody, type RequestParam } from './requestModel';
import {
    detectAuth,
    seedCredentials,
    type AuthCredentials,
    type NodeAuthType,
} from './authModel';
import {
    credentialsToPayload,
    isRestLikeConnection,
    payloadToCredentials,
    type PlaygroundConnection,
} from './connectionBridge';

interface RequestPanelProps {
    document: unknown;
    operation: EndpointOperation;
    connections: PlaygroundConnection[];
    // Persist inline credentials through the existing Connection mechanism
    // (PL-9). Returns the new connection's id.
    onSaveConnection?: (name: string, payload: ReturnType<typeof credentialsToPayload>) => string;
}

const AUTH_TYPE_LABEL: Record<NodeAuthType, string> = {
    none: 'No auth',
    bearer: 'Bearer token',
    apikey: 'API key',
    basic: 'Basic',
    oauth_client_credentials: 'OAuth2 client credentials',
};

// Request builder for one operation (PL-7, PL-8, PL-10). Mounted with a
// `key={operation.id}` by the parent, so switching endpoints remounts this with
// a fresh, spec-seeded form rather than leaking the previous operation's values.
export default function RequestPanel({
    document,
    operation,
    connections,
    onSaveConnection,
}: RequestPanelProps) {
    const model = useMemo(
        () => buildRequestModel(document, operation),
        [document, operation],
    );
    const auth = useMemo(
        () => detectAuth(document, operation.path, operation.method),
        [document, operation],
    );

    const params = useMemo(() => (model ? sortParams(model.params) : []), [model]);
    const restConnections = useMemo(
        () => connections.filter(isRestLikeConnection),
        [connections],
    );

    // --- form state (seeded once at mount) ---
    const [paramValues, setParamValues] = useState<Record<string, string>>(() => {
        const init: Record<string, string> = {};
        for (const p of params) {
            const d = p.hints.default ?? p.hints.example;
            if (d !== undefined && typeof d !== 'object') init[`${p.location}:${p.name}`] = String(d);
        }
        return init;
    });
    const [contentType, setContentType] = useState(() => model?.body?.mediaTypes[0] ?? '');
    const [bodyText, setBodyText] = useState(() => starterBody(model?.body));

    const [creds, setCreds] = useState<AuthCredentials>(() => seedCredentials(auth.schemes[0]));
    const [basicUser, setBasicUser] = useState('');
    const [basicPass, setBasicPass] = useState('');
    const [extraHeaders, setExtraHeaders] = useState<{ key: string; value: string }[]>([]);
    const [connectionId, setConnectionId] = useState<string | null>(null);
    const [saveName, setSaveName] = useState('');
    const [savedNote, setSavedNote] = useState<string | null>(null);

    const updateCreds = (patch: Partial<AuthCredentials>) => setCreds((c) => ({ ...c, ...patch }));

    const selectConnection = (id: string) => {
        if (!id) {
            setConnectionId(null);
            return;
        }
        const conn = restConnections.find((c) => c.id === id);
        if (!conn) return;
        setConnectionId(id);
        setCreds(payloadToCredentials(conn.payload));
        setSavedNote(null);
    };

    const handleSave = () => {
        if (!onSaveConnection) return;
        const name = saveName.trim() || `${operation.method} ${operation.path}`;
        // For basic, compose user:password into the token the node expects.
        const composed: AuthCredentials =
            creds.authType === 'basic'
                ? { ...creds, authToken: `${basicUser}:${basicPass}` }
                : creds;
        const id = onSaveConnection(name, credentialsToPayload(composed, undefined, extraHeaders));
        setConnectionId(id);
        setSavedNote(`Saved as connection "${name}".`);
        setSaveName('');
    };

    if (!model) {
        return <div className="pg-note">This operation could not be read from the spec.</div>;
    }

    const usingConnection = connectionId !== null;

    return (
        <div className="pg-req">
            {/* ---- Parameters (PL-7) ---- */}
            <section className="pg-req-section">
                <h4>Parameters</h4>
                {params.length === 0 ? (
                    <div className="pg-note">No path, query, or header parameters.</div>
                ) : (
                    <div className="pg-fields">
                        {params.map((p) => (
                            <ParamField
                                key={`${p.location}:${p.name}`}
                                param={p}
                                value={paramValues[`${p.location}:${p.name}`] ?? ''}
                                onChange={(v) =>
                                    setParamValues((prev) => ({ ...prev, [`${p.location}:${p.name}`]: v }))
                                }
                            />
                        ))}
                    </div>
                )}
            </section>

            {/* ---- Request body (PL-7) ---- */}
            {model.body && (
                <section className="pg-req-section">
                    <h4>
                        Request body{model.body.required && <span className="pg-req-star"> *</span>}
                    </h4>
                    {model.body.mediaTypes.length > 1 && (
                        <select
                            className="pg-input pg-input--select"
                            value={contentType}
                            onChange={(e) => setContentType(e.target.value)}
                        >
                            {model.body.mediaTypes.map((m) => (
                                <option key={m} value={m}>
                                    {m}
                                </option>
                            ))}
                        </select>
                    )}
                    <textarea
                        className="pg-body"
                        spellCheck={false}
                        rows={Math.min(14, Math.max(4, bodyText.split('\n').length + 1))}
                        value={bodyText}
                        onChange={(e) => setBodyText(e.target.value)}
                        placeholder="Request body"
                    />
                </section>
            )}

            {/* ---- Auth (PL-8, PL-9) ---- */}
            <section className="pg-req-section">
                <h4>Authentication</h4>
                <AuthSummary auth={auth} />

                {!auth.none && (
                    <>
                        {restConnections.length > 0 && (
                            <label className="pg-field">
                                <span className="pg-field-label">Saved connection</span>
                                <select
                                    className="pg-input pg-input--select"
                                    value={connectionId ?? ''}
                                    onChange={(e) => selectConnection(e.target.value)}
                                >
                                    <option value="">Inline credentials</option>
                                    {restConnections.map((c) => (
                                        <option key={c.id} value={c.id}>
                                            {c.name}
                                        </option>
                                    ))}
                                </select>
                            </label>
                        )}

                        {usingConnection ? (
                            <div className="pg-note pg-note--conn">
                                <ShieldCheck size={13} strokeWidth={2} />
                                Credentials come from the saved connection and are resolved (and
                                decrypted) at run time. Choose “Inline credentials” to override.
                            </div>
                        ) : (
                            <InlineCredentials
                                creds={creds}
                                basicUser={basicUser}
                                basicPass={basicPass}
                                onCreds={updateCreds}
                                onBasicUser={setBasicUser}
                                onBasicPass={setBasicPass}
                            />
                        )}

                        {!usingConnection && onSaveConnection && creds.authType !== 'none' && (
                            <div className="pg-save-conn">
                                <input
                                    className="pg-input"
                                    placeholder="Save these credentials as a connection…"
                                    value={saveName}
                                    onChange={(e) => setSaveName(e.target.value)}
                                />
                                <button type="button" className="pg-btn" onClick={handleSave}>
                                    <Save size={14} strokeWidth={1.75} /> Save
                                </button>
                            </div>
                        )}
                        {savedNote && <div className="pg-persist pg-persist--ok">{savedNote}</div>}
                    </>
                )}
            </section>

            {/* ---- Extra headers (PL-10) ---- */}
            <section className="pg-req-section">
                <h4>Additional headers</h4>
                <p className="pg-hint">
                    Supplement anything the spec doesn’t declare (PL-10).
                </p>
                <KeyValueEditor rows={extraHeaders} onChange={setExtraHeaders} />
            </section>

            <div className="pg-seam">
                <Info size={14} strokeWidth={1.75} />
                “Send” and live response arrive in the next increment (1d). This increment builds
                the request and captures auth.
            </div>
        </div>
    );
}

function AuthSummary({ auth }: { auth: ReturnType<typeof detectAuth> }) {
    if (auth.none) {
        return <div className="pg-note">This operation declares no authentication.</div>;
    }
    return (
        <div className="pg-auth-detected">
            {auth.optional && <div className="pg-hint">Auth is optional for this operation.</div>}
            {auth.schemes.map((s) => (
                <div key={s.schemeName} className="pg-scheme">
                    {s.kind === 'unsupported' ? (
                        <ShieldAlert size={13} strokeWidth={2} className="pg-scheme-warn" />
                    ) : (
                        <ShieldCheck size={13} strokeWidth={2} />
                    )}
                    <code>{s.schemeName}</code>
                    <span className="pg-scheme-kind">
                        {s.kind === 'unsupported'
                            ? `unsupported (${s.unsupportedReason})`
                            : s.kind === 'apikey'
                              ? `api key in ${s.in}${s.paramName ? ` (${s.paramName})` : ''}`
                              : s.kind === 'oauth2-cc'
                                ? 'OAuth2 client credentials'
                                : s.kind}
                    </span>
                </div>
            ))}
        </div>
    );
}

function InlineCredentials({
    creds,
    basicUser,
    basicPass,
    onCreds,
    onBasicUser,
    onBasicPass,
}: {
    creds: AuthCredentials;
    basicUser: string;
    basicPass: string;
    onCreds: (patch: Partial<AuthCredentials>) => void;
    onBasicUser: (v: string) => void;
    onBasicPass: (v: string) => void;
}) {
    return (
        <div className="pg-fields">
            <label className="pg-field">
                <span className="pg-field-label">Auth type</span>
                <select
                    className="pg-input pg-input--select"
                    value={creds.authType}
                    onChange={(e) => onCreds({ authType: e.target.value as NodeAuthType })}
                >
                    {(Object.keys(AUTH_TYPE_LABEL) as NodeAuthType[]).map((t) => (
                        <option key={t} value={t}>
                            {AUTH_TYPE_LABEL[t]}
                        </option>
                    ))}
                </select>
            </label>

            {creds.authType === 'bearer' && (
                <label className="pg-field">
                    <span className="pg-field-label">Token</span>
                    <input
                        className="pg-input"
                        type="password"
                        value={creds.authToken ?? ''}
                        onChange={(e) => onCreds({ authToken: e.target.value })}
                    />
                </label>
            )}

            {creds.authType === 'basic' && (
                <>
                    <label className="pg-field">
                        <span className="pg-field-label">Username</span>
                        <input className="pg-input" value={basicUser} onChange={(e) => onBasicUser(e.target.value)} />
                    </label>
                    <label className="pg-field">
                        <span className="pg-field-label">Password</span>
                        <input
                            className="pg-input"
                            type="password"
                            value={basicPass}
                            onChange={(e) => onBasicPass(e.target.value)}
                        />
                    </label>
                </>
            )}

            {creds.authType === 'apikey' && (
                <>
                    <label className="pg-field">
                        <span className="pg-field-label">Location</span>
                        <select
                            className="pg-input pg-input--select"
                            value={creds.apiKeyIn ?? 'header'}
                            onChange={(e) => onCreds({ apiKeyIn: e.target.value as 'header' | 'query' })}
                        >
                            <option value="header">Header</option>
                            <option value="query">Query</option>
                        </select>
                    </label>
                    <label className="pg-field">
                        <span className="pg-field-label">
                            {creds.apiKeyIn === 'query' ? 'Query param name' : 'Header name'}
                        </span>
                        <input
                            className="pg-input"
                            value={(creds.apiKeyIn === 'query' ? creds.apiKeyName : creds.authHeader) ?? ''}
                            onChange={(e) =>
                                creds.apiKeyIn === 'query'
                                    ? onCreds({ apiKeyName: e.target.value })
                                    : onCreds({ authHeader: e.target.value })
                            }
                        />
                    </label>
                    <label className="pg-field">
                        <span className="pg-field-label">Key</span>
                        <input
                            className="pg-input"
                            type="password"
                            value={creds.authToken ?? ''}
                            onChange={(e) => onCreds({ authToken: e.target.value })}
                        />
                    </label>
                </>
            )}

            {creds.authType === 'oauth_client_credentials' && (
                <>
                    <label className="pg-field">
                        <span className="pg-field-label">Token URL</span>
                        <input
                            className="pg-input"
                            value={creds.tokenUrl ?? ''}
                            onChange={(e) => onCreds({ tokenUrl: e.target.value })}
                        />
                    </label>
                    <label className="pg-field">
                        <span className="pg-field-label">Client ID</span>
                        <input
                            className="pg-input"
                            value={creds.clientId ?? ''}
                            onChange={(e) => onCreds({ clientId: e.target.value })}
                        />
                    </label>
                    <label className="pg-field">
                        <span className="pg-field-label">Client secret</span>
                        <input
                            className="pg-input"
                            type="password"
                            value={creds.clientSecret ?? ''}
                            onChange={(e) => onCreds({ clientSecret: e.target.value })}
                        />
                    </label>
                    <label className="pg-field">
                        <span className="pg-field-label">Client auth</span>
                        <select
                            className="pg-input pg-input--select"
                            value={creds.clientAuth ?? 'body'}
                            onChange={(e) => onCreds({ clientAuth: e.target.value as 'body' | 'basic' })}
                        >
                            <option value="body">Credentials in body</option>
                            <option value="basic">HTTP Basic header</option>
                        </select>
                    </label>
                    <label className="pg-field">
                        <span className="pg-field-label">Scope</span>
                        <input
                            className="pg-input"
                            value={creds.scope ?? ''}
                            onChange={(e) => onCreds({ scope: e.target.value })}
                        />
                    </label>
                </>
            )}
        </div>
    );
}

function ParamField({
    param,
    value,
    onChange,
}: {
    param: RequestParam;
    value: string;
    onChange: (v: string) => void;
}) {
    const label = (
        <span className="pg-field-label">
            <code>{param.name}</code>
            <span className="pg-param-loc">{param.location}</span>
            {param.required && <span className="pg-req-star">*</span>}
        </span>
    );
    const enumVals = param.hints.enum;
    return (
        <label className="pg-field" title={param.description}>
            {label}
            {enumVals && enumVals.length ? (
                <select className="pg-input pg-input--select" value={value} onChange={(e) => onChange(e.target.value)}>
                    <option value="">—</option>
                    {enumVals.map((v) => (
                        <option key={String(v)} value={String(v)}>
                            {String(v)}
                        </option>
                    ))}
                </select>
            ) : (
                <input
                    className="pg-input"
                    value={value}
                    placeholder={param.hints.type ?? 'string'}
                    onChange={(e) => onChange(e.target.value)}
                />
            )}
        </label>
    );
}

function KeyValueEditor({
    rows,
    onChange,
}: {
    rows: { key: string; value: string }[];
    onChange: (rows: { key: string; value: string }[]) => void;
}) {
    const set = (i: number, patch: Partial<{ key: string; value: string }>) =>
        onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
    return (
        <div className="pg-kv">
            {rows.map((r, i) => (
                <div className="pg-kv-row" key={i}>
                    <input
                        className="pg-input"
                        placeholder="Header"
                        value={r.key}
                        onChange={(e) => set(i, { key: e.target.value })}
                    />
                    <input
                        className="pg-input"
                        placeholder="Value"
                        value={r.value}
                        onChange={(e) => set(i, { value: e.target.value })}
                    />
                    <button
                        type="button"
                        className="pg-icon-btn"
                        aria-label="Remove header"
                        onClick={() => onChange(rows.filter((_, idx) => idx !== i))}
                    >
                        <Trash2 size={14} strokeWidth={1.75} />
                    </button>
                </div>
            ))}
            <button
                type="button"
                className="pg-btn pg-btn--ghost"
                onClick={() => onChange([...rows, { key: '', value: '' }])}
            >
                <Plus size={14} strokeWidth={1.75} /> Add header
            </button>
        </div>
    );
}
