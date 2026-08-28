// The "send now" transport (PL-11). Calls the backend `rest_send_once` command
// rather than a raw browser fetch — deliberately, per spike S1: the backend
// path honours proxy settings, decrypts a connectionRef, and issues the request
// through the same ureq agent the pipeline run path uses, so a request that
// works here works in the pipeline (and isn't defeated by CORS). The command is
// reachable on desktop (Tauri) and in the web edition (dispatch_cmd), the same
// way run_pipeline is.

import { isTauri } from '../tauri-dialog';
import { isWebBackend } from '../web-fs';

export interface HttpResult {
    status: number;
    statusText?: string;
    headers: { key: string; value: string }[];
    body: string;
    elapsedMs: number;
}

// PL-13: a transport failure (no response at all) is a different outcome from a
// received-but-non-2xx response, which is different again from a 2xx with an
// empty body. The first two are modelled here; the empty-body case is a
// property of a `response` outcome and handled in the view.
export type SendOutcome =
    | { kind: 'response'; response: HttpResult }
    | { kind: 'network-error'; message: string }
    | { kind: 'unavailable' };

function normalizeHeaders(raw: unknown): { key: string; value: string }[] {
    if (Array.isArray(raw)) {
        return raw
            .map((h) => {
                if (Array.isArray(h) && h.length >= 2) return { key: String(h[0]), value: String(h[1]) };
                const r = h as { key?: unknown; value?: unknown } | null;
                return r && typeof r.key === 'string' ? { key: r.key, value: String(r.value ?? '') } : null;
            })
            .filter((h): h is { key: string; value: string } => h !== null);
    }
    if (raw && typeof raw === 'object') {
        return Object.entries(raw as Record<string, unknown>).map(([key, value]) => ({
            key,
            value: String(value),
        }));
    }
    return [];
}

export async function sendRequest(
    props: Record<string, unknown>,
    workspace: string | null,
): Promise<SendOutcome> {
    if (!isTauri() && !isWebBackend()) return { kind: 'unavailable' };
    try {
        const { invoke } = await import('@tauri-apps/api/core');
        const res = await invoke<Record<string, unknown>>('rest_send_once', { props, workspace });
        return {
            kind: 'response',
            response: {
                status: Number(res.status ?? 0),
                statusText: typeof res.statusText === 'string' ? res.statusText : undefined,
                headers: normalizeHeaders(res.headers),
                body: typeof res.body === 'string' ? res.body : JSON.stringify(res.body ?? ''),
                elapsedMs: Number(res.elapsedMs ?? res.elapsed ?? 0),
            },
        };
    } catch (err) {
        // The command rejects on a transport failure (DNS, connection refused,
        // TLS, timeout) with a message string.
        return { kind: 'network-error', message: err instanceof Error ? err.message : String(err) };
    }
}
