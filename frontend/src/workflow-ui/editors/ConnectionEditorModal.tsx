import { useEffect, useMemo, useRef, useState } from 'react';
import { KeyValueField } from '../fields/KeyValueField';
import { createPortal } from 'react-dom';
import { Plug, Save, X, Upload, ShieldAlert } from 'lucide-react';
import type { ConnectionKind, ConnectionPayload, RepoItem } from '../../repo-types';
import { parseIonApi, type IonApiConfig } from '../../playground/providers/infor/ionapi';
import { toInforConnectionPayload, parseInforConfig } from '../../playground/providers/infor/inforConnection';

// Infor connections are stored as kind 'rest' (with the whole .ionapi encrypted
// under extra.secret), so 'infor' is a UI-only pseudo-type in the selector, not
// a real ConnectionKind. Saving maps it to the rest payload via
// toInforConnectionPayload, which is what the Infor node's connectionRef picker
// (accepts 'rest') and the Playground both already read.
type KindOrInfor = ConnectionKind | 'infor';

type Props = {
    item: RepoItem | null;
    onSave: (name: string, payload: ConnectionPayload) => void;
    onCancel: () => void;
};

type ConnectionType = {
    kind: ConnectionKind;
    label: string;
    fields: Array<keyof ConnectionPayload>;
    defaultPort?: number;
};

const CONNECTION_TYPES: ConnectionType[] = [
    {
        kind: 'postgres',
        label: 'PostgreSQL',
        fields: [
            'host', 'port', 'database', 'username', 'password',
            // Advanced / TLS (issue #161).
            'sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'connectTimeout', 'options', 'connParams',
        ],
        defaultPort: 5432,
    },
    {
        kind: 'mysql',
        label: 'MySQL',
        fields: ['host', 'port', 'database', 'username', 'password'],
        defaultPort: 3306,
    },
    {
        kind: 'mariadb',
        label: 'MariaDB',
        fields: ['host', 'port', 'database', 'username', 'password'],
        defaultPort: 3306,
    },
    {
        kind: 'sqlserver',
        label: 'SQL Server',
        fields: ['host', 'port', 'database', 'username', 'password'],
        defaultPort: 1433,
    },
    {
        kind: 'oracle',
        label: 'Oracle',
        fields: ['host', 'port', 'database', 'username', 'password'],
        defaultPort: 1521,
    },
    { kind: 'sqlite', label: 'SQLite', fields: ['database'] },
    { kind: 'duckdb', label: 'DuckDB', fields: ['database'] },
    {
        kind: 'snowflake',
        label: 'Snowflake',
        fields: ['host', 'database', 'username', 'password'],
    },
    {
        kind: 'bigquery',
        label: 'BigQuery',
        fields: ['accountName', 'database'],
    },
    {
        kind: 'redshift',
        label: 'Redshift',
        fields: [
            'host', 'port', 'database', 'username', 'password',
            'sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'connectTimeout', 'options', 'connParams',
        ],
        defaultPort: 5439,
    },
    {
        kind: 'clickhouse',
        label: 'ClickHouse',
        fields: ['host', 'port', 'database', 'username', 'password'],
        defaultPort: 8123,
    },
    {
        kind: 'mongodb',
        label: 'MongoDB',
        fields: ['host', 'port', 'database', 'username', 'password'],
        defaultPort: 27017,
    },
    {
        kind: 'redis',
        label: 'Redis',
        fields: ['host', 'port', 'password'],
        defaultPort: 6379,
    },
    {
        kind: 'elastic',
        label: 'Elasticsearch',
        fields: ['host', 'port', 'username', 'password'],
        defaultPort: 9200,
    },
    {
        kind: 's3',
        label: 'Amazon S3 / MinIO',
        fields: ['bucket', 'region', 'accessKey', 'secretKey', 'endpoint', 'urlStyle'],
    },
    {
        kind: 'gcs',
        label: 'Google Cloud Storage',
        fields: ['bucket', 'accountName'],
    },
    {
        kind: 'azure-blob',
        label: 'Azure Blob Storage',
        fields: ['accountName', 'accountKey', 'bucket'],
    },
    { kind: 'kafka', label: 'Kafka', fields: ['brokers', 'username', 'password'] },
    {
        // Auth lives here so a rotated key is one edit, not one per node.
        kind: 'rest',
        label: 'REST API',
        fields: ['url', 'headers', 'authType', 'authToken', 'authHeader'],
    },
    {
        // #166 stage 2: field names match what the engine's Salesforce
        // connectors read, so run-time resolution injects them verbatim.
        kind: 'salesforce',
        label: 'Salesforce',
        fields: ['authMode', 'loginUrl', 'instanceUrl', 'clientId', 'clientSecret', 'accessToken'],
    },
];

