// Running a Landmark `_generic` list query (task 1o). Builds the query string
// from the field selection + filter, calls through the backend send path, and
// parses the `{_fields}` / `_links` response via inforApi.parseGenericResponse.

import { sendRequest } from '../../sendClient';
import { parseGenericResponse, restBase, type GenericPage, type DataAreaId } from './inforApi';
import type { IonApiConfig } from './ionapi';
import type { FilterGroup } from './filterModel';

export interface FilterCondition {
    field: string;
    value: string;
}

export interface GenericQuery {
    fields: string[];
    // Simple filter conditions -> `_filter=field::value|field2::value2`.
    filter: FilterCondition[];
    // Optional raw LPL expression -> `_lplFilter` (advanced, e.g. (Item like "10*")).
    lpl?: string;
    // Undefined omits `_limit` entirely (server default / all rows).
    limit?: number;
}

export type QueryResult =
    | { ok: true; page: GenericPage; status: number; url: string }
    | { ok: false; status: number; error: string };

// Landmark simple-filter syntax: name::value pairs joined by '|'.
export function buildSimpleFilter(conds: FilterCondition[]): string {
    return conds
        .filter((c) => c.field.trim() && c.value.trim())
        .map((c) => `${c.field.trim()}::${c.value.trim()}`)
        .join('|');
}

// Inverse of buildSimpleFilter: turn a stored `_filter` string back into
// editable conditions when pre-loading a Canvas node's query into the builder.
export function parseSimpleFilter(filter: string | undefined): FilterCondition[] {
    if (!filter) return [];
    return filter
        .split('|')
        .map((part) => {
            const i = part.indexOf('::');
            if (i < 0) return null;
            return { field: part.slice(0, i).trim(), value: part.slice(i + 2).trim() };
        })
        .filter((c): c is FilterCondition => c !== null && c.field.length > 0);
}

// The subset of an Infor source node's props that the Playground round-trips:
// pre-loaded into the query builder on open, and written back on "Apply to
// node". Mirrors the src.infor manifest fields (connectionRef/lplFilter stay on
// the node and are not edited here).
export interface InforNodeQuery {
    dataArea?: DataAreaId;
    businessClass?: string;
    fields?: string;
    // Legacy simple filter (field::value); superseded by filterTree but still
    // read to upgrade pre-existing nodes.
    filter?: string;
    lplFilter?: string;
    // The structured filter tree (round-trips for editing); lplFilter is its
    // compiled form that actually runs.
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
    const simple = buildSimpleFilter(q.filter);
    if (simple) params.set('_filter', simple);
    if (q.lpl && q.lpl.trim()) params.set('_lplFilter', q.lpl.trim());
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
