// Obtaining an ION API bearer token. Two grants, both POSTing to the tenant's
// token endpoint from the .ionapi:
//   - service account  (grant_type=password, saak/sask)  -> no webview
//   - refresh          (grant_type=refresh_token)        -> silent renew
//
// The request goes through the SAME backend send path (rest_send_once) the
// Playground already uses, so it is proxy-aware and never hits CORS: client
// credentials ride as HTTP Basic (authType=basic → base64 ci:cs), and the grant
// params are a form body. The interactive authorization-code (webview) grant
// exchanges its code at this same endpoint and is layered on next.

import { sendRequest } from '../../sendClient';
import type { IonApiConfig } from './ionapi';

export interface IonApiToken {
    accessToken: string;
    tokenType: string;       // normally "Bearer"
    refreshToken?: string;
    // Absolute expiry (ms epoch) computed from expires_in at mint time. Optional:
    // some tenants omit expires_in.
    expiresAt?: number;
}

export type TokenResult =
    | { ok: true; token: IonApiToken }
    | { ok: false; error: string };

function form(fields: Record<string, string | undefined>): string {
    return Object.entries(fields)
        .filter(([, v]) => v !== undefined && v !== '')
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v as string)}`)
        .join('&');
}

// Shared: POST a form-encoded grant to the token endpoint with Basic client auth,
// and normalise the JSON token response.
async function postGrant(
    config: IonApiConfig,
    body: string,
    workspacePath: string | null,
    nowMs: number,
): Promise<TokenResult> {
    const props: Record<string, unknown> = {
        url: config.tokenUrl,
        method: 'POST',
        // authType 'basic' → the backend base64-encodes "id:secret" into the
        // Authorization header (push_rest_auth), the client-auth Infor expects.
        authType: 'basic',
        authToken: `${config.clientId}:${config.clientSecret}`,
        headers: [{ key: 'Content-Type', value: 'application/x-www-form-urlencoded' }],
        body,
    };

    const outcome = await sendRequest(props, workspacePath);
    if (outcome.kind === 'unavailable') {
        return { ok: false, error: 'Token request needs the desktop app or web backend.' };
    }
    if (outcome.kind === 'network-error') {
        return { ok: false, error: `Could not reach the token endpoint: ${outcome.message}` };
    }
    const { status, body: respBody } = outcome.response;
    let json: Record<string, unknown>;
    try {
        json = JSON.parse(respBody);
    } catch {
        return { ok: false, error: `Token endpoint returned non-JSON (HTTP ${status}).` };
    }
    if (status < 200 || status >= 300 || typeof json.access_token !== 'string') {
        // Infor returns { error, error_description } on failure.
        const detail = typeof json.error_description === 'string'
            ? json.error_description
            : typeof json.error === 'string'
              ? json.error
              : `HTTP ${status}`;
        return { ok: false, error: `Token request rejected: ${detail}` };
    }

    const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : undefined;
    return {
        ok: true,
        token: {
            accessToken: json.access_token,
            tokenType: typeof json.token_type === 'string' ? json.token_type : 'Bearer',
            refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : undefined,
            expiresAt: expiresIn ? nowMs + expiresIn * 1000 : undefined,
        },
    };
}

// OAuth2 Resource Owner Password Credentials grant. This is the grant the
// ROIHS_PP1 stage app is configured for (the token endpoint answers
// "unsupported_grant_type ... Expected one of password" to anything else). The
// username must be tenant-qualified — an Infor cloud identity in this tenant —
// or the endpoint rejects with "Username does not match request tenant".
export function mintPasswordToken(
    config: IonApiConfig,
    username: string,
    password: string,
    workspacePath: string | null,
    nowMs: number,
): Promise<TokenResult> {
    return postGrant(
        config,
        form({ grant_type: 'password', username, password, scope: config.scope }),
        workspacePath,
        nowMs,
    );
}

// Service-account variant: same password grant, but the credentials are the
// .ionapi's service-account keys (present only on backend-service apps).
export function mintServiceAccountToken(
    config: IonApiConfig,
    workspacePath: string | null,
    nowMs: number,
): Promise<TokenResult> {
    if (!config.saak || !config.sask) {
        return Promise.resolve({
            ok: false,
            error: 'This .ionapi has no service-account keys (saak/sask). Sign in with your Infor user credentials instead.',
        });
    }
    return mintPasswordToken(config, config.saak, config.sask, workspacePath, nowMs);
}

export function refreshAccessToken(
    config: IonApiConfig,
    refreshToken: string,
    workspacePath: string | null,
    nowMs: number,
): Promise<TokenResult> {
    return postGrant(
        config,
        form({ grant_type: 'refresh_token', refresh_token: refreshToken, scope: config.scope }),
        workspacePath,
        nowMs,
    );
}
