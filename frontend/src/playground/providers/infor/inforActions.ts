// Parse an Infor business-class swagger (the per-class OpenAPI doc reachable via
// the class's `swaggerEndpoint`, e.g. the Item spec) into its **POST actions**
// and each action's field set. This is the write-side counterpart to the read
// path's field discovery: the Infor upload sink (snk.infor) shows only POST
// actions, and the selected action's request schema decides which fields the
// mapper offers.
//
// Confirmed against the live Item spec (2026-09-03):
//   - Named action:  POST /classes/{Class}/actions/{Action}    (e.g. .../Create)
//   - Bulk upload:   POST /classes/{Class}/actions/{action}/batch  ("Action Batch Service")
//   - An action's fields come from its POST requestBody schema, often
//     `oneOf: [ <minimumFields>, <allFields> ]` (Create: 4 required, 138 total).
//
// Pure and dependency-free so it is trivially unit-testable and carries no merge
// surface against upstream.

export interface InforActionField {
    name: string;
    /** Marked with * in the mapper; from the action schema's `required` list. */
    required: boolean;
    /** JSON type hint (usually "string" for Landmark); best-effort. */
    type: string;
}

export interface InforAction {
    /** Action name as it appears after `/actions/` (e.g. "Create"). */
    name: string;
    /** The class this action belongs to (segment after `/classes/`). */
    businessClass: string;
    /** True when the generic `/actions/{action}/batch` POST exists for this class. */
    batchSupported: boolean;
    /** Field set the action accepts (superset when the schema is a oneOf). */
    fields: InforActionField[];
}

type Json = Record<string, unknown>;

const MAX_DEREF = 8;

function resolveRef(doc: Json, ref: string): Json | null {
    // Only local refs ("#/components/schemas/Foo"); external refs are unsupported.
    if (!ref.startsWith('#/')) return null;
    let cur: unknown = doc;
    for (const part of ref.slice(2).split('/')) {
        if (!cur || typeof cur !== 'object') return null;
        cur = (cur as Json)[decodeURIComponent(part.replace(/~1/g, '/').replace(/~0/g, '~'))];
    }
    return cur && typeof cur === 'object' ? (cur as Json) : null;
}

function deref(doc: Json, schema: unknown): Json | null {
    let s = schema as Json | null;
    let guard = 0;
    while (s && typeof s === 'object' && typeof s.$ref === 'string' && guard++ < MAX_DEREF) {
        s = resolveRef(doc, s.$ref);
    }
    return s && typeof s === 'object' ? s : null;
}

// Collect {name, required, type} from an object schema, following a oneOf/anyOf
// by preferring the variant with the most properties (the "all fields" superset)
// while keeping any variant's required flags.
function fieldsOf(doc: Json, schema: unknown): InforActionField[] {
    const s = deref(doc, schema);
    if (!s) return [];

    const variants = (s.oneOf ?? s.anyOf) as unknown[] | undefined;
    if (Array.isArray(variants) && variants.length) {
        const resolved = variants.map(v => deref(doc, v)).filter((v): v is Json => !!v);
        // Union of required across variants (a field required by the minimum set
        // is required overall); properties from the richest variant.
        const requiredNames = new Set<string>();
        let richest: Json | null = null;
        let richestCount = -1;
        for (const v of resolved) {
            for (const r of (v.required as string[]) ?? []) requiredNames.add(r);
            const count = v.properties ? Object.keys(v.properties as Json).length : 0;
            if (count > richestCount) {
                richestCount = count;
                richest = v;
            }
        }
        if (!richest) return [];
        return propsToFields(richest, requiredNames);
    }

    return propsToFields(s, new Set((s.required as string[]) ?? []));
}

function propsToFields(schema: Json, required: Set<string>): InforActionField[] {
    const props = schema.properties as Json | undefined;
    if (!props) return [];
    return Object.entries(props).map(([name, raw]) => {
        const p = (raw && typeof raw === 'object' ? raw : {}) as Json;
        const type = typeof p.type === 'string' ? p.type : p.$ref ? 'ref' : 'string';
        return { name, required: required.has(name), type };
    });
}

// Match "/classes/<Class>/actions/<Action>" — a *named* action, excluding the
// templated "{action}" and the "/batch" suffix (those are the generic services).
const NAMED_ACTION_RE = /^\/classes\/([^/]+)\/actions\/([^/{}]+)$/;
const BATCH_RE = /^\/classes\/([^/]+)\/actions\/\{action\}\/batch$/;

