// The bridge between Playground credentials and duckle's saved-Connection
// mechanism (PL-9). This is the ONE Playground file that couples to the shared
// `ConnectionPayload` type, on purpose: PL-9 forbids a parallel credential
// store, so we translate to/from the exact payload the rest of the app already
// encrypts, persists (`connections/<id>.json`), and resolves at run time via
// `merge_rest_connection`.

import type { ConnectionPayload } from '../repo-types';
import type { AuthCredentials, NodeAuthType } from './authModel';

// The minimal connection record the Playground needs from App's repo state:
// enough to list rest connections and read one back into the auth form.
export interface PlaygroundConnection {
    id: string;
    name: string;
    payload: ConnectionPayload;
}

// Connection kinds whose payloads carry REST-style auth the Playground can
// reuse. `http` is transport-only (proxy/timeouts) so it is intentionally not
// offered as a credential source here.
const REST_LIKE: ReadonlyArray<ConnectionPayload['kind']> = ['rest', 'salesforce'];

export function isRestLikeConnection(conn: PlaygroundConnection): boolean {
    return REST_LIKE.includes(conn.payload?.kind);
}

// Translate captured credentials into a `rest` ConnectionPayload for saving
// through the existing mechanism. `clientAuth`/`scope` are deliberately omitted:
// they are node-level props (merge_rest_connection does not carry them on a
// connection), so they travel with a transferred node, not the saved secret.
export function credentialsToPayload(
    creds: AuthCredentials,
    url: string | undefined,
    extraHeaders: { key: string; value: string }[],
): ConnectionPayload {
    const headers = extraHeaders.filter((h) => h.key.trim());
    const payload: ConnectionPayload = { kind: 'rest' };
    if (url && url.trim()) payload.url = url.trim();
    if (headers.length) payload.headers = headers;
    if (creds.authType !== 'none') payload.authType = creds.authType;
    if (creds.authToken) payload.authToken = creds.authToken;
    // Header api keys carry their header name; a query api key has no node-level
    // home, so it is not persisted on the connection (see authModel note).
    if (creds.authType === 'apikey' && creds.apiKeyIn !== 'query' && creds.authHeader) {
        payload.authHeader = creds.authHeader;
    }
    if (creds.authType === 'oauth_client_credentials') {
        if (creds.tokenUrl) payload.tokenUrl = creds.tokenUrl;
        if (creds.clientId) payload.clientId = creds.clientId;
        if (creds.clientSecret) payload.clientSecret = creds.clientSecret;
    }
    return payload;
}

// Read an existing rest-like connection back into the auth form (PL-9: reuse a
// saved connection instead of retyping). Secret values come straight off the
// (decrypted-in-memory) payload.
export function payloadToCredentials(payload: ConnectionPayload): AuthCredentials {
    const authType = (payload.authType ?? 'none') as NodeAuthType;
    const creds: AuthCredentials = { authType };
    if (payload.authToken) creds.authToken = payload.authToken;
    if (payload.authHeader) {
        creds.authHeader = payload.authHeader;
        creds.apiKeyIn = 'header';
    }
    if (payload.tokenUrl) creds.tokenUrl = payload.tokenUrl;
    if (payload.clientId) creds.clientId = payload.clientId;
    if (payload.clientSecret) creds.clientSecret = payload.clientSecret;
    if (authType === 'oauth_client_credentials') creds.clientAuth = 'body';
    return creds;
}
