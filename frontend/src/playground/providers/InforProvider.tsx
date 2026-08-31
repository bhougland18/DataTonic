import { useMemo, useRef, useState } from 'react';
import { Upload, Server, Boxes, Info, ShieldCheck, ShieldAlert, Loader2, LogIn, Save } from 'lucide-react';
import { parseIonApi, type IonApiConfig } from './infor/ionapi';
import type { IonApiToken } from './infor/inforAuth';
import { getSharedToken } from './infor/inforTokenStore';
import { restBase } from './infor/inforApi';
import {
    isInforConnection,
    parseInforConfig,
    toInforConnectionPayload,
} from './infor/inforConnection';
import type { PlaygroundConnection } from '../connectionBridge';
import type { credentialsToPayload } from '../connectionBridge';

interface InforProviderProps {
    // Needed so the token request routes through the backend send path.
    workspacePath: string | null;
    // Raised when a token is obtained, so the Playground can open the Infor
    // workspace (business-class discovery + query) in the main area.
    onSignedIn?: (config: IonApiConfig, token: IonApiToken) => void;
    // Saved connections (to reuse a stored Infor connection) and a way to
    // persist a new one — so sign-in survives reload and can be shared (1r).
    connections?: PlaygroundConnection[];
    onSaveConnection?: (name: string, payload: ReturnType<typeof credentialsToPayload>) => string;
}

