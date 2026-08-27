// Deriving an editable request form from a selected operation (PL-7).
//
// Reads off the normalised OpenAPI 3.x document (parseSpec upgrades Swagger 2.0
// to this shape), so there is a single code path: path/query/header/cookie
// parameters come from `parameters`, and the body from `requestBody.content`.

import type { EndpointOperation } from './types';

export type ParamLocation = 'path' | 'query' | 'header' | 'cookie';

// The input hints a form control needs, lifted out of the parameter/body JSON
// schema so the UI never has to grovel through the schema itself.
export interface SchemaHints {
    type?: string;
    format?: string;
    enum?: unknown[];
    default?: unknown;
    example?: unknown;
    // For arrays, the item primitive type (best-effort).
    itemType?: string;
}

export interface RequestParam {
    name: string;
    location: ParamLocation;
    required: boolean;
    description?: string;
    hints: SchemaHints;
}

export interface RequestBodyModel {
    required: boolean;
    // Declared media types, first is the default the form pre-selects.
    mediaTypes: string[];
    // Schema for the default media type, retained for a body editor / example.
    schema?: unknown;
    // A pretty-printed starter body when the spec supplies an example.
    example?: unknown;
    description?: string;
}

export interface RequestModel {
    method: EndpointOperation['method'];
    path: string;
    params: RequestParam[];
    body?: RequestBodyModel;
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

function readHints(schemaRaw: unknown, fallbackExample?: unknown): SchemaHints {
    const schema = asRecord(schemaRaw);
    const hints: SchemaHints = {};
    if (!schema) return { example: fallbackExample };
    // `type` in 3.1 can be a string or an array (e.g. ['string','null']).
    if (typeof schema.type === 'string') hints.type = schema.type;
    else if (Array.isArray(schema.type)) {
        const first = schema.type.find((t) => typeof t === 'string' && t !== 'null');
        if (typeof first === 'string') hints.type = first;
    }
    if (typeof schema.format === 'string') hints.format = schema.format;
    if (Array.isArray(schema.enum)) hints.enum = schema.enum;
    if ('default' in schema) hints.default = schema.default;
    hints.example = 'example' in schema ? schema.example : fallbackExample;
    const items = asRecord(schema.items);
    if (items && typeof items.type === 'string') hints.itemType = items.type;
    return hints;
}

// Path-item-level parameters apply to every operation under that path; an
// operation-level parameter with the same (name, location) overrides one from
// the path item. This merge follows the OpenAPI spec's rule.
function mergeParameters(pathItem: Record<string, unknown>, op: Record<string, unknown>): unknown[] {
    const fromPath = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];
    const fromOp = Array.isArray(op.parameters) ? op.parameters : [];
    const byKey = new Map<string, unknown>();
    for (const p of fromPath) {
        const r = asRecord(p);
        if (r && typeof r.name === 'string' && typeof r.in === 'string') byKey.set(`${r.in}:${r.name}`, p);
    }
    for (const p of fromOp) {
        const r = asRecord(p);
        if (r && typeof r.name === 'string' && typeof r.in === 'string') byKey.set(`${r.in}:${r.name}`, p);
    }
    return [...byKey.values()];
}

const LOCATIONS: ParamLocation[] = ['path', 'query', 'header', 'cookie'];

// Build the request model for one operation, or null if the operation is not
// found in the document (shouldn't happen for a selection made from the tree).
export function buildRequestModel(
    document: unknown,
    operation: EndpointOperation,
): RequestModel | null {
    const doc = asRecord(document);
    const paths = doc && asRecord(doc.paths);
    const pathItem = paths && asRecord(paths[operation.path]);
    if (!pathItem) return null;
    const op = asRecord(pathItem[operation.method]);
    if (!op) return null;

    const params: RequestParam[] = [];
    for (const raw of mergeParameters(pathItem, op)) {
        const p = asRecord(raw);
        if (!p || typeof p.name !== 'string' || typeof p.in !== 'string') continue;
        if (!LOCATIONS.includes(p.in as ParamLocation)) continue;
        params.push({
            name: p.name,
            location: p.in as ParamLocation,
            required: p.required === true || p.in === 'path', // path params are always required
            description: typeof p.description === 'string' ? p.description : undefined,
            hints: readHints(p.schema, p.example),
        });
    }

    let body: RequestBodyModel | undefined;
    const requestBody = asRecord(op.requestBody);
    const content = requestBody && asRecord(requestBody.content);
    if (content) {
        const mediaTypes = Object.keys(content);
        if (mediaTypes.length) {
            const preferred =
                mediaTypes.find((m) => m.includes('json')) ?? mediaTypes[0];
            const media = asRecord(content[preferred]);
            body = {
                required: requestBody?.required === true,
                mediaTypes,
                schema: media?.schema,
                example: media && 'example' in media ? media.example : undefined,
                description:
                    requestBody && typeof requestBody.description === 'string'
                        ? requestBody.description
                        : undefined,
            };
        }
    }

    return { method: operation.method, path: operation.path, params, body };
}

// A starter request body as pretty JSON: the spec's example if it has one,
// otherwise a skeleton built from the schema's properties so the user has
// something to edit rather than a blank box. Returns '' when nothing useful can
// be derived.
export function starterBody(body: RequestBodyModel | undefined): string {
    if (!body) return '';
    if (body.example !== undefined) {
        try {
            return JSON.stringify(body.example, null, 2);
        } catch {
            return '';
        }
    }
    const schema = asRecord(body.schema);
    if (!schema) return '';
    if ('example' in schema && schema.example !== undefined) {
        try {
            return JSON.stringify(schema.example, null, 2);
        } catch {
            /* fall through */
        }
    }
    const skeleton = skeletonFor(schema, 0);
    return skeleton === undefined ? '' : safeStringify(skeleton);
}

function safeStringify(value: unknown): string {
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return '';
    }
}

// Best-effort placeholder value for a schema. Depth-capped so a recursive or
// deeply nested schema can't spin. Not a validator — just a helpful seed.
function skeletonFor(schemaRaw: unknown, depth: number): unknown {
    const schema = asRecord(schemaRaw);
    if (!schema || depth > 4) return null;
    if ('default' in schema) return schema.default;
    if ('example' in schema) return schema.example;
    const type = typeof schema.type === 'string' ? schema.type : Array.isArray(schema.type) ? schema.type[0] : undefined;
    if (type === 'object' || asRecord(schema.properties)) {
        const props = asRecord(schema.properties) ?? {};
        const out: Record<string, unknown> = {};
        for (const [key, propSchema] of Object.entries(props)) out[key] = skeletonFor(propSchema, depth + 1);
        return out;
    }
    if (type === 'array') return [skeletonFor(schema.items, depth + 1)];
    if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
    switch (type) {
        case 'string':
            return '';
        case 'integer':
        case 'number':
            return 0;
        case 'boolean':
            return false;
        default:
            return null;
    }
}

// Order params for display: path first (they shape the URL), then query, then
// header, then cookie; required before optional within each group.
export function sortParams(params: RequestParam[]): RequestParam[] {
    const rank: Record<ParamLocation, number> = { path: 0, query: 1, header: 2, cookie: 3 };
    return [...params].sort(
        (a, b) =>
            rank[a.location] - rank[b.location] ||
            Number(b.required) - Number(a.required) ||
            a.name.localeCompare(b.name),
    );
}
