// Field type detection for the Infor source node.
//
// Infor's `_generic` list returns every cell as a JSON string, and the class
// swagger declares every property as `type: string` — so neither tells us what a
// column really holds. The authoritative source is the Landmark field spec:
//   GET {restBase}/classes/{Class}/fields/{FieldName}
// which returns type flags (string/number/decimal/date/boolean/...).
//
// Why not sniff values: `Item` legitimately reports `string` even though item
// codes look numeric. Guessing "int" from digits would strip leading zeros and
// silently corrupt item codes, GL accounts and cost centres. The field spec is
// the only safe source.
//
// `GET classes/{Class}/fields` returns names ONLY, so lookup is per field. Item
// has 1,806 fields, so we resolve just the SELECTED ones (~15) and keep them in
// a library: types are effectively static, so the second Apply costs nothing.
//
// Isolation note (ARCH-1): own tiny fs accessor mirroring classCache.ts, so this
// module touches no shared upstream file.

import type { DataType } from '../../../pipeline-types';
import { isTauri } from '../../../tauri-dialog';
import { isWebBackend, webFs } from '../../../web-fs';
import { sendRequest } from '../../sendClient';
import { restBase, type DataAreaId } from './inforApi';
import type { IonApiConfig } from './ionapi';

// Infor date fields carry YYYYMMDD with no separators, which DuckDB's DATE cast
// will not parse. The engine applies a per-column strptime format (Column.format,
// issue #10), so we declare one alongside the type.
export const INFOR_DATE_FORMAT = '%Y%m%d';

export type TypeSource = 'api' | 'user' | 'seed';

export interface FieldTypeEntry {
    type: DataType;
    /** strptime format for date/timestamp columns (see INFOR_DATE_FORMAT). */
    format?: string;
    source: TypeSource;
    /**
     * Negative cache: the spec could not be read (404 / 403 / network). Resolves
     * as `string` like any unknown, but is recorded so a broken field does not
     * re-request on every Apply — and so export can leave it out rather than
     * publish a guess as authoritative.
     */
    unresolved?: boolean;
}

/** Entries keyed `"{Class}/{Field}"` — the file itself is per (tenant, dataArea). */
export type FieldTypeEntries = Record<string, FieldTypeEntry>;

export interface FieldTypeFile {
    schemaVersion: 1;
    tenant: string;
    dataArea: DataAreaId;
    kind: 'cache' | 'overrides';
    updatedAt: string;
    /** Landmark/FSM version the entries were learned from, when known. */
    landmarkVersion?: string;
    entries: FieldTypeEntries;
}

export function entryKey(businessClass: string, field: string): string {
    return `${businessClass}/${field}`;
}

// ---------------------------------------------------------------- file access

export function libraryAvailable(): boolean {
    return isTauri() || isWebBackend();
}

type FsLib = typeof import('@tauri-apps/plugin-fs');
async function fs(): Promise<FsLib> {
    if (!isTauri()) return webFs as unknown as FsLib;
    return await import('@tauri-apps/plugin-fs');
}
function joinPath(dir: string, ...parts: string[]): string {
    const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
    return [dir.replace(/[/\\]+$/, ''), ...parts].join(sep);
}

// Two files, deliberately separate:
//  - cache lives under api-cache/ and is SAFE TO DELETE (re-fetched on demand)
//  - overrides are hand-curated user data and must survive clearing the cache
// Mixing them would mean clearing a cache destroys curation, and it lets the
// cache be gitignored while overrides are committed with the workspace.
const CACHE_DIR = ['api-cache', 'infor'];
const OVERRIDE_DIR = ['infor'];

function cacheFile(workspacePath: string, tenant: string, dataArea: DataAreaId): string {
    return joinPath(workspacePath, ...CACHE_DIR, `${tenant || 'default'}-${dataArea}-fieldtypes.json`);
}
function overrideFile(workspacePath: string, tenant: string, dataArea: DataAreaId): string {
    return joinPath(
        workspacePath,
        ...OVERRIDE_DIR,
        `${tenant || 'default'}-${dataArea}-field-overrides.json`,
    );
}

