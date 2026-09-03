// Business-class discovery for the Infor provider (task 1g). Lists the FSM
// business classes from `…/soap/ionapi-doc`, which supports server-side search
// (`search=`, confirmed live — narrows the ~4,940 classes) and paging
// (`pageNumber`/`pageSize`). Goes through the backend send path.

import { sendRequest } from '../../sendClient';
import { restBase, type DataAreaId } from './inforApi';
import type { IonApiConfig } from './ionapi';

export interface BusinessClass {
    entity: string;
    desc?: string;
    category?: string;
    swaggerEndpoint?: string;
}

export interface BusinessClassPage {
    items: BusinessClass[];
    total: number;
    page: number;
    pageSize: number;
}

export type DiscoveryResult =
    | { ok: true; page: BusinessClassPage }
    | { ok: false; error: string };

export async function listBusinessClasses(
    config: IonApiConfig,
    accessToken: string,
    opts: { page: number; pageSize: number; search?: string },
    workspacePath: string | null,
    dataArea?: DataAreaId,
): Promise<DiscoveryResult> {
    const params = new URLSearchParams({
        pageNumber: String(opts.page),
        pageSize: String(opts.pageSize),
    });
    if (opts.search && opts.search.trim()) params.set('search', opts.search.trim());

    const outcome = await sendRequest(
        {
            url: `${restBase(config, dataArea)}/ionapi-doc?${params.toString()}`,
            method: 'GET',
            authType: 'bearer',
            authToken: accessToken,
        },
        workspacePath,
    );
    if (outcome.kind === 'unavailable') {
        return { ok: false, error: 'Discovery needs the desktop app or web backend.' };
    }
    if (outcome.kind === 'network-error') {
        return { ok: false, error: outcome.message };
    }

    let json: Record<string, unknown>;
    try {
        json = JSON.parse(outcome.response.body);
    } catch {
        return { ok: false, error: `Discovery returned non-JSON (HTTP ${outcome.response.status}).` };
    }
    const exception = json.exception as { message?: string } | undefined;
    if (exception) return { ok: false, error: exception.message ?? 'Landmark exception' };

    const collection = json.swaggerCollection as { swagger?: unknown[] } | undefined;
    const swagger = Array.isArray(collection?.swagger) ? collection!.swagger! : [];
    const items: BusinessClass[] = swagger
        .map((raw) => {
            const e = raw as Record<string, unknown>;
            return {
                entity: typeof e.entity === 'string' ? e.entity : '',
                desc: typeof e.desc === 'string' ? e.desc : undefined,
                category: typeof e.category === 'string' ? e.category : undefined,
                swaggerEndpoint: typeof e.swaggerEndpoint === 'string' ? e.swaggerEndpoint : undefined,
            };
        })
        .filter((c) => c.entity);

    const paging = (json.paging as Record<string, unknown>) ?? {};
    return {
        ok: true,
        page: {
            items,
            total: typeof paging.total === 'number' ? paging.total : items.length,
            page: typeof paging.pageNumber === 'number' ? paging.pageNumber : opts.page,
            pageSize: typeof paging.pageSize === 'number' ? paging.pageSize : opts.pageSize,
        },
    };
}

export type ClassSwaggerResult =
    | { ok: true; swagger: unknown; url: string; status: number }
    | { ok: false; error: string; url: string; status: number };

// Fetch a business class's OpenAPI/swagger document from the `swaggerEndpoint`
// captured during class discovery, through the same backend send path + bearer
// token the reads use. The write side (snk.infor) feeds the result to
// `parsePostActions()` to list POST actions + their fields. The endpoint's form
// varies by tenant: an absolute URL is used as-is; a leading-slash path hangs off
// the ION API host; anything else is treated as relative to the REST base.
export async function fetchClassSwagger(
    config: IonApiConfig,
    accessToken: string,
    swaggerEndpoint: string,
    workspacePath: string | null,
    dataArea?: DataAreaId,
): Promise<ClassSwaggerResult> {
    const ep = (swaggerEndpoint ?? '').trim();
    if (!ep) return { ok: false, error: 'Class has no swaggerEndpoint to fetch.', url: '', status: 0 };

    // The ionapi-doc swaggerEndpoint is a relative ref (e.g.
    // "../../consolidated/ic/Item") whose intended base is undocumented, so resolve
    // it against the plausible bases (class resource, the soap resource, the soap
    // directory, a deeper list resource) and use the first that returns a real
    // swagger - a JSON doc with `paths`. Absolute endpoints are used as-is. Every
    // attempt is recorded so a total miss reports what was tried.
    const rb = restBase(config, dataArea);
    const candidates: string[] = [];
    const push = (u: string) => {
        if (u && !candidates.includes(u)) candidates.push(u);
    };
    if (/^https?:\/\//i.test(ep)) {
        push(ep);
    } else {
        // Primary (confirmed live via the Infor API Gateway): the `ionapi-doc`
        // endpoint returns a class's swagger when its relative swaggerEndpoint ref
        // is passed as a query param, e.g.
        //   {restBase}/ionapi-doc/?swaggerEndpoint=../../consolidated/ic/Item
        push(`${rb}/ionapi-doc/?swaggerEndpoint=${encodeURIComponent(ep)}`);
        // Fallbacks: direct relative resolutions, in case a tenant serves the
        // swagger straight from the resolved path.
        for (const base of [`${rb}/classes/_`, rb, `${rb}/`]) {
            try {
                push(new URL(ep, base).toString());
            } catch {
                /* skip a malformed base */
            }
        }
        push(ep);
    }

    let lastUrl = ep;
    let lastStatus = 0;
    let lastErr = 'no candidate URL could be built';
    for (const url of candidates) {
        const outcome = await sendRequest(
            { url, method: 'GET', authType: 'bearer', authToken: accessToken },
            workspacePath,
        );
        if (outcome.kind === 'unavailable') {
            return { ok: false, error: 'Swagger fetch needs the desktop app or web backend.', url, status: 0 };
        }
        if (outcome.kind === 'network-error') {
            lastUrl = url;
            lastErr = outcome.message;
            continue;
        }
        const status = outcome.response.status;
        lastUrl = url;
        lastStatus = status;
        if (status >= 200 && status < 300) {
            try {
                const swagger = JSON.parse(outcome.response.body) as { paths?: unknown };
                if (swagger && typeof swagger === 'object' && swagger.paths) {
                    return { ok: true, swagger, url, status };
                }
                lastErr = 'response had no `paths` (not a swagger)';
            } catch {
                lastErr = 'non-JSON response';
            }
        } else {
            lastErr = `HTTP ${status}`;
        }
    }
    return {
        ok: false,
        error: `Could not fetch a swagger (last: ${lastErr}).\nTried:\n${candidates.join('\n')}`,
        url: lastUrl,
        status: lastStatus,
    };
}
