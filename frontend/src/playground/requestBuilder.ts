// Assembling a concrete HTTP request from the form state (feeds PL-11 send,
// PL-14 save, and — later — 1e transfer to Canvas).
//
// Two outputs from the same inputs:
//   buildUrl(...)      -> the absolute URL (base + path params + query), for
//                         display and for the send command.
//   buildRestProps(...) -> the exact `src.rest` node prop bag the backend
//                         `rest_send_once` command consumes and that a
//                         transferred Canvas node will hold (auth keys match
//                         the node: authType/authToken/authHeader/tokenUrl/
//                         clientId/clientSecret/clientAuth/scope, or connectionRef).

import type { AuthCredentials } from './authModel';
import type { EndpointOperation } from './types';

export interface KeyValue {
    key: string;
    value: string;
}

export interface RequestFormState {
    baseUrl: string;
    // Keyed `${location}:${name}` exactly as RequestPanel stores them.
    paramValues: Record<string, string>;
    extraHeaders: KeyValue[];
    body: string;
    contentType: string;
    // Auth is EITHER a saved connection (resolved + decrypted backend-side) OR
    // inline credentials.
    connectionId: string | null;
    creds: AuthCredentials;
}

function paramKey(location: string, name: string): string {
    return `${location}:${name}`;
}

// Substitute {name} path templates. Missing values are left as the literal
// template so the gap is visible in the previewed URL rather than silently
// dropped.
function applyPathParams(path: string, values: Record<string, string>): string {
    return path.replace(/\{([^}]+)\}/g, (_m, name: string) => {
        const v = values[paramKey('path', String(name))];
        return v ? encodeURIComponent(v) : `{${name}}`;
    });
}

// Join a base URL and a path without doubling or dropping slashes.
function joinUrl(base: string, path: string): string {
    if (!base) return path;
    return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

export function buildUrl(op: EndpointOperation, form: RequestFormState): string {
    const url = joinUrl(form.baseUrl.trim(), applyPathParams(op.path, form.paramValues));
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(form.paramValues)) {
        if (!k.startsWith('query:') || !v) continue;
        query.append(k.slice('query:'.length), v);
    }
    // Inline api key in the query string (the node's header-only apikey can't
    // model this, so the Playground applies it here for its own send).
    if (
        !form.connectionId &&
        form.creds.authType === 'apikey' &&
        form.creds.apiKeyIn === 'query' &&
        form.creds.apiKeyName &&
        form.creds.authToken
    ) {
        query.append(form.creds.apiKeyName, form.creds.authToken);
    }
    const qs = query.toString();
    return qs ? `${url}?${qs}` : url;
}

// Header parameters + user extra headers + content-type. Auth headers (bearer /
// header-api-key / basic) are intentionally NOT added here: the backend applies
// them from the auth props so a saved connection's secret never has to touch
// the frontend request. Returned as the node's key/value array shape.
export function buildHeaders(form: RequestFormState): KeyValue[] {
    const headers: KeyValue[] = [];
    for (const [k, v] of Object.entries(form.paramValues)) {
        if (!k.startsWith('header:') || !v) continue;
        headers.push({ key: k.slice('header:'.length), value: v });
    }
    for (const h of form.extraHeaders) {
        if (h.key.trim()) headers.push({ key: h.key.trim(), value: h.value });
    }
    if (form.body.trim() && form.contentType && !headers.some((h) => h.key.toLowerCase() === 'content-type')) {
        headers.push({ key: 'Content-Type', value: form.contentType });
    }
    return headers;
}

const METHODS_WITH_BODY = new Set(['post', 'put', 'patch', 'delete']);

// The `src.rest` node prop bag the backend send consumes and a Canvas node will
// hold. Auth is expressed either as a connectionRef (preferred) or inline keys.
export function buildRestProps(op: EndpointOperation, form: RequestFormState): Record<string, unknown> {
    const props: Record<string, unknown> = {
        url: buildUrl(op, form),
        method: op.method.toUpperCase(),
        headers: buildHeaders(form),
    };
    if (form.body.trim() && METHODS_WITH_BODY.has(op.method)) props.body = form.body;

    if (form.connectionId) {
        props.connectionRef = form.connectionId;
        return props;
    }

    const c = form.creds;
    if (c.authType !== 'none') props.authType = c.authType;
    switch (c.authType) {
        case 'bearer':
            if (c.authToken) props.authToken = c.authToken;
            break;
        case 'basic':
            // RequestPanel composes user:password into authToken before send.
            if (c.authToken) props.authToken = c.authToken;
            break;
        case 'apikey':
            // Header api key travels as node props; query api key already went
            // into the URL above, so drop its authType to avoid a double-send.
            if (c.apiKeyIn === 'query') {
                delete props.authType;
            } else {
                if (c.authToken) props.authToken = c.authToken;
                if (c.authHeader) props.authHeader = c.authHeader;
            }
            break;
        case 'oauth_client_credentials':
            if (c.tokenUrl) props.tokenUrl = c.tokenUrl;
            if (c.clientId) props.clientId = c.clientId;
            if (c.clientSecret) props.clientSecret = c.clientSecret;
            if (c.clientAuth) props.clientAuth = c.clientAuth;
            if (c.scope) props.scope = c.scope;
            break;
    }
    return props;
}

// Base URLs the spec declares (OpenAPI 3.x `servers`; Swagger 2.0's host/
// basePath/schemes were converted to `servers` by the parse-time upgrade).
// Server-variable defaults are substituted so the URL is usable as-is.
export function specServers(document: unknown): string[] {
    const doc = document as { servers?: unknown } | null;
    if (!doc || !Array.isArray(doc.servers)) return [];
    const out: string[] = [];
    for (const s of doc.servers) {
        const server = s as { url?: unknown; variables?: Record<string, { default?: unknown }> };
        if (typeof server.url !== 'string') continue;
        let url = server.url;
        if (server.variables) {
            for (const [name, v] of Object.entries(server.variables)) {
                if (v && typeof v.default === 'string') url = url.replaceAll(`{${name}}`, v.default);
            }
        }
        out.push(url);
    }
    return out;
}
