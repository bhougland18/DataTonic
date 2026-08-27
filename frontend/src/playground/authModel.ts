// Auth detection and the credential model (PL-8).
//
// Detection reads the normalised OpenAPI 3.x `components.securitySchemes` plus
// the operation's (or document's) `security` requirements. Because parseSpec
// upgrades Swagger 2.0 first, this is ONE code path: 2.0's `securityDefinitions`
// have already become `securitySchemes` (D3 made first-class by normalisation,
// not by branching here).
//
// The credential shape mirrors the Canvas REST node's exact auth prop keys
// (`authType`, `authToken`, `authHeader`, `tokenUrl`, `clientId`, `clientSecret`,
// `clientAuth`, `scope`) so a saved connection (PL-9) and a future Canvas
// transfer (1e / PL-15) reuse the same fields with no conversion layer.

export type AuthKind = 'bearer' | 'apikey' | 'basic' | 'oauth2-cc' | 'unsupported';

export interface DetectedScheme {
    // Key under components.securitySchemes.
    schemeName: string;
    kind: AuthKind;
    // apiKey specifics.
    in?: 'header' | 'query' | 'cookie';
    paramName?: string;
    // oauth2 client-credentials specifics.
    tokenUrl?: string;
    scopes?: string[];
    // Why an otherwise-declared scheme is unsupported in v1 (e.g. a non-CC
    // OAuth2 flow, openIdConnect, digest). Surfaced honestly rather than hidden.
    unsupportedReason?: string;
}

export interface DetectedAuth {
    schemes: DetectedScheme[];
    // True when the operation lists no security, or includes an empty `{}`
    // requirement (OpenAPI's way of saying "auth optional here").
    optional: boolean;
    // True when the operation genuinely requires no auth.
    none: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

function classify(schemeName: string, schemeRaw: unknown): DetectedScheme {
    const s = asRecord(schemeRaw);
    if (!s) return { schemeName, kind: 'unsupported', unsupportedReason: 'malformed scheme' };
    const type = typeof s.type === 'string' ? s.type : '';
    if (type === 'http') {
        const scheme = typeof s.scheme === 'string' ? s.scheme.toLowerCase() : '';
        if (scheme === 'bearer') return { schemeName, kind: 'bearer' };
        if (scheme === 'basic') return { schemeName, kind: 'basic' };
        return { schemeName, kind: 'unsupported', unsupportedReason: `http scheme "${scheme || '?'}"` };
    }
    if (type === 'apiKey') {
        const loc = s.in === 'header' || s.in === 'query' || s.in === 'cookie' ? s.in : 'header';
        return {
            schemeName,
            kind: 'apikey',
            in: loc,
            paramName: typeof s.name === 'string' ? s.name : undefined,
        };
    }
    if (type === 'oauth2') {
        const flows = asRecord(s.flows);
        const cc = flows && asRecord(flows.clientCredentials);
        if (cc) {
            const scopeObj = asRecord(cc.scopes);
            return {
                schemeName,
                kind: 'oauth2-cc',
                tokenUrl: typeof cc.tokenUrl === 'string' ? cc.tokenUrl : undefined,
                scopes: scopeObj ? Object.keys(scopeObj) : [],
            };
        }
        return {
            schemeName,
            kind: 'unsupported',
            unsupportedReason: 'OAuth2 flow other than client-credentials',
        };
    }
    return { schemeName, kind: 'unsupported', unsupportedReason: type || 'unknown scheme type' };
}

// Resolve the auth an operation declares. Operation-level `security` overrides
// the document default; each array entry is one alternative (OR), each object
// key within it a required scheme (AND). For v1 we surface the union of schemes
// referenced so the user sees every credential the operation might want.
export function detectAuth(document: unknown, path: string, method: string): DetectedAuth {
    const doc = asRecord(document);
    const components = doc && asRecord(doc.components);
    const securitySchemes = (components && asRecord(components.securitySchemes)) ?? {};

    const paths = doc && asRecord(doc.paths);
    const pathItem = paths && asRecord(paths[path]);
    const op = pathItem && asRecord(pathItem[method]);

    const requirements = Array.isArray(op?.security)
        ? op!.security
        : Array.isArray(doc?.security)
          ? doc!.security
          : null;

    // No `security` anywhere -> no auth required.
    if (!requirements) return { schemes: [], optional: false, none: true };

    let optional = false;
    const names = new Set<string>();
    for (const req of requirements) {
        const r = asRecord(req);
        if (!r || Object.keys(r).length === 0) {
            optional = true; // an empty requirement means auth is optional here
            continue;
        }
        for (const name of Object.keys(r)) names.add(name);
    }

    const schemes = [...names].map((name) => classify(name, securitySchemes[name]));
    return { schemes, optional, none: schemes.length === 0 && !optional };
}

// ---- Credential model (mirrors the Canvas REST node's auth props) ----

export type NodeAuthType = 'none' | 'bearer' | 'apikey' | 'basic' | 'oauth_client_credentials';

export interface AuthCredentials {
    authType: NodeAuthType;
    // Bearer token, api key value, or `user:password` for basic.
    authToken?: string;
    // API-key header name (apikey in header). Default X-API-Key.
    authHeader?: string;
    // Playground-only: where an api key goes. The Canvas node only models header
    // api keys; a query api key is honoured by the Playground's own send (1d)
    // and flagged at transfer time (1e).
    apiKeyIn?: 'header' | 'query';
    apiKeyName?: string;
    // OAuth2 client-credentials.
    tokenUrl?: string;
    clientId?: string;
    clientSecret?: string;
    clientAuth?: 'body' | 'basic';
    scope?: string;
}

// Seed credentials from a detected scheme so the form starts pre-shaped to what
// the spec declares (PL-8), leaving secret values for the user to fill.
export function seedCredentials(scheme: DetectedScheme | undefined): AuthCredentials {
    switch (scheme?.kind) {
        case 'bearer':
            return { authType: 'bearer' };
        case 'basic':
            return { authType: 'basic' };
        case 'apikey':
            return {
                authType: 'apikey',
                apiKeyIn: scheme.in === 'query' ? 'query' : 'header',
                apiKeyName: scheme.paramName,
                authHeader: scheme.in === 'query' ? undefined : (scheme.paramName ?? 'X-API-Key'),
            };
        case 'oauth2-cc':
            return {
                authType: 'oauth_client_credentials',
                tokenUrl: scheme.tokenUrl,
                clientAuth: 'body',
                scope: scheme.scopes?.join(' ') || undefined,
            };
        default:
            return { authType: 'none' };
    }
}