async function readFile(path: string): Promise<FieldTypeFile | null> {
    try {
        const { exists, readTextFile } = await fs();
        if (!(await exists(path))) return null;
        const parsed = JSON.parse(await readTextFile(path)) as FieldTypeFile;
        return parsed && typeof parsed.entries === 'object' && parsed.entries ? parsed : null;
    } catch {
        return null;
    }
}

async function writeFile(path: string, dirParts: string[], workspacePath: string, file: FieldTypeFile): Promise<void> {
    const { exists, mkdir, writeTextFile } = await fs();
    const dir = joinPath(workspacePath, ...dirParts);
    if (!(await exists(dir))) await mkdir(dir, { recursive: true });
    await writeTextFile(path, JSON.stringify(file, null, 2));
}

export async function loadCache(
    workspacePath: string,
    tenant: string,
    dataArea: DataAreaId,
): Promise<FieldTypeEntries> {
    return (await readFile(cacheFile(workspacePath, tenant, dataArea)))?.entries ?? {};
}

export async function loadOverrides(
    workspacePath: string,
    tenant: string,
    dataArea: DataAreaId,
): Promise<FieldTypeEntries> {
    return (await readFile(overrideFile(workspacePath, tenant, dataArea)))?.entries ?? {};
}

async function saveEntries(
    workspacePath: string,
    tenant: string,
    dataArea: DataAreaId,
    kind: 'cache' | 'overrides',
    entries: FieldTypeEntries,
): Promise<void> {
    const path =
        kind === 'cache'
            ? cacheFile(workspacePath, tenant, dataArea)
            : overrideFile(workspacePath, tenant, dataArea);
    const dirParts = kind === 'cache' ? CACHE_DIR : OVERRIDE_DIR;
    await writeFile(path, dirParts, workspacePath, {
        schemaVersion: 1,
        tenant,
        dataArea,
        kind,
        updatedAt: new Date().toISOString(),
        entries,
    });
}

/** Merge newly learned entries into the cache (never touches overrides). */
export async function mergeIntoCache(
    workspacePath: string,
    tenant: string,
    dataArea: DataAreaId,
    learned: FieldTypeEntries,
): Promise<void> {
    if (!Object.keys(learned).length) return;
    const existing = await loadCache(workspacePath, tenant, dataArea);
    await saveEntries(workspacePath, tenant, dataArea, 'cache', { ...existing, ...learned });
}

/**
 * Record a human correction. Overrides win over anything the API said, and are
 * the ONLY durable way to change a type — a node's Schema tab edit is local to
 * that node and is rebuilt on the next Apply.
 */
export async function setOverride(
    workspacePath: string,
    tenant: string,
    dataArea: DataAreaId,
    businessClass: string,
    field: string,
    type: DataType,
): Promise<FieldTypeEntries> {
    const existing = await loadOverrides(workspacePath, tenant, dataArea);
    const entry: FieldTypeEntry = { type, source: 'user' };
    if (type === 'date' || type === 'timestamp') entry.format = INFOR_DATE_FORMAT;
    const next = { ...existing, [entryKey(businessClass, field)]: entry };
    await saveEntries(workspacePath, tenant, dataArea, 'overrides', next);
    return next;
}

export async function clearOverride(
    workspacePath: string,
    tenant: string,
    dataArea: DataAreaId,
    businessClass: string,
    field: string,
): Promise<FieldTypeEntries> {
    const existing = await loadOverrides(workspacePath, tenant, dataArea);
    const next = { ...existing };
    delete next[entryKey(businessClass, field)];
    await saveEntries(workspacePath, tenant, dataArea, 'overrides', next);
    return next;
}

// -------------------------------------------------------- bulk import / export
//
// Purpose: a new user on a fresh tenant shouldn't pay a per-field "catch-up"
// period against Infor's API for standard Landmark classes. One person resolves
// them, exports, everyone else imports.
//
// Whole-library only, no per-entry export (unlike saved queries): a single
// field's type is not worth moving around, and the value here is the bulk.

