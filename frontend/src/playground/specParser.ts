// Frontend spec parsing (decision D2 — parsing lives in the browser, not Rust).
//
// Uses @scalar/openapi-parser, the browser-native equivalent the plan allows in
// place of @apidevtools/swagger-parser: the latter pulls Node built-ins
// (util/path) that would force shared Vite-config polyfills, violating the
// module-isolation constraint (D4). Scalar bundles clean for the browser and
// covers the same ground — Swagger 2.0 AND OpenAPI 3.x, JSON AND YAML, internal
// $ref resolution, and structured (path + message) errors.
//
// PL-6b extension point: nothing here reaches Rust. If backend spec validation
// is ever wanted, the raw text persisted by specPersistence.ts is the handoff —
// a Rust command would re-parse that text. This function stays the single
// frontend parse authority so the two never disagree silently.

import { dereference, upgrade, validate } from '@scalar/openapi-parser';
import type { ErrorObject } from '@scalar/openapi-parser';
import {
    HTTP_METHODS,
    type EndpointOperation,
    type HttpMethod,
    type ParseOutcome,
    type ParsedSpec,
    type SpecParseIssue,
    type SpecVersion,
} from './types';

// Map a Scalar ErrorObject to our issue shape, turning its JSON path array into
// a readable dotted location so a failure names *which part* broke (PL-5).
function toIssue(err: ErrorObject): SpecParseIssue {
    const location = err.path && err.path.length ? err.path.join('.') : undefined;
    return { message: err.message, location, code: err.code ? String(err.code) : undefined };
}

// Version is read straight off the document — the authoritative signal — rather
// than trusting a downstream re-detection.
function detectVersion(doc: Record<string, unknown>): SpecVersion {
    if (typeof doc.swagger === 'string' && doc.swagger.startsWith('2.')) return 'swagger-2.0';
    const oa = typeof doc.openapi === 'string' ? doc.openapi : '';
    if (oa.startsWith('3.0')) return 'openapi-3.0';
    if (oa.startsWith('3.1')) return 'openapi-3.1';
    if (oa.startsWith('3.2')) return 'openapi-3.2';
    return 'unknown';
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

// Walk the dereferenced `paths` object into a flat operation list (PL-4 feeds
// off this). Works identically for Swagger 2.0 and OpenAPI 3.x because both
// share the paths -> method -> operation shape.
function extractEndpoints(doc: Record<string, unknown>): EndpointOperation[] {
    const paths = asRecord(doc.paths);
    if (!paths) return [];
    const out: EndpointOperation[] = [];
    for (const [path, rawItem] of Object.entries(paths)) {
        const item = asRecord(rawItem);
        if (!item) continue;
        for (const method of HTTP_METHODS) {
            const op = asRecord(item[method]);
            if (!op) continue;
            const tags = Array.isArray(op.tags)
                ? op.tags.filter((t): t is string => typeof t === 'string')
                : [];
            out.push({
                id: `${method.toUpperCase()} ${path}`,
                method: method as HttpMethod,
                path,
                operationId: typeof op.operationId === 'string' ? op.operationId : undefined,
                summary: typeof op.summary === 'string' ? op.summary : undefined,
                description: typeof op.description === 'string' ? op.description : undefined,
                tags,
                deprecated: op.deprecated === true,
            });
        }
    }
    return out;
}

// Parse raw spec text (JSON or YAML) into a normalised, dereferenced spec.
// Returns a discriminated outcome: never throws for a bad spec — a parse
// failure is data (PL-5), not an exception.
export async function parseSpec(text: string): Promise<ParseOutcome> {
    const trimmed = text.trim();
    if (!trimmed) {
        return { ok: false, errors: [{ message: 'The spec is empty — nothing to parse.' }] };
    }

    // Dereference first: this parses the text (JSON or YAML) and resolves
    // internal $refs (PL-3). It is tolerant, so we lean on it for the document
    // and treat validate() purely as an advisory layer below.
    let deref: Awaited<ReturnType<typeof dereference>>;
    try {
        deref = await dereference(trimmed);
    } catch (err) {
        return {
            ok: false,
            errors: [{ message: `Could not parse the document: ${(err as Error).message}` }],
        };
    }

    const baseDoc = asRecord(deref.schema) ?? asRecord(deref.specification);
    if (!baseDoc) {
        // No document came back at all — malformed JSON/YAML. Surface the
        // parser's specific reason rather than a generic "parse failed".
        const errors = (deref.errors ?? []).map(toIssue);
        return {
            ok: false,
            errors: errors.length
                ? errors
                : [{ message: "Could not find JSON, YAML, or an OpenAPI document in the input." }],
        };
    }

    // Detect the version off the ORIGINAL (dereferenced-but-not-upgraded) doc,
    // where `swagger: '2.0'` / `securityDefinitions` still exist — this is the
    // version we surface and record as provenance.
    const version = detectVersion(baseDoc);
    const hasPaths = asRecord(baseDoc.paths) !== null;
    if (version === 'unknown' && !hasPaths) {
        return {
            ok: false,
            errors: [
                {
                    message:
                        "This is valid JSON/YAML but not an OpenAPI or Swagger document: no 'openapi' or 'swagger' version field and no 'paths' object.",
                },
            ],
        };
    }

    // Normalise to OpenAPI 3.1 so everything downstream (the request form,
    // auth detection) handles ONE shape rather than branching on version. This
    // is how Swagger 2.0 is made first-class per decision D3: `upgrade` rewrites
    // 2.0's `securityDefinitions` into `securitySchemes`, `in: body` params into
    // `requestBody`, and lifts parameter `type` into `schema` — the exact shapes
    // tasks 1c/1d consume. 3.0 documents are lifted to 3.1 too, harmlessly. The
    // human-facing `version` above is kept from the pre-upgrade doc.
    let doc = baseDoc;
    try {
        const upgraded = asRecord(upgrade(baseDoc).specification);
        if (upgraded) doc = upgraded;
    } catch {
        // If upgrade ever fails, fall back to the dereferenced original rather
        // than sinking an otherwise-parseable spec.
    }

    // Advisory validation: collect issues as warnings so an over-strict schema
    // check never blocks a real-world spec that parses fine (see task 1k). Any
    // dereference errors (e.g. an unresolved external $ref, out of scope for v1)
    // ride along here too.
    const warnings: SpecParseIssue[] = (deref.errors ?? []).map(toIssue);
    try {
        const validation = await validate(trimmed);
        if (!validation.valid && validation.errors) {
            for (const e of validation.errors) warnings.push(toIssue(e));
        }
    } catch {
        // Validation is best-effort; its failure must not sink a parseable spec.
    }

    const info = asRecord(doc.info);
    const spec: ParsedSpec = {
        version,
        title:
            info && typeof info.title === 'string' && info.title.trim()
                ? info.title
                : 'Untitled API',
        apiVersion: info && typeof info.version === 'string' ? info.version : undefined,
        endpoints: extractEndpoints(doc),
        document: doc,
        warnings,
    };
    return { ok: true, spec };
}