// Infor provider auth panel (sidebar). Ingests a `.ionapi`, mints a bearer
// (per-user login primary; associated service account secondary for testing),
// and hands the session up via onSignedIn. Discovery + the query builder render
// in the main area once signed in.
export default function InforProvider({
    workspacePath,
    onSignedIn,
    connections = [],
    onSaveConnection,
}: InforProviderProps) {
    const fileRef = useRef<HTMLInputElement>(null);
    const [config, setConfig] = useState<IonApiConfig | null>(null);
    const [fromSaved, setFromSaved] = useState(false);
    const [parseError, setParseError] = useState<string | null>(null);
    const [status, setStatus] = useState<'idle' | 'minting' | 'signed-in' | 'error'>('idle');
    const [token, setToken] = useState<IonApiToken | null>(null);
    const [authError, setAuthError] = useState<string | null>(null);
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [saveName, setSaveName] = useState('');
    const [savedNote, setSavedNote] = useState<string | null>(null);

    const inforConnections = useMemo(
        () => connections.filter(isInforConnection),
        [connections],
    );

    const useSavedConnection = (id: string) => {
        if (!id) return;
        const conn = inforConnections.find((c) => c.id === id);
        const cfg = conn && parseInforConfig(conn.payload);
        if (!cfg) return;
        setParseError(null);
        setToken(null);
        setStatus('idle');
        setSavedNote(null);
        setConfig(cfg);
        setFromSaved(true);
    };

    const saveConnection = () => {
        if (!config || !onSaveConnection) return;
        const name = saveName.trim() || `Infor · ${config.tenant}${config.appName ? ` (${config.appName})` : ''}`;
        onSaveConnection(name, toInforConnectionPayload(config));
        setSavedNote(`Saved connection “${name}”.`);
        setFromSaved(true);
        setSaveName('');
    };

    const handleFile = async (file: File | null) => {
        if (!file) return;
        setParseError(null);
        setToken(null);
        setStatus('idle');
        setSavedNote(null);
        setFromSaved(false);
        const result = parseIonApi(await file.text());
        if (!result.ok) {
            setConfig(null);
            setParseError(result.error);
            return;
        }
        setConfig(result.config);
    };

    const handleSignIn = async (mode: 'user' | 'service') => {
        if (!config) return;
        setStatus('minting');
        setAuthError(null);
        // Mint through the shared store so all consumers of this Infor app
        // (this panel now, Canvas nodes later) reuse one token (1r).
        const result = await getSharedToken(
            config,
            mode === 'service' ? { kind: 'service' } : { kind: 'user', username: username.trim(), password },
            workspacePath,
            Date.now(),
        );
        if (!result.ok) {
            setStatus('error');
            setAuthError(result.error);
            return;
        }
        setToken(result.token);
        setStatus('signed-in');
        onSignedIn?.(config, result.token);
    };

    const expiresLabel = token?.expiresAt
        ? `expires ${new Date(token.expiresAt).toLocaleTimeString()}`
        : 'no expiry reported';

    return (
        <div className="pg-infor">
            <div className="pg-infor-brand">
                <span className="pg-infor-mark" aria-hidden="true" />
                Infor · FSM / Landmark
            </div>

            {inforConnections.length > 0 && status !== 'signed-in' && (
                <label className="pg-field">
                    <span className="pg-field-label">Saved connection</span>
                    <select
                        className="pg-input pg-input--select"
                        value=""
                        onChange={(e) => useSavedConnection(e.target.value)}
                    >
                        <option value="">Choose a saved Infor connection…</option>
                        {inforConnections.map((c) => (
                            <option key={c.id} value={c.id}>
                                {c.name}
                            </option>
                        ))}
                    </select>
                </label>
            )}

            <button type="button" className="pg-btn" onClick={() => fileRef.current?.click()}>
                <Upload size={14} strokeWidth={1.75} /> Import .ionapi credentials
            </button>
            <input
                ref={fileRef}
                type="file"
                accept=".ionapi,application/json,.json"
                hidden
                onChange={(e) => {
                    void handleFile(e.target.files?.[0] ?? null);
                    e.target.value = '';
                }}
            />

            {parseError && (
                <div className="pg-errors" role="alert">
                    <div className="pg-errors-head">
                        <ShieldAlert size={14} strokeWidth={2} /> Could not read the .ionapi file
                    </div>
                    <ul>
                        <li>
                            <span>{parseError}</span>
                        </li>
                    </ul>
                </div>
            )}

            {config && (
                <div className="pg-infor-cfg">
                    <div className="pg-infor-cfg-row">
                        <span>Tenant</span>
                        <code>{config.tenant || '—'}</code>
                    </div>
                    <div className="pg-infor-cfg-row">
                        <span>App</span>
                        <code>{config.appName ?? '—'}</code>
                    </div>
                    <div className="pg-infor-cfg-row">
                        <span>API base</span>
                        <code title={restBase(config)}>{restBase(config)}</code>
                    </div>
                </div>
            )}

            {config && status !== 'signed-in' && (
                <>
                    <div className="pg-infor-creds">
                        <label className="pg-field">
                            <span className="pg-field-label">Infor username</span>
                            <input
                                className="pg-input"
                                autoComplete="username"
                                placeholder="tenant user (e.g. you@roihs.com)"
                                value={username}
                                onChange={(e) => setUsername(e.target.value)}
                            />
                        </label>
                        <label className="pg-field">
                            <span className="pg-field-label">Password</span>
                            <input
                                className="pg-input"
                                type="password"
                                autoComplete="current-password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter' && username.trim() && password)
                                        void handleSignIn('user');
                                }}
                            />
                        </label>
                    </div>
                    <button
                        type="button"
                        className="pg-btn pg-btn--primary"
                        disabled={status === 'minting' || !username.trim() || !password}
                        onClick={() => void handleSignIn('user')}
                    >
                        {status === 'minting' ? (
                            <Loader2 size={14} className="pg-spin" />
                        ) : (
                            <ShieldCheck size={14} strokeWidth={1.75} />
                        )}
                        Sign in as me
                    </button>
                    {config.saak && (
                        <button
                            type="button"
                            className="pg-btn"
                            disabled={status === 'minting'}
                            onClick={() => void handleSignIn('service')}
                        >
                            Use service account (testing)
                        </button>
                    )}
                    <button type="button" className="pg-infor-step" disabled>
                        <LogIn size={15} strokeWidth={1.75} />
                        <span className="pg-infor-step-label">Webview SSO (needs an auth-code app)</span>
                        <span className="pg-soon">soon</span>
                    </button>
                </>
            )}

            {status === 'error' && authError && (
                <div className="pg-errors" role="alert">
                    <div className="pg-errors-head">
                        <ShieldAlert size={14} strokeWidth={2} /> Sign-in failed
                    </div>
                    <ul>
                        <li>
                            <span>{authError}</span>
                        </li>
                    </ul>
                </div>
            )}

            {status === 'signed-in' && token && (
                <div className="pg-infor-signed">
                    <span className="pg-infor-dot" />
                    <div>
                        <div className="pg-infor-signed-title">Signed in</div>
                        <div className="pg-infor-signed-sub">
                            {config ? `${config.tenant} · ` : ''}
                            {token.tokenType} · {expiresLabel}
                        </div>
                    </div>
                </div>
            )}

            {status === 'signed-in' && config && !fromSaved && onSaveConnection && (
                <div className="pg-save-conn">
                    <input
                        className="pg-input"
                        placeholder="Save this connection for reuse…"
                        value={saveName}
                        onChange={(e) => setSaveName(e.target.value)}
                    />
                    <button type="button" className="pg-btn" onClick={saveConnection}>
                        <Save size={14} strokeWidth={1.75} /> Save
                    </button>
                </div>
            )}
            {savedNote && <div className="pg-persist pg-persist--ok">{savedNote}</div>}

            {!config && !parseError && (
                <>
                    <div className="pg-infor-step pg-infor-step--static">
                        <Server size={15} strokeWidth={1.75} />
                        <span className="pg-infor-step-label">Environment · Data Area</span>
                        <span className="pg-soon">soon</span>
                    </div>
                    <div className="pg-infor-step pg-infor-step--static">
                        <Boxes size={15} strokeWidth={1.75} />
                        <span className="pg-infor-step-label">Business class</span>
                        <span className="pg-soon">soon</span>
                    </div>
                    <div className="pg-infor-note">
                        <Info size={14} strokeWidth={1.75} />
                        <span>
                            Import your ION API <b>.ionapi</b> credentials to connect. Business-class
                            discovery and the query builder open once you sign in.
                        </span>
                    </div>
                </>
            )}
        </div>
    );
}