export interface FieldTypeBundle {
    kind: 'duckle.infor.fieldTypes';
    schemaVersion: 1;
    tenant: string;
    dataArea: DataAreaId;
    exportedAt: string;
    landmarkVersion?: string;
    count: number;
    entries: FieldTypeEntries;
}

export interface ImportReport {
    added: number;
    /** Already known locally — gap-fill means what we have wins. */
    skipped: number;
    /** Differed from a local human override; left alone deliberately. */
    conflicts: number;
    /** Set when the bundle came from a different tenant (still importable). */
    tenantMismatch?: { bundle: string; local: string };
    /** Set when the bundle is for the other data area (nothing imported). */
    areaMismatch?: { bundle: DataAreaId; local: DataAreaId };
}

/**
 * Everything this workspace knows for (tenant, dataArea) — cache *and*
 * overrides, with overrides winning. `unresolved` negatives are dropped: they
 * record a local failure, and publishing them as authoritative would spread a
 * guess to everyone who imports.
 */
export async function buildBundle(
    workspacePath: string,
    tenant: string,
    dataArea: DataAreaId,
): Promise<FieldTypeBundle> {
    const cached = await loadCache(workspacePath, tenant, dataArea);
    const overrides = await loadOverrides(workspacePath, tenant, dataArea);
    const merged: FieldTypeEntries = {};
    for (const [k, v] of Object.entries({ ...cached, ...overrides })) {
        if (!v.unresolved) merged[k] = v;
    }
    return {
        kind: 'duckle.infor.fieldTypes',
        schemaVersion: 1,
        tenant,
        dataArea,
        exportedAt: new Date().toISOString(),
        count: Object.keys(merged).length,
        entries: merged,
    };
}

export function downloadBundle(bundle: FieldTypeBundle): void {
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `infor-fieldtypes-${bundle.tenant}-${bundle.dataArea}-${bundle.count}`
        .replace(/[^\w.-]+/g, '_')
        .slice(0, 80) + '.json';
    a.click();
    URL.revokeObjectURL(url);
}

export function parseBundle(text: string): FieldTypeBundle | null {
    try {
        const o = JSON.parse(text) as Partial<FieldTypeBundle>;
        if (o?.kind !== 'duckle.infor.fieldTypes') return null;
        if (!o.entries || typeof o.entries !== 'object') return null;
        return {
            kind: 'duckle.infor.fieldTypes',
            schemaVersion: 1,
            tenant: typeof o.tenant === 'string' ? o.tenant : '',
            dataArea: o.dataArea === 'HCM' ? 'HCM' : 'FSM',
            exportedAt: typeof o.exportedAt === 'string' ? o.exportedAt : '',
            landmarkVersion: typeof o.landmarkVersion === 'string' ? o.landmarkVersion : undefined,
            count: Object.keys(o.entries).length,
            entries: o.entries as FieldTypeEntries,
        };
    } catch {
        return null;
    }
}

/**
 * Merge a bundle in, **filling gaps only**. An import can add knowledge but
 * never silently change a type this workspace already decided — least of all a
 * human override. Entries are filed by their own provenance: API-learned ones
 * go to the (disposable) cache, curated ones to the durable override file, so
 * importing doesn't launder someone's guess into your authoritative data.
 */
