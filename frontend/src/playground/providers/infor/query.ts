// Running a Landmark `_generic` list query (task 1o). Builds the query string
// from the field selection + filter, calls through the backend send path, and
// parses the `{_fields}` / `_links` response via inforApi.parseGenericResponse.

import { sendRequest } from '../../sendClient';
import { parseGenericResponse, restBase, type GenericPage, type DataAreaId } from './inforApi';
import type { IonApiConfig } from './ionapi';
import type { FilterGroup } from './filterModel';

export interface GenericQuery {
    fields: string[];
    // The `_filter` condition expression built by the visual filter builder,
    // e.g. `Item like "100*"` or `(Item like "100*" or ItemGroup = 200)`.
    // Empty/undefined omits `_filter`.
    filter?: string;
    // Undefined omits `_limit` entirely (server default / all rows).
    limit?: number;
}

export type QueryResult =
    | { ok: true; page: GenericPage; status: number; url: string }
    | { ok: false; status: number; error: string };

// The subset of an Infor source node's props that the Playground round-trips:
// pre-loaded into the query builder on open, and written back on "Apply to
// node". Mirrors the src.infor manifest fields (connectionRef/lplFilter stay on
// the node and are not edited here).
export interface InforNodeQuery {
    dataArea?: DataAreaId;
    businessClass?: string;
    fields?: string;
    // The compiled `_filter` expression (what actually runs).
    filter?: string;
    // The structured filter tree that produced `filter` (round-trips so the
    // builder can be re-edited). Absent on legacy nodes.
    filterTree?: FilterGroup;
    limit?: number;
}

function genericUrl(
    config: IonApiConfig,
    businessClass: string,
    q: GenericQuery,
    dataArea?: DataAreaId,
): string {
    const params = new URLSearchParams();
    if (q.fields.length) params.set('_fields', q.fields.join(','));
    if (q.filter && q.filter.trim()) params.set('_filter', q.filter.trim());
    if (typeof q.limit === 'number' && q.limit > 0) params.set('_limit', String(q.limit));
    return `${restBase(config, dataArea)}/classes/${encodeURIComponent(businessClass)}/lists/_generic?${params.toString()}`;
}

async function getGeneric(
    accessToken: string,
    url: string,
    workspacePath: string | null,
): Promise<QueryResult> {
    const outcome = await sendRequest(
        { url, method: 'GET', authType: 'bearer', authToken: accessToken },
        workspacePath,
    );
    if (outcome.kind === 'unavailable') {
        return { ok: false, status: 0, error: 'Query needs the desktop app or web backend.' };
    }
    if (outcome.kind === 'network-error') {
        return { ok: false, status: 0, error: outcome.message };
    }
    const { status, body } = outcome.response;
    let json: unknown;
    try {
        json = JSON.parse(body);
    } catch {
        return { ok: false, status, error: `Response was not JSON (HTTP ${status}).` };
    }
    const exception = (json as { exception?: { message?: string } }).exception;
    if (exception) return { ok: false, status, error: exception.message ?? 'Landmark exception' };
    return { ok: true, page: parseGenericResponse(json), status, url };
}

export function runGenericQuery(
    config: IonApiConfig,
    accessToken: string,
    businessClass: string,
    q: GenericQuery,
    workspacePath: string | null,
    dataArea?: DataAreaId,
): Promise<QueryResult> {
    return getGeneric(accessToken, genericUrl(config, businessClass, q, dataArea), workspacePath);
}

// Discover a business class's (persistent) fields by sampling one row — the
// `_fields` keys of the returned row are the class's default field set. Cheap
// and avoids fetching the full entity swagger. Returns [] if the class has no
// rows to sample (the caller can still let the user type field names).
export async function sampleFields(
    config: IonApiConfig,
    accessToken: string,
    businessClass: string,
    workspacePath: string | null,
    dataArea?: DataAreaId,
): Promise<{ ok: true; fields: string[] } | { ok: false; error: string }> {
    const url = `${restBase(config, dataArea)}/classes/${encodeURIComponent(businessClass)}/lists/_generic?_limit=1`;
    const res = await getGeneric(accessToken, url, workspacePath);
    if (!res.ok) return { ok: false, error: res.error };
    const first = res.page.rows[0];
    return { ok: true, fields: first ? Object.keys(first) : [] };
}