export interface ParsedActions {
    businessClass: string | null;
    actions: InforAction[];
    /** True when the class exposes the generic batch upload service. */
    batchSupported: boolean;
}

// Parse a fetched class swagger into its POST actions + fields. Actions are
// returned sorted by name; only actions with a POST single-action endpoint are
// included (the write actions the uploader can drive). `batchSupported` reflects
// the presence of the `/actions/{action}/batch` service that the sink uploads to.
export function parsePostActions(swagger: unknown): ParsedActions {
    const doc = (swagger && typeof swagger === 'object' ? swagger : {}) as Json;
    const paths = (doc.paths && typeof doc.paths === 'object' ? doc.paths : {}) as Json;

    let batchSupported = false;
    let businessClass: string | null = null;
    // The authoritative action list = the batch service's {action} path-param enum.
    let actionEnum: string[] = [];
    // action name -> its fields, taken from that action's dedicated endpoint's
    // request body — of ANY method (Create/RequestNewItem are POST, but Update,
    // ChangeItemStatus, SetItemToNotAvailableForUse etc. are PUT).
    const fieldsByAction = new Map<string, InforActionField[]>();

    for (const [path, rawItem] of Object.entries(paths)) {
        const item = (rawItem && typeof rawItem === 'object' ? rawItem : {}) as Json;

        const batchM = BATCH_RE.exec(path);
        if (batchM) {
            const post = item.post as Json | undefined;
            if (post) {
                batchSupported = true;
                businessClass ??= batchM[1];
                const params = Array.isArray(post.parameters) ? (post.parameters as Json[]) : [];
                const actionParam = params.find(
                    (p) => p && typeof p === 'object' && (p as Json).name === 'action',
                ) as Json | undefined;
                const sch = actionParam ? deref(doc, actionParam.schema ?? actionParam) : null;
                const en: unknown = sch?.enum ?? actionParam?.enum;
                if (Array.isArray(en)) {
                    actionEnum = en.filter((x): x is string => typeof x === 'string');
                }
            }
            continue;
        }

        const m = NAMED_ACTION_RE.exec(path);
        if (!m) continue;
        businessClass ??= m[1];
        const name = m[2];
        if (fieldsByAction.has(name)) continue;
        for (const method of Object.keys(item)) {
            const op = item[method] as Json | undefined;
            const schema = (((op?.requestBody as Json | undefined)?.content as Json | undefined)?.[
                'application/json'
            ] as Json | undefined)?.schema;
            if (schema) {
                fieldsByAction.set(name, fieldsOf(doc, schema));
                break;
            }
        }
    }

    // The batch service's `_fields` accepts any writable field, so an action's
    // OWN schema is not the whole story: e.g. Update declares just the
    // Item/ItemGroup key, which IDENTIFIES the record - you still map the fields
    // you are changing. So offer the class's full writable field set (the richest
    // action schema, i.e. Create's allFields) for every action, flagging THIS
    // action's own required fields as the key(s), plus any action-specific fields
    // the class set lacks.
    let classFields: InforActionField[] = [];
    for (const f of fieldsByAction.values()) {
        if (f.length > classFields.length) classFields = f;
    }
    const classFieldNames = new Set(classFields.map((f) => f.name));

    const names = actionEnum.length ? actionEnum : [...fieldsByAction.keys()];
    const actions: InforAction[] = names.map((name) => {
        const own = fieldsByAction.get(name) ?? [];
        const requiredNames = new Set(own.filter((f) => f.required).map((f) => f.name));
        const merged: InforActionField[] = classFields.map((f) => ({
            ...f,
            required: requiredNames.has(f.name),
        }));
        for (const f of own) {
            if (!classFieldNames.has(f.name)) merged.push({ ...f });
        }
        // Required keys first, then alphabetical - map the identifier(s) before
        // the fields you are setting.
        merged.sort(
            (a, b) => Number(b.required) - Number(a.required) || a.name.localeCompare(b.name),
        );
        return { name, businessClass: businessClass ?? '', batchSupported, fields: merged };
    });
    actions.sort((x, y) => x.name.localeCompare(y.name));
    return { businessClass, actions, batchSupported };
}
