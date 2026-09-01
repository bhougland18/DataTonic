// Saved Infor queries (task 1q): a named/described query — data area + business
// class + selected fields + filter (+ optional lpl / limit) — persisted as a
// plain workspace file so it survives reloads, and exportable as a single JSON
// file for sharing. Scoped per tenant; the UI filters the list by data area.
//
// Isolation note (D4): its own tiny fs accessor mirroring classCache.ts, so the
// module touches no shared upstream file.

import { isTauri } from '../../../tauri-dialog';
import { isWebBackend, webFs } from '../../../web-fs';
import type { DataAreaId } from './inforApi';

export interface SavedQueryFilter {
    field: string;
    value: string;
}

export interface SavedQuery {
    id: string;
    // Description doubles as the display label (the list shows business class +
    // description + column count); no separate name.
    description: string;
    dataArea: DataAreaId;
    businessClass: string;
    fields: string[];
    filter: SavedQueryFilter[];
    lplFilter?: string;
    // Omitted when the user turned the limit off (server default / all rows).
    limit?: number;
    savedAt: string;
}

export function savedQueriesAvailable(): boolean {
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
const CACHE_DIR = ['api-cache', 'infor'];
function queriesFile(workspacePath: string, tenant: string): string {
    return joinPath(workspacePath, ...CACHE_DIR, `${tenant || 'default'}-queries.json`);
}

export async function loadSavedQueries(
    workspacePath: string,
    tenant: string,
): Promise<SavedQuery[]> {
    try {
        const { exists, readTextFile } = await fs();
        const file = queriesFile(workspacePath, tenant);
        if (!(await exists(file))) return [];
        const parsed = JSON.parse(await readTextFile(file));
        return Array.isArray(parsed) ? (parsed as SavedQuery[]) : [];
    } catch {
        return [];
    }
}

export async function saveSavedQueries(
    workspacePath: string,
    tenant: string,
    list: SavedQuery[],
): Promise<void> {
    const { exists, mkdir, writeTextFile } = await fs();
    const dir = joinPath(workspacePath, ...CACHE_DIR);
    if (!(await exists(dir))) await mkdir(dir, { recursive: true });
    await writeTextFile(queriesFile(workspacePath, tenant), JSON.stringify(list, null, 2));
}

// Export a single query as a JSON file the user can share; the importer accepts
// the same shape.
export function exportQueryFile(q: SavedQuery): void {
    const blob = new Blob([JSON.stringify(q, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `infor-${q.dataArea}-${q.businessClass}-${q.description}`
        .replace(/[^\w.-]+/g, '_')
        .slice(0, 80) + '.json';
    a.click();
    URL.revokeObjectURL(url);
}

// Parse an imported query file, assigning a fresh id + savedAt so it never
// collides with an existing one. Returns null if the shape isn't a query.
export function parseImportedQuery(text: string): SavedQuery | null {
    try {
        const o = JSON.parse(text) as Partial<SavedQuery>;
        if (
            o &&
            typeof o.businessClass === 'string' &&
            o.businessClass &&
            Array.isArray(o.fields)
        ) {
            return {
                id: crypto.randomUUID(),
                description: typeof o.description === 'string' ? o.description : '',
                dataArea: o.dataArea === 'HCM' ? 'HCM' : 'FSM',
                businessClass: o.businessClass,
                fields: o.fields.filter((f): f is string => typeof f === 'string'),
                filter: Array.isArray(o.filter)
                    ? o.filter.filter(
                          (c): c is SavedQueryFilter =>
                              !!c && typeof c.field === 'string' && typeof c.value === 'string',
                      )
                    : [],
                lplFilter: typeof o.lplFilter === 'string' ? o.lplFilter : undefined,
                limit: typeof o.limit === 'number' ? o.limit : undefined,
                savedAt: new Date().toISOString(),
            };
        }
    } catch {
        /* not a query file */
    }
    return null;
}
