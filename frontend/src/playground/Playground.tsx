import './playground.css';
import { useEffect, useMemo, useState } from 'react';
import { Plug, FileCheck2, FileWarning, HardDriveDownload, Info } from 'lucide-react';
import ImportBar from './ImportBar';
import EndpointTree from './EndpointTree';
import RequestPanel from './RequestPanel';
import ProviderSelector from './providers/ProviderSelector';
import InforWorkspace from './providers/infor/InforWorkspace';
import InforUploadWorkspace from './providers/infor/InforUploadWorkspace';
import type { UploadApplyConfig } from './providers/infor/InforUploadWorkspace';
import type { ProviderId } from './providers/types';
import { usePlayground } from './usePlayground';
import type { PlaygroundConnection } from './connectionBridge';
import type { credentialsToPayload } from './connectionBridge';
import type { InforNodeQuery } from './providers/infor/query';

interface PlaygroundProps {
    // The active workspace, used to persist imported specs (PL-6). Null in
    // plain browser dev with no backend - persistence reports "unavailable".
    workspacePath: string | null;
    // Saved connections from the app's repo, for reusing REST credentials (PL-9).
    connections?: PlaygroundConnection[];
    // Persist inline credentials via the existing Connection mechanism (PL-9).
    onSaveConnection?: (name: string, payload: ReturnType<typeof credentialsToPayload>) => string;
    // Raised when a Canvas node's "Open in Playground" is clicked: switch to the
    // requested provider and pre-load the node's query. The nonce makes repeat
    // opens of the same node re-fire.
    openRequest?: {
        nonce: number;
        provider: ProviderId;
        nodeId: string;
        // 'upload' opens the Infor write uploader instead of the query builder.
        kind?: 'query' | 'upload';
        query?: InforNodeQuery;
        businessClass?: string;
        dataArea?: 'FSM' | 'HCM';
        action?: string;
        datasetColumns?: string[];
        datasetRows?: Record<string, unknown>[];
        mapping?: Record<string, string>;
        confirmWarnings?: boolean;
        trimAlpha?: boolean;
    } | null;
    // Write a built query back to the originating Canvas node.
    onApplyToNode?: (nodeId: string, query: InforNodeQuery) => void;
    // Write the uploader's field mapping + options back to the sink node.
    onApplyUpload?: (nodeId: string, cfg: UploadApplyConfig) => void;
}

const VERSION_LABEL: Record<string, string> = {
    'swagger-2.0': 'Swagger 2.0',
    'openapi-3.0': 'OpenAPI 3.0',
    'openapi-3.1': 'OpenAPI 3.1',
    'openapi-3.2': 'OpenAPI 3.2',
    unknown: 'Unknown version',
};