export async function importBundle(
    workspacePath: string,
    tenant: string,
    dataArea: DataAreaId,
    bundle: FieldTypeBundle,
): Promise<ImportReport> {
    const report: ImportReport = { added: 0, skipped: 0, conflicts: 0 };
    if (bundle.dataArea !== dataArea) {
        report.areaMismatch = { bundle: bundle.dataArea, local: dataArea };
        return report;
    }
    if (bundle.tenant && bundle.tenant !== tenant) {
        // Standard Landmark classes are shared, so this is usually fine —
        // but tenant customisations (UserField1..5, custom classes) are not,
        // so it's surfaced rather than swallowed.
        report.tenantMismatch = { bundle: bundle.tenant, local: tenant };
    }

    const cached = await loadCache(workspacePath, tenant, dataArea);
    const overrides = await loadOverrides(workspacePath, tenant, dataArea);
    const nextCache = { ...cached };
    const nextOverrides = { ...overrides };

    for (const [key, entry] of Object.entries(bundle.entries)) {
        if (!entry || typeof entry.type !== 'string') continue;
        const localOverride = overrides[key];
        if (localOverride) {
            if (localOverride.type !== entry.type) report.conflicts += 1;
            else report.skipped += 1;
            continue;
        }
        if (cached[key] && !cached[key].unresolved) {
            report.skipped += 1;
            continue;
        }
        if (entry.source === 'user' || entry.source === 'seed') {
            nextOverrides[key] = { ...entry, source: entry.source };
        } else {
            nextCache[key] = { ...entry, source: 'api' };
        }
        report.added += 1;
    }

    await saveEntries(workspacePath, tenant, dataArea, 'cache', nextCache);
    await saveEntries(workspacePath, tenant, dataArea, 'overrides', nextOverrides);
    return report;
}

/** Flatten the library for display: one row per known (class, field). */
export interface LibraryRow {
    key: string;
    businessClass: string;
    field: string;
    entry: FieldTypeEntry;
}

export async function loadLibrary(
    workspacePath: string,
    tenant: string,
    dataArea: DataAreaId,
): Promise<LibraryRow[]> {
    const cached = await loadCache(workspacePath, tenant, dataArea);
    const overrides = await loadOverrides(workspacePath, tenant, dataArea);
    return Object.entries({ ...cached, ...overrides })
        .map(([key, entry]) => {
            const slash = key.indexOf('/');
            return {
                key,
                businessClass: slash < 0 ? key : key.slice(0, slash),
                field: slash < 0 ? '' : key.slice(slash + 1),
                entry,
            };
        })
        .sort((a, b) => a.key.localeCompare(b.key));
}

// ------------------------------------------------------- FieldSpec -> DataType

function flag(spec: Record<string, unknown>, name: string): boolean {
    return spec[name] === true || spec[name] === 'true';
}

/**
 * Map a Landmark FieldSpec's flags onto a DataType.
 *
 * Checked most-specific first: a DateYMDField is a date even though a spec may
 * also carry string-ish flags. `string` is the fallback, which is the safe
 * direction — a wrongly-stringed number is inconvenient, a wrongly-numbered
 * code is data loss.
 */
export function fieldSpecToFieldType(spec: Record<string, unknown>): FieldTypeEntry {
    const cls = typeof spec.className === 'string' ? spec.className : '';

    if (flag(spec, 'date') || flag(spec, 'dateOnly') || /DateYMD|DateField/i.test(cls)) {
        return { type: 'date', format: INFOR_DATE_FORMAT, source: 'api' };
    }
    if (flag(spec, 'timeStamp') || /TimeStamp/i.test(cls)) {
        return { type: 'timestamp', source: 'api' };
    }
    if (flag(spec, 'time')) return { type: 'time', source: 'api' };
    if (flag(spec, 'boolean')) return { type: 'bool', source: 'api' };

    if (flag(spec, 'number') || /BigDecimal|Numeric|Integer|Long/i.test(cls)) {
        // Decimal -> float64, NOT the `decimal` DataType: that maps to a bare
        // DuckDB DECIMAL (= DECIMAL(18,3)), which would TRUNCATE a field like
        // UOMConversion (decimalSize 7). There is no parameterised decimal in
        // DataType, so DOUBLE is the widest faithful option.
        if (flag(spec, 'decimal') || /BigDecimal/i.test(cls)) {
            return { type: 'float64', source: 'api' };
        }
        return { type: 'int64', source: 'api' };
    }

    return { type: 'string', source: 'api' };
}

