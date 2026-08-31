// A session-scoped, shared token cache for Infor connections (task 1r). Keyed by
// the Infor app identity (tenant + client id), so multiple consumers — the
// sign-in panel now, several Canvas nodes later — that reference the SAME
// connection share ONE live token instead of each authenticating separately.
// One in-flight mint is de-duplicated; an expired token is re-minted once.

import { mintPasswordToken, mintServiceAccountToken, type IonApiToken, type TokenResult } from './inforAuth';
import type { IonApiConfig } from './ionapi';

interface Entry {
    token: IonApiToken | null;
    inflight: Promise<TokenResult> | null;
}

const store = new Map<string, Entry>();
const EXPIRY_SKEW_MS = 60_000;

export function tokenKey(config: IonApiConfig): string {
    return `${config.tenant}:${config.clientId}`;
}

export type SignInMode =
    | { kind: 'service' }
    | { kind: 'user'; username: string; password: string };

// Return a valid token for the connection, reusing a cached one when possible.
export function getSharedToken(
    config: IonApiConfig,
    mode: SignInMode,
    workspacePath: string | null,
    nowMs: number,
): Promise<TokenResult> {
    const key = tokenKey(config);
    const entry = store.get(key);
    if (entry?.token && (!entry.token.expiresAt || entry.token.expiresAt - EXPIRY_SKEW_MS > nowMs)) {
        return Promise.resolve({ ok: true, token: entry.token });
    }
    if (entry?.inflight) return entry.inflight;

    const mint =
        mode.kind === 'service'
            ? mintServiceAccountToken(config, workspacePath, nowMs)
            : mintPasswordToken(config, mode.username, mode.password, workspacePath, nowMs);

    const inflight = mint.then((res) => {
        if (res.ok) store.set(key, { token: res.token, inflight: null });
        else {
            const cur = store.get(key);
            if (cur) cur.inflight = null;
        }
        return res;
    });
    store.set(key, { token: entry?.token ?? null, inflight });
    return inflight;
}

// Read a cached token without minting (e.g. for a node that expects the
// connection to already be signed in this session).
export function peekSharedToken(config: IonApiConfig, nowMs: number): IonApiToken | null {
    const entry = store.get(tokenKey(config));
    if (entry?.token && (!entry.token.expiresAt || entry.token.expiresAt - EXPIRY_SKEW_MS > nowMs)) {
        return entry.token;
    }
    return null;
}

export function clearSharedToken(config: IonApiConfig): void {
    store.delete(tokenKey(config));
}
