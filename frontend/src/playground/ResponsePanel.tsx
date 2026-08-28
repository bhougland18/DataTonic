import { useMemo, useState } from 'react';
import { CheckCircle2, XCircle, AlertTriangle, Clock } from 'lucide-react';
import type { SendOutcome } from './sendClient';

// Response viewer (PL-12, PL-13). Renders status, timing, headers, and a
// pretty-printed body, and distinguishes the three outcomes a send can have:
// a transport failure, a received non-2xx response, and a 2xx with no body.
export default function ResponsePanel({ outcome }: { outcome: SendOutcome }) {
    if (outcome.kind === 'unavailable') {
        return (
            <div className="pg-resp pg-resp--muted">
                <AlertTriangle size={14} strokeWidth={2} />
                Sending needs the desktop app or web backend — unavailable in this session.
            </div>
        );
    }
    if (outcome.kind === 'network-error') {
        return (
            <div className="pg-resp pg-resp--err">
                <div className="pg-resp-status">
                    <XCircle size={15} strokeWidth={2} />
                    <strong>Request failed</strong>
                    <span className="pg-resp-sub">no response — network / connection error</span>
                </div>
                <pre className="pg-resp-body">{outcome.message}</pre>
            </div>
        );
    }

    return <ResponseView response={outcome.response} />;
}

function ResponseView({ response }: { response: Extract<SendOutcome, { kind: 'response' }>['response'] }) {
    const [showHeaders, setShowHeaders] = useState(false);
    const ok = response.status >= 200 && response.status < 300;
    const cls = response.status >= 500 ? 'err' : response.status >= 400 ? 'warn' : ok ? 'ok' : 'muted';
    const emptyBody = response.body.trim() === '';

    const prettyBody = useMemo(() => {
        if (emptyBody) return '';
        try {
            return JSON.stringify(JSON.parse(response.body), null, 2);
        } catch {
            return response.body;
        }
    }, [response.body, emptyBody]);

    return (
        <div className={`pg-resp pg-resp--${cls}`}>
            <div className="pg-resp-status">
                {ok ? <CheckCircle2 size={15} strokeWidth={2} /> : <AlertTriangle size={15} strokeWidth={2} />}
                <strong>
                    {response.status}
                    {response.statusText ? ` ${response.statusText}` : ''}
                </strong>
                {!ok && <span className="pg-resp-sub">non-2xx response</span>}
                <span className="pg-resp-time">
                    <Clock size={12} strokeWidth={2} /> {response.elapsedMs} ms
                </span>
            </div>

            {response.headers.length > 0 && (
                <button
                    type="button"
                    className="pg-resp-headtoggle"
                    onClick={() => setShowHeaders((s) => !s)}
                >
                    {showHeaders ? 'Hide' : 'Show'} {response.headers.length} response header
                    {response.headers.length === 1 ? '' : 's'}
                </button>
            )}
            {showHeaders && (
                <dl className="pg-resp-headers">
                    {response.headers.map((h, i) => (
                        <div key={i}>
                            <dt>{h.key}</dt>
                            <dd>{h.value}</dd>
                        </div>
                    ))}
                </dl>
            )}

            {emptyBody ? (
                <div className="pg-resp-empty">
                    {ok
                        ? 'Success — the response body is empty.'
                        : 'The response body is empty.'}
                </div>
            ) : (
                <pre className="pg-resp-body">{prettyBody}</pre>
            )}
        </div>
    );
}