/** The FieldSpec endpoint returns either the object or a one-element array. */
function firstSpec(body: string): Record<string, unknown> | null {
    try {
        const parsed = JSON.parse(body) as unknown;
        const obj = Array.isArray(parsed) ? parsed[0] : parsed;
        return obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : null;
    } catch {
        return null;
    }
}

export async function fetchFieldType(
    config: IonApiConfig,
    accessToken: string,
    businessClass: string,
    field: string,
    workspacePath: string | null,
    dataArea: DataAreaId,
): Promise<FieldTypeEntry> {
    const unresolved: FieldTypeEntry = { type: 'string', source: 'api', unresolved: true };
    const url = `${restBase(config, dataArea)}/classes/${encodeURIComponent(
        businessClass,
    )}/fields/${encodeURIComponent(field)}`;

    const outcome = await sendRequest(
        { url, method: 'GET', authType: 'bearer', authToken: accessToken },
        workspacePath,
    );
    if (outcome.kind !== 'response') return unresolved;
    const { status, body } = { status: outcome.response.status, body: outcome.response.body };
    if (status < 200 || status >= 300) return unresolved;

    const spec = firstSpec(body);
    if (!spec) return unresolved;
    // A Landmark exception comes back 200 with an `exception` envelope.
    if (spec.exception) return unresolved;
    return fieldSpecToFieldType(spec);
}

// ------------------------------------------------------------------- resolving

export interface ResolvedTypes {
    types: Record<string, DataType>;
    formats: Record<string, string>;
    /** Per-field provenance, for showing where a type came from in the picker. */
    entries: FieldTypeEntries;
    /** How many fields needed a live FieldSpec call (0 once the library is warm). */
    fetched: number;
}

// Small concurrency pool: ~15 selected fields shouldn't be 15 serial round
// trips, but nor should we open 200 sockets on a big selection.
const CONCURRENCY = 6;

/**
 * Resolve types for the SELECTED fields, first hit wins:
 *   1. user override  2. cached API result  3. live FieldSpec  4. string
 * Newly learned entries (including negatives) are merged into the cache.
 */
export async function resolveFieldTypes(
    config: IonApiConfig,
    accessToken: string,
    businessClass: string,
    fields: string[],
    workspacePath: string | null,
    dataArea: DataAreaId,
): Promise<ResolvedTypes> {
    const out: ResolvedTypes = { types: {}, formats: {}, entries: {}, fetched: 0 };
    if (!fields.length) return out;

    const canPersist = Boolean(workspacePath) && libraryAvailable();
    const overrides = canPersist ? await loadOverrides(workspacePath!, config.tenant, dataArea) : {};
    const cached = canPersist ? await loadCache(workspacePath!, config.tenant, dataArea) : {};

    const learned: FieldTypeEntries = {};
    const needFetch: string[] = [];

    for (const f of fields) {
        const key = entryKey(businessClass, f);
        const hit = overrides[key] ?? cached[key];
        if (hit) out.entries[f] = hit;
        else needFetch.push(f);
    }

    for (let i = 0; i < needFetch.length; i += CONCURRENCY) {
        const batch = needFetch.slice(i, i + CONCURRENCY);
        const results = await Promise.all(
            batch.map((f) =>
                fetchFieldType(config, accessToken, businessClass, f, workspacePath, dataArea).then(
                    (e) => [f, e] as const,
                ),
            ),
        );
        for (const [f, entry] of results) {
            out.entries[f] = entry;
            learned[entryKey(businessClass, f)] = entry;
            out.fetched += 1;
        }
    }

    for (const f of fields) {
        const entry = out.entries[f] ?? { type: 'string' as DataType, source: 'api' as TypeSource };
        out.types[f] = entry.type;
        if (entry.format) out.formats[f] = entry.format;
    }

    if (canPersist) {
        // Best-effort: a failed cache write must not fail the Apply.
        await mergeIntoCache(workspacePath!, config.tenant, dataArea, learned).catch(() => {});
    }
    return out;
}
