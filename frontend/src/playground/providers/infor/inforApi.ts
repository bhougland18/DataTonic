// Infor FSM REST calls through the backend send path (proxy-aware, no CORS).
// Confirmed live (2026-08-31): discovery and data both hang off the FSM REST
// base `{iu}/{tenant}/FSM/fsm/soap`.

import { sendRequest } from '../../sendClient';
import type { IonApiConfig } from './ionapi';

export function restBase(config: IonApiConfig): string {
    return `${config.ionApiBase.replace(/\/+$/, '')}/${config.tenant}/FSM/fsm/soap`;
}

export interface ProbeResult {
    ok: boolean;
    status: number;
    rowCount?: number;
    message?: string;
}

// One row of a `_generic` list: the field name → value map.
export type GenericRow = Record<string, unknown>;

export interface GenericPage {
    rows: GenericRow[];
    // Landmark paging hrefs (relative). `next` carries `_paging=NEXT&_position=…`.
    self?: string;
    next?: string;
    prev?: string;
}

// Parse a Landmark `_generic` list response. The body is a JSON array whose
// first element is metadata (`{_count, _links}`) and whose remaining elements
// are rows shaped `{_fields: {Field: value, …}}`. Confirmed live 2026-08-31.
export function parseGenericResponse(json: unknown): GenericPage {
    const arr: unknown[] = Array.isArray(json)
        ? json
        : json && typeof json === 'object'
          ? Object.values(json as Record<string, unknown>)
          : [];
    const page: GenericPage = { rows: [] };
    for (const el of arr) {
        if (!el || typeof el !== 'object') continue;
        const o = el as Record<string, unknown>;
        if (o._fields && typeof o._fields === 'object') {
            page.rows.push(o._fields as GenericRow);
        } else if (Array.isArray(o._links)) {
            for (const raw of o._links) {
                const l = raw as { rel?: string; href?: string };
                if (!l || typeof l.href !== 'string' || !l.href) continue;
                if (l.rel === 'next') page.next = l.href;
                else if (l.rel === 'prev') page.prev = l.href;
                else if (l.rel === 'self') page.self = l.href;
            }
        }
    }
    return page;
}

// Minimal `_generic` call to confirm the token has an FSM data context. A
// service-account token fails here with "No data context available"; a properly
// provisioned user token should return rows (or at least a non-exception 200).
export async function probeDataAccess(
    config: IonApiConfig,
    accessToken: string,
    workspacePath: string | null,
): Promise<ProbeResult> {
    const url = `${restBase(config)}/classes/Item/lists/_generic?_fields=Item,ItemGroup&_limit=1`;
    const outcome = await sendRequest(
        { url, method: 'GET', authType: 'bearer', authToken: accessToken },
        workspacePath,
    );
    if (outcome.kind === 'unavailable') {
        return { ok: false, status: 0, message: 'Send backend unavailable in this session.' };
    }
    if (outcome.kind === 'network-error') {
        return { ok: false, status: 0, message: outcome.message };
    }
    const { status, body } = outcome.response;
    let json: Record<string, unknown>;
    try {
        json = JSON.parse(body);
    } catch {
        return { ok: false, status, message: `Non-JSON response (HTTP ${status}).` };
    }
    // Landmark returns { exception: { message, class } } on a context/auth problem.
    const exception = json.exception as { message?: string } | undefined;
    if (exception) {
        return { ok: false, status, message: exception.message ?? 'Landmark exception' };
    }
    return {
        ok: status >= 200 && status < 300,
        status,
        rowCount: parseGenericResponse(json).rows.length,
    };
}
