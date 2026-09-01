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
