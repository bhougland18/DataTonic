import { useRef, useState } from 'react';
import { Upload, Server, Boxes, Info, ShieldCheck, ShieldAlert, Loader2, LogIn } from 'lucide-react';
import { parseIonApi, type IonApiConfig } from './infor/ionapi';
import {
    mintPasswordToken,
    mintServiceAccountToken,
    type IonApiToken,
} from './infor/inforAuth';
import { probeDataAccess, restBase, type ProbeResult } from './infor/inforApi';

interface InforProviderProps {
    // Needed so the token request routes through the backend send path.
    workspacePath: string | null;
}

// Infor provider panel. Phase B (this slice): ingest a `.ionapi` file and mint a
// bearer via the service-account grant — no webview yet. The interactive
// authorization-code login (webview) is layered on next, and persisting the
// result as a saved Connection follows once the live mint is confirmed. Layout
// follows the approved mockup so this fills in place.
export default function InforProvider({ workspacePath }: InforProviderProps) {
    const fileRef = useRef<HTMLInputElement>(null);
    const [config, setConfig] = useState<IonApiConfig | null>(null);
    const [parseError, setParseError] = useState<string | null>(null);
    const [status, setStatus] = useState<'idle' | 'minting' | 'signed-in' | 'error'>('idle');
    const [token, setToken] = useState<IonApiToken | null>(null);
    const [authError, setAuthError] = useState<string | null>(null);
    // ROPC user credentials (used when the .ionapi has no service-account keys).
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    // Data-access probe (verifies the token has an FSM data context).
    const [probe, setProbe] = useState<ProbeResult | null>(null);
    const [probing, setProbing] = useState(false);

    const handleProbe = async () => {
        if (!config || !token) return;
        setProbing(true);
        setProbe(null);
        setProbe(await probeDataAccess(config, token.accessToken, workspacePath));
        setProbing(false);
    };

    const handleFile = async (file: File | null) => {
        if (!file) return;
        setParseError(null);
        setToken(null);
        setStatus('idle');
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
        const result =
            mode === 'service'
                ? await mintServiceAccountToken(config, workspacePath, Date.now())
                : await mintPasswordToken(config, username.trim(), password, workspacePath, Date.now());
        if (!result.ok) {
            setStatus('error');
            setAuthError(result.error);
            return;
        }
        setToken(result.token);
        setStatus('signed-in');
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
                        <span>Token URL</span>
                        <code title={config.tokenUrl}>{config.tokenUrl}</code>
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
                <>
                    <div className="pg-infor-signed">
                        <span className="pg-infor-dot" />
                        <div>
                            <div className="pg-infor-signed-title">Signed in</div>
                            <div className="pg-infor-signed-sub">
                                {token.tokenType} · {expiresLabel}
                                {token.refreshToken ? ' · refresh available' : ''}
                            </div>
                        </div>
                    </div>

                    <button
                        type="button"
                        className="pg-btn"
                        disabled={probing}
                        onClick={() => void handleProbe()}
                    >
                        {probing ? <Loader2 size={14} className="pg-spin" /> : <Boxes size={14} strokeWidth={1.75} />}
                        Verify FSM data access
                    </button>

                    {probe && probe.ok && (
                        <div className="pg-persist pg-persist--ok">
                            <ShieldCheck size={13} strokeWidth={2} /> Data context OK — HTTP {probe.status}
                            {probe.rowCount !== undefined ? `, ${probe.rowCount} row(s)` : ''}.
                        </div>
                    )}
                    {probe && !probe.ok && (
                        <div className="pg-errors" role="alert">
                            <div className="pg-errors-head">
                                <ShieldAlert size={14} strokeWidth={2} /> No data context (HTTP {probe.status})
                            </div>
                            <ul>
                                <li>
                                    <span>{probe.message}</span>
                                </li>
                            </ul>
                        </div>
                    )}
                </>
            )}

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
                            discovery and the query builder unlock once signed in.
                        </span>
                    </div>
                </>
            )}
        </div>
    );
}