const FIELD_LABELS: Partial<Record<keyof ConnectionPayload, string>> = {
    host: 'Host',
    port: 'Port',
    database: 'Database',
    username: 'Username',
    password: 'Password',
    bucket: 'Bucket',
    region: 'Region',
    accessKey: 'Access key',
    secretKey: 'Secret key',
    accountName: 'Account / Project',
    accountKey: 'Account key',
    brokers: 'Bootstrap servers',
    url: 'Base URL',
    endpoint: 'Endpoint (MinIO / R2 / B2, blank for AWS)',
    urlStyle: 'URL style',
    sslmode: 'SSL mode',
    sslrootcert: 'SSL root cert',
    sslcert: 'SSL client cert',
    sslkey: 'SSL client key',
    connectTimeout: 'Connect timeout (s)',
    options: 'Session options',
    connParams: 'Extra parameters',
    authMode: 'Auth mode',
    loginUrl: 'Login URL (Client Credentials)',
    instanceUrl: 'Instance URL (Bearer mode)',
    clientId: 'Client ID (Client Credentials)',
    clientSecret: 'Client secret (Client Credentials)',
    accessToken: 'Access token (Bearer mode)',
    headers: 'Headers (sent with every request)',
    authType: 'Auth type (bearer / basic / none)',
    authToken: 'Auth token',
    authHeader: 'Auth header name (default Authorization)',
};

const SECRET_FIELDS = new Set<keyof ConnectionPayload>([
    'password',
    'secretKey',
    'accountKey',
    'clientSecret',
    'accessToken',
    'authToken',
]);

