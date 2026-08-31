// Downloading and caching the full FSM business-class list (task 1h). The whole
// list (~4,940 entries) comes back in a single ~740 KB request, so we fetch it
// once and persist it as a plain workspace file. With it cached, the picker
// searches/ranks client-side — instant, and an exact match can always be
// surfaced first (no server round-trip per keystroke).
//
// Isolation note (D4): its own tiny fs accessor mirroring workspace.ts's
// Tauri/web pattern, so the module touches no shared upstream file.

import { isTauri } from '../../../tauri-dialog';
import { isWebBackend, webFs } from '../../../web-fs';
import { listBusinessClasses, type BusinessClass } from './discovery';
import type { IonApiConfig } from './ionapi';

export interface ClassCache {
    schemaVersion: 1;
    tenant: string;
    fetchedAt: string;
    count: number;
    classes: BusinessClass[];
}

export function cacheAvailable(): boolean {
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
function cacheFile(workspacePath: string, tenant: string): string {
    return joinPath(workspacePath, ...CACHE_DIR, `${tenant || 'default'}-classes.json`);
}

// Fetch every business class in one shot (pageSize covers the whole set).
export async function fetchAllBusinessClasses(
    config: IonApiConfig,
    accessToken: string,
    workspacePath: string | null,
): Promise<{ ok: true; classes: BusinessClass[] } | { ok: false; error: string }> {
    const res = await listBusinessClasses(
        config,
        accessToken,
        { page: 1, pageSize: 10000 },
        workspacePath,
    );
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, classes: res.page.items };
}

export async function loadCachedClasses(
    workspacePath: string,
    tenant: string,
): Promise<ClassCache | null> {
    try {
        const { exists, readTextFile } = await fs();
        const file = cacheFile(workspacePath, tenant);
        if (!(await exists(file))) return null;
        const parsed = JSON.parse(await readTextFile(file)) as ClassCache;
        return Array.isArray(parsed.classes) ? parsed : null;
    } catch {
        return null;
    }
}

export async function saveCachedClasses(
    workspacePath: string,
    tenant: string,
    classes: BusinessClass[],
    fetchedAt: string,
): Promise<void> {
    const { exists, mkdir, writeTextFile } = await fs();
    const dir = joinPath(workspacePath, ...CACHE_DIR);
    if (!(await exists(dir))) await mkdir(dir, { recursive: true });
    const payload: ClassCache = {
        schemaVersion: 1,
        tenant,
        fetchedAt,
        count: classes.length,
        classes,
    };
    await writeTextFile(cacheFile(workspacePath, tenant), JSON.stringify(payload));
}
