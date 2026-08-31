// Parsing an Infor ION API credentials file (`.ionapi`). This JSON is downloaded
// from Infor (ION API → Authorized Apps → Download credentials) and is the
// source of truth for a tenant's OAuth endpoints and client credentials — NOT
// the legacy /sso/SSOServlet path the Excel add-in used. Field names are Infor's
// terse two-letter keys.
//
// We keep this pure and defensive: a real file may carry more keys than we read.

export interface IonApiConfig {
    tenant: string;            // ti
    appName?: string;          // cn
    clientId: string;          // ci
    clientSecret: string;      // cs
    ionApiBase: string;        // iu  — base for API calls (…-ionapi…)
    // Fully-resolved OAuth endpoints (pu + oa / ot / or).
    authorizeUrl: string;      // pu + oa
    tokenUrl: string;          // pu + ot
    revokeUrl?: string;        // pu + or
    redirectUri?: string;      // ru  — registered redirect (interactive flow)
    scope?: string;            // sc / scope, if present
    // Service-account keys (backend/service-account grant — no webview).
    saak?: string;
    sask?: string;
}

export type IonApiParseResult =
    | { ok: true; config: IonApiConfig }
    | { ok: false; error: string };

function joinUrl(base: string, path: string): string {
    if (!base) return path;
    if (/^https?:\/\//i.test(path)) return path; // already absolute
    return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function str(v: unknown): string | undefined {
    return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

export function parseIonApi(text: string): IonApiParseResult {
    let raw: Record<string, unknown>;
    try {
        raw = JSON.parse(text);
    } catch (err) {
        return { ok: false, error: `Not valid JSON: ${(err as Error).message}` };
    }
    if (!raw || typeof raw !== 'object') {
        return { ok: false, error: 'The .ionapi file is not a JSON object.' };
    }

    const ci = str(raw.ci);
    const cs = str(raw.cs);
    const iu = str(raw.iu);
    const pu = str(raw.pu);
    const ot = str(raw.ot);
    const oa = str(raw.oa);

    // The minimum needed to obtain any token.
    const missing = [
        ['ci (client id)', ci],
        ['cs (client secret)', cs],
        ['iu (ION API base)', iu],
        ['pu (OAuth base)', pu],
        ['ot (token path)', ot],
    ].filter(([, v]) => !v).map(([n]) => n);
    if (missing.length) {
        return {
            ok: false,
            error: `This doesn't look like an ION API credentials file — missing: ${missing.join(', ')}.`,
        };
    }

    return {
        ok: true,
        config: {
            tenant: str(raw.ti) ?? '',
            appName: str(raw.cn),
            clientId: ci!,
            clientSecret: cs!,
            ionApiBase: iu!,
            authorizeUrl: oa ? joinUrl(pu!, oa) : '',
            tokenUrl: joinUrl(pu!, ot!),
            revokeUrl: str(raw.or) ? joinUrl(pu!, str(raw.or)!) : undefined,
            redirectUri: str(raw.ru),
            scope: str(raw.sc) ?? str((raw as { scope?: unknown }).scope),
            saak: str(raw.saak),
            sask: str(raw.sask),
        },
    };
}

// A tenant + FSM app base for REST calls (business-class discovery + _generic).
// The ionapi-doc / consolidated paths live under {ionApiBase}/{tenant}/{app}.
export function fsmBase(config: IonApiConfig): string {
    return joinUrl(config.ionApiBase, `${config.tenant}/FSM/fsm`);
}