export default function ConnectionEditorModal({ item, onSave, onCancel }: Props) {
    const initial = (item?.payload as ConnectionPayload | undefined) ?? null;
    const initialInfor = useMemo(() => parseInforConfig(initial ?? undefined), [initial]);
    const [name, setName] = useState(item?.name ?? '');
    const [kind, setKind] = useState<KindOrInfor>(
        initialInfor ? 'infor' : (initial?.kind ?? 'postgres'),
    );
    const [values, setValues] = useState<ConnectionPayload>(initial ?? { kind: 'postgres' });
    const [inforConfig, setInforConfig] = useState<IonApiConfig | null>(initialInfor);
    const [inforError, setInforError] = useState<string | null>(null);
    const nameRef = useRef<HTMLInputElement>(null);
    const fileRef = useRef<HTMLInputElement>(null);

    const meta = useMemo(() => CONNECTION_TYPES.find(c => c.kind === kind), [kind]);
    const typeLabel = kind === 'infor' ? 'Infor (ION API)' : (meta?.label ?? kind);

    const handleIonapi = async (file: File | null) => {
        if (!file) return;
        setInforError(null);
        const res = parseIonApi(await file.text());
        if (!res.ok) {
            setInforConfig(null);
            setInforError(res.error);
            return;
        }
        setInforConfig(res.config);
        if (!name.trim()) {
            setName(
                `Infor · ${res.config.tenant}${res.config.appName ? ` (${res.config.appName})` : ''}`,
            );
        }
    };

    useEffect(() => {
        setTimeout(() => nameRef.current?.focus(), 30);
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onCancel();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onCancel]);

    // `headers` is a list of pairs rather than a scalar, so the value type is
    // wider than the text/number inputs that made up this form until now.
    const setField = (
        key: keyof ConnectionPayload,
        value: string | number | { key: string; value: string }[],
    ) => {
        setValues(v => ({ ...v, [key]: value }));
    };

    const handleKindChange = (newKind: KindOrInfor) => {
        setKind(newKind);
        if (newKind === 'infor') return;
        const m = CONNECTION_TYPES.find(c => c.kind === newKind);
        setValues(v => ({
            ...v,
            kind: newKind,
            port: m?.defaultPort ?? v.port,
        }));
    };

    const canSave =
        name.trim().length > 0 && (kind !== 'infor' || inforConfig !== null);

    const handleSave = () => {
        if (!canSave) return;
        if (kind === 'infor') {
            if (!inforConfig) return;
            // Map to the encrypted rest payload; preserve any notes typed here.
            const payload = toInforConnectionPayload(inforConfig);
            onSave(name.trim(), values.notes ? { ...payload, notes: values.notes } : payload);
            return;
        }
        onSave(name.trim(), { ...values, kind });
    };

    return createPortal(
        <div
            className="modal-backdrop"
            onClick={e => {
                if (e.target === e.currentTarget) onCancel();
            }}
        >
            <div className="modal modal-editor">
                <div className="modal-header">
                    <div className="modal-title-row">
                        <Plug size={16} className="modal-title-icon" />
                        <div>
                            <div className="modal-title">
                                {item ? 'Edit connection' : 'New connection'}
                            </div>
                            <div className="modal-subtitle">
                                {typeLabel} · saved in <code>Connections</code>
                            </div>
                        </div>
                    </div>
                    <button
                        type="button"
                        className="modal-close"
                        onClick={onCancel}
                        aria-label="Close"
                    >
                        <X size={16} />
                    </button>
                </div>

                <div className="modal-body">
                    <div className="modal-field">
                        <label className="modal-field-label">Connection name</label>
                        <input
                            ref={nameRef}
                            type="text"
                            className="modal-input"
                            value={name}
                            placeholder="e.g. analytics_warehouse_prod"
                            onChange={e => setName(e.target.value)}
                            spellCheck={false}
                        />
                    </div>

                    <div className="modal-field">
                        <label className="modal-field-label">Type</label>
                        <select
                            className="modal-input modal-select"
                            value={kind}
                            onChange={e => handleKindChange(e.target.value as KindOrInfor)}
                        >
                            {CONNECTION_TYPES.map(c => (
                                <option key={c.kind} value={c.kind}>
                                    {c.label}
                                </option>
                            ))}
                            <option value="infor">Infor (ION API)</option>
                        </select>
                    </div>

                    {kind === 'infor' && (
                        <div className="modal-field">
                            <label className="modal-field-label">ION API credentials</label>
                            <button
                                type="button"
                                className="btn btn-secondary"
                                onClick={() => fileRef.current?.click()}
                            >
                                <Upload size={13} />
                                {inforConfig ? 'Replace .ionapi file' : 'Import .ionapi file'}
                            </button>
                            <input
                                ref={fileRef}
                                type="file"
                                accept=".ionapi,application/json,.json"
                                hidden
                                onChange={e => {
                                    void handleIonapi(e.target.files?.[0] ?? null);
                                    e.target.value = '';
                                }}
                            />
                            {inforConfig && (
                                <div className="modal-subtitle" style={{ marginTop: 8 }}>
                                    Tenant <code>{inforConfig.tenant}</code>
                                    {inforConfig.appName ? (
                                        <>
                                            {' · App '}
                                            <code>{inforConfig.appName}</code>
                                        </>
                                    ) : null}
                                    {' · secret encrypted at rest'}
                                </div>
                            )}
                            {inforError && (
                                <div
                                    role="alert"
                                    style={{ marginTop: 8, color: 'var(--danger, #e5484d)', display: 'flex', gap: 6, alignItems: 'center' }}
                                >
                                    <ShieldAlert size={13} />
                                    <span>{inforError}</span>
                                </div>
                            )}
                        </div>
                    )}

                    {kind !== 'infor' && (
                    <div className="connection-field-grid">
                        {meta?.fields.map(field => {
                            const isSecret = SECRET_FIELDS.has(field);
                            const isNumber = field === 'port' || field === 'connectTimeout';
                            if (field === 'sslmode') {
                                // Values MUST match libpq sslmode names so the
                                // engine forwards them verbatim into the DSN (#161).
                                return (
                                    <div className="modal-field" key={field}>
                                        <label className="modal-field-label">
                                            {FIELD_LABELS[field] ?? field}
                                        </label>
                                        <select
                                            className="modal-input"
                                            value={(values.sslmode as string | undefined) ?? ''}
                                            onChange={e => setField('sslmode', e.target.value)}
                                        >
                                            <option value="">Default</option>
                                            <option value="disable">disable</option>
                                            <option value="allow">allow</option>
                                            <option value="prefer">prefer</option>
                                            <option value="require">require</option>
                                            <option value="verify-ca">verify-ca</option>
                                            <option value="verify-full">verify-full</option>
                                        </select>
                                    </div>
                                );
                            }
                            if (field === 'headers') {
                                // Reuses the canvas key/value editor rather
                                // than a second implementation, so a header set
                                // here looks and behaves like one set on a node.
                                return (
                                    <div className="modal-field" key={field}>
                                        <label className="modal-field-label">
                                            {FIELD_LABELS[field] ?? field}
                                        </label>
                                        <KeyValueField
                                            value={values.headers}
                                            onChange={pairs => setField('headers', pairs)}
                                        />
                                    </div>
                                );
                            }
                            if (field === 'authType') {
                                return (
                                    <div className="modal-field" key={field}>
                                        <label className="modal-field-label">
                                            {FIELD_LABELS[field] ?? field}
                                        </label>
                                        <select
                                            className="modal-input"
                                            value={(values.authType as string | undefined) ?? ''}
                                            onChange={e => setField('authType', e.target.value)}
                                        >
                                            <option value="">None</option>
                                            <option value="bearer">Bearer</option>
                                            <option value="basic">Basic</option>
                                        </select>
                                    </div>
                                );
                            }
                            if (field === 'authMode') {
                                // The values MUST match what the run-time
                                // resolver maps onto the node's authMode /
                                // authType props (#166 stage 2).
                                return (
                                    <div className="modal-field" key={field}>
                                        <label className="modal-field-label">
                                            {FIELD_LABELS[field] ?? field}
                                        </label>
                                        <select
                                            className="modal-input"
                                            value={(values.authMode as string | undefined) ?? 'bearer'}
                                            onChange={e => setField('authMode', e.target.value)}
                                        >
                                            <option value="bearer">Bearer token (paste / refresh manually)</option>
                                            <option value="clientCredentials">OAuth 2.0 Client Credentials (mint per run)</option>
                                        </select>
                                    </div>
                                );
                            }
                            if (field === 'urlStyle') {
                                // The values MUST match the S3 node's URL-style
                                // option values ('' / 'path' / 'vhost') so picking
                                // this saved connection on a node lands on a real
                                // option instead of falling back to Default (#116).
                                return (
                                    <div className="modal-field" key={field}>
                                        <label className="modal-field-label">
                                            {FIELD_LABELS[field] ?? field}
                                        </label>
                                        <select
                                            className="modal-input"
                                            value={(values.urlStyle as string | undefined) ?? ''}
                                            onChange={e => setField('urlStyle', e.target.value)}
                                        >
                                            <option value="">Default</option>
                                            <option value="path">Path (MinIO / B2)</option>
                                            <option value="vhost">Virtual host (R2 / AWS)</option>
                                        </select>
                                    </div>
                                );
                            }
                            return (
                                <div className="modal-field" key={field}>
                                    <label className="modal-field-label">
                                        {FIELD_LABELS[field] ?? field}
                                    </label>
                                    <input
                                        type={isSecret ? 'password' : isNumber ? 'number' : 'text'}
                                        className="modal-input"
                                        value={(values[field] as string | number | undefined) ?? ''}
                                        placeholder={isSecret ? '••••••••' : ''}
                                        onChange={e =>
                                            setField(
                                                field,
                                                isNumber ? Number(e.target.value) : e.target.value,
                                            )
                                        }
                                        spellCheck={false}
                                    />
                                </div>
                            );
                        })}
                    </div>
                    )}

                    <div className="modal-field">
                        <label className="modal-field-label">Notes (optional)</label>
                        <textarea
                            className="modal-input"
                            rows={2}
                            value={values.notes ?? ''}
                            onChange={e => setValues(v => ({ ...v, notes: e.target.value }))}
                            spellCheck={false}
                        />
                    </div>
                </div>

                <div className="modal-footer">
                    <button type="button" className="btn btn-secondary" onClick={onCancel}>
                        Cancel
                    </button>
                    <button
                        type="button"
                        className="btn btn-primary"
                        onClick={handleSave}
                        disabled={!canSave}
                    >
                        <Save size={13} />
                        Save
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
}