// API Playground module root (rail mode "playground"). This increment (task 1b)
// covers import, parse, a navigable endpoint tree, and persistence. Request
// construction / send / transfer land in tasks 1c-1e; the detail pane marks
// that seam explicitly rather than pretending to be finished.
export default function Playground({
    workspacePath,
    connections = [],
    onSaveConnection,
    openRequest,
    onApplyToNode,
    onApplyUpload,
}: PlaygroundProps) {
    const pg = usePlayground(workspacePath);
    const { spec, selectedId, source, persist } = pg;
    const [provider, setProvider] = useState<ProviderId>('generic');

    // Honour an "Open in Playground" request from a Canvas node: jump to that
    // provider. Keyed on the nonce so opening the same node twice re-fires.
    useEffect(() => {
        if (openRequest) setProvider(openRequest.provider);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [openRequest?.nonce]);

    const selected = useMemo(
        () => spec?.endpoints.find((e) => e.id === selectedId) ?? null,
        [spec, selectedId],
    );

    return (
        <section className="pg" aria-label="API Playground">
            {provider === 'infor' ? (
                openRequest?.kind === 'upload' ? (
                    <InforUploadWorkspace
                        workspacePath={workspacePath}
                        connections={connections}
                        onSaveConnection={onSaveConnection}
                        onApply={onApplyUpload}
                        openRequest={{
                            nonce: openRequest.nonce,
                            nodeId: openRequest.nodeId,
                            businessClass: openRequest.businessClass,
                            dataArea: openRequest.dataArea,
                            action: openRequest.action,
                            datasetColumns: openRequest.datasetColumns,
                            datasetRows: openRequest.datasetRows,
                            mapping: openRequest.mapping,
                            confirmWarnings: openRequest.confirmWarnings,
                            trimAlpha: openRequest.trimAlpha,
                        }}
                    />
                ) : (
                    <InforWorkspace
                        workspacePath={workspacePath}
                        connections={connections}
                        onSaveConnection={onSaveConnection}
                        openRequest={openRequest}
                        onApplyToNode={onApplyToNode}
                    />
                )
            ) : (
              <>
                <aside className="pg-sidebar">
                <header className="pg-sidebar-head">
                    <Plug size={16} strokeWidth={1.75} />
                    <h2>API Playground</h2>
                </header>

                <ProviderSelector value={provider} onChange={setProvider} />

                <ImportBar
                    busy={pg.status === 'parsing'}
                    errors={pg.errors}
                    onImport={(input) => void pg.importSpec(input)}
                    onError={pg.reportError}
                />

                {spec && (
                    <>
                        <div className="pg-specinfo">
                            <div className="pg-specinfo-title">{spec.title}</div>
                            <div className="pg-specinfo-meta">
                                <span className="pg-badge">{VERSION_LABEL[spec.version]}</span>
                                {spec.apiVersion && (
                                    <span className="pg-badge pg-badge--soft">v{spec.apiVersion}</span>
                                )}
                                <span className="pg-specinfo-count">
                                    {spec.endpoints.length} operation{spec.endpoints.length === 1 ? '' : 's'}
                                </span>
                            </div>
                            {source && (
                                <div className="pg-specinfo-source" title={source.ref}>
                                    from {source.kind}: <code>{source.ref}</code>
                                </div>
                            )}
                            <PersistLine persist={persist} />
                            {spec.warnings.length > 0 && (
                                <details className="pg-warnings">
                                    <summary>
                                        <FileWarning size={13} strokeWidth={2} /> {spec.warnings.length} warning
                                        {spec.warnings.length === 1 ? '' : 's'}
                                    </summary>
                                    <ul>
                                        {spec.warnings.map((w, i) => (
                                            <li key={i}>
                                                {w.location && <code>{w.location}</code>}
                                                <span>{w.message}</span>
                                            </li>
                                        ))}
                                    </ul>
                                </details>
                            )}
                        </div>

                        <div className="pg-tree-scroll">
                            <EndpointTree
                                endpoints={spec.endpoints}
                                selectedId={selectedId}
                                onSelect={pg.setSelectedId}
                            />
                        </div>
                    </>
                )}
                </aside>

                <div className="pg-detail">
                {!spec && (
                    <div className="pg-empty">
                        <Plug size={40} strokeWidth={1.25} />
                        <h3>Import an API spec to begin</h3>
                        <p>
                            Upload or link an OpenAPI 3.x or Swagger 2.0 document (JSON or YAML). Its
                            endpoints appear on the left, grouped by tag.
                        </p>
                    </div>
                )}

                {spec && selected && (
                    <div className="pg-op">
                        <div className="pg-op-head">
                            <span className={`pg-method pg-method--${selected.method}`}>
                                {selected.method.toUpperCase()}
                            </span>
                            <code className="pg-op-path">{selected.path}</code>
                            {selected.deprecated && (
                                <span className="pg-badge pg-badge--warn">deprecated</span>
                            )}
                        </div>
                        {selected.summary && <p className="pg-op-summary">{selected.summary}</p>}
                        {selected.description && <p className="pg-op-desc">{selected.description}</p>}
                        <dl className="pg-op-meta">
                            {selected.operationId && (
                                <>
                                    <dt>operationId</dt>
                                    <dd>
                                        <code>{selected.operationId}</code>
                                    </dd>
                                </>
                            )}
                            {selected.tags.length > 0 && (
                                <>
                                    <dt>tags</dt>
                                    <dd>{selected.tags.join(', ')}</dd>
                                </>
                            )}
                        </dl>
                        <RequestPanel
                            key={selected.id}
                            document={spec.document}
                            operation={selected}
                            connections={connections}
                            onSaveConnection={onSaveConnection}
                            workspacePath={workspacePath}
                            specTitle={spec.title}
                            specVersion={spec.version}
                            sourceRef={source?.ref}
                        />
                    </div>
                )}
                </div>
              </>
            )}
        </section>
    );
}

function PersistLine({ persist }: { persist: ReturnType<typeof usePlayground>['persist'] }) {
    switch (persist.status) {
        case 'saved':
            return (
                <div className="pg-persist pg-persist--ok">
                    <FileCheck2 size={13} strokeWidth={2} /> Saved to workspace: <code>{persist.path}</code>
                </div>
            );
        case 'saving':
            return (
                <div className="pg-persist">
                    <HardDriveDownload size={13} strokeWidth={2} /> Saving to workspace...
                </div>
            );
        case 'unavailable':
            return (
                <div className="pg-persist pg-persist--muted">
                    <Info size={13} strokeWidth={2} /> Not persisted - no workspace backend in this session.
                </div>
            );
        case 'failed':
            return (
                <div className="pg-persist pg-persist--err">
                    <FileWarning size={13} strokeWidth={2} /> Could not save to workspace: {persist.detail}
                </div>
            );
        default:
            return null;
    }
}
