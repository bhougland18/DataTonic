// Domain types for the API Playground module (task DAA.17 / FRD PG-1..PG-7).
//
// Kept in the module's own file, deliberately isolated from the shared
// pipeline/canvas types, so the Playground can evolve without touching upstream
// files and incurring rebase cost (decision D4 / ARCH-1). The canonical
// request schema that DOES get shared with the Canvas node lands in task 1e
// (PL-15) — it is intentionally NOT defined here yet.

// HTTP methods an OpenAPI path item can declare. Order is the conventional
// display order, not spec order.
export const HTTP_METHODS = [
    'get',
    'post',
    'put',
    'patch',
    'delete',
    'options',
    'head',
    'trace',
] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

// Normalised spec version. Swagger 2.0 and every OpenAPI 3.x line are all
// first-class per decision D3 — we keep the concrete version because task 1c's
// auth detection branches on it (securityDefinitions vs securitySchemes).
export type SpecVersion =
    | 'swagger-2.0'
    | 'openapi-3.0'
    | 'openapi-3.1'
    | 'openapi-3.2'
    | 'unknown';

// One operation = one (method, path) pair. This is the unit the endpoint tree
// lists (PL-4) and the unit a later increment turns into a request.
export interface EndpointOperation {
    // Stable identifier within a spec: `${METHOD} ${path}`. Used as React key
    // and selection handle. NOT a provenance key — that is operationId.
    id: string;
    method: HttpMethod;
    path: string;
    operationId?: string;
    summary?: string;
    description?: string;
    tags: string[];
    deprecated: boolean;
}

// A parse problem specific enough to act on (PL-5). `location` is a
// human-readable pointer into the document (e.g. "paths./pets.get.responses"),
// derived from the parser's JSON path so the message is never generic.
export interface SpecParseIssue {
    message: string;
    location?: string;
    code?: string;
}

// The successfully parsed, dereferenced spec plus the fields the rest of the
// module needs. `document` is the fully dereferenced OpenAPI object, retained
// for tasks 1c/1d/1e (request construction, send, transfer) — this task only
// reads endpoint metadata off it.
export interface ParsedSpec {
    version: SpecVersion;
    // info.title — the API's human name.
    title: string;
    // info.version — the API's own version string, distinct from SpecVersion.
    apiVersion?: string;
    endpoints: EndpointOperation[];
    document: unknown;
    // Non-fatal problems: e.g. an external/cross-file $ref we deliberately do
    // not resolve in v1 (PL-3). The spec is still usable; we just surface these.
    warnings: SpecParseIssue[];
}

export type ParseOutcome =
    | { ok: true; spec: ParsedSpec }
    | { ok: false; errors: SpecParseIssue[] };

// Where an imported spec came from, for persistence (PL-6) and later
// provenance on a transferred Canvas node (PL-18).
export type SpecSourceKind = 'file' | 'url';
export interface SpecSource {
    kind: SpecSourceKind;
    // For a URL import, the URL. For a file import, the file name.
    ref: string;
    // Original serialization, so a re-parse from the persisted raw text is
    // faithful.
    format: 'json' | 'yaml';
    // ISO-8601 import time.
    importedAt: string;
}
