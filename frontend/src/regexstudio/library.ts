// Regex Studio — saved-pattern library (DataTonic).
//
// Per-workspace persistence in localStorage, plus portable JSON export/import
// (Infor-connection style). Desktop uses the tauri dialog + fs plugins; the web
// edition falls back to a browser download / file-picker so the feature works
// everywhere.

import type { RegexMode } from './types';
import { isTauri, tauriOpenFile, tauriSavePath } from '../tauri-dialog';

export interface RegexTest {
    value: string;
    expected?: string; // optional expected outcome (feeds AI context)
}

export type PatternScope = 'workspace' | 'global';

export interface SavedPattern {
    id: string;
    name: string;
    description?: string; // short (<= 45 chars) summary
    scope: PatternScope; // 'global' = available in every workspace
    mode: RegexMode;
    pattern: string;
    replacement?: string;
    groupIndex?: number;
    groupNames?: string;
    tests?: RegexTest[];
    notes?: string;
    updatedAt: number;
}

export const DESCRIPTION_MAX = 45;

const EXPORT_VERSION = 1;
interface LibraryFile {
    kind: 'duckle.regex-library';
    version: number;
    patterns: SavedPattern[];
}

const GLOBAL_KEY = 'duckle.regexlib::__global__';
function workspaceKey(workspace?: string | null): string {
    return `duckle.regexlib::${workspace ?? 'default'}`;
}

function readKey(key: string, scope: PatternScope): SavedPattern[] {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return [];
        const parsed = JSON.parse(raw) as SavedPattern[];
        if (!Array.isArray(parsed)) return [];
        // Trust the store the entry came from for its scope.
        return parsed.map(p => ({ ...p, scope }));
    } catch {
        return [];
    }
}

// The combined library for a workspace: global patterns first, then this
// workspace's own. Each entry carries its `scope`.
export function loadLibrary(workspace?: string | null): SavedPattern[] {
    return [...readKey(GLOBAL_KEY, 'global'), ...readKey(workspaceKey(workspace), 'workspace')];
}

// Persist a combined list by splitting it back into the global and workspace
// stores according to each entry's scope.
export function saveLibrary(workspace: string | null | undefined, patterns: SavedPattern[]): void {
    try {
        const global = patterns.filter(p => p.scope === 'global');
        const ws = patterns.filter(p => p.scope !== 'global');
        localStorage.setItem(GLOBAL_KEY, JSON.stringify(global));
        localStorage.setItem(workspaceKey(workspace), JSON.stringify(ws));
    } catch {
        // Storage full / unavailable — non-fatal; the in-memory list still works.
    }
}

// A stable-ish id without Date.now()/Math.random() constraints (browser runtime,
// so both are fine here).
export function newPatternId(): string {
    return `rp_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export function upsertPattern(list: SavedPattern[], p: SavedPattern): SavedPattern[] {
    const idx = list.findIndex(x => x.id === p.id);
    if (idx >= 0) {
        const next = list.slice();
        next[idx] = p;
        return next;
    }
    return [p, ...list];
}

export function removePattern(list: SavedPattern[], id: string): SavedPattern[] {
    return list.filter(p => p.id !== id);
}

// ---- Export / import ----

export async function exportLibrary(patterns: SavedPattern[]): Promise<'ok' | 'cancelled' | string> {
    const file: LibraryFile = { kind: 'duckle.regex-library', version: EXPORT_VERSION, patterns };
    const json = JSON.stringify(file, null, 2);
    try {
        if (isTauri()) {
            const path = await tauriSavePath({
                defaultPath: 'regex-library.json',
                title: 'Export regex library',
                filters: [{ name: 'JSON', extensions: ['json'] }],
            });
            if (!path) return 'cancelled';
            const { writeTextFile } = await import('@tauri-apps/plugin-fs');
            await writeTextFile(path, json);
            return 'ok';
        }
        // Web: trigger a browser download.
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'regex-library.json';
        a.click();
        URL.revokeObjectURL(url);
        return 'ok';
    } catch (e) {
        return e instanceof Error ? e.message : String(e);
    }
}

function coerce(patterns: unknown): SavedPattern[] {
    if (!Array.isArray(patterns)) return [];
    return patterns.filter(
        (p): p is SavedPattern =>
            !!p && typeof (p as SavedPattern).pattern === 'string' && typeof (p as SavedPattern).name === 'string',
    );
}

function parseLibrary(text: string): SavedPattern[] {
    const data = JSON.parse(text) as LibraryFile | SavedPattern[];
    const patterns = Array.isArray(data) ? data : data?.patterns;
    return coerce(patterns).map(p => ({
        ...p,
        id: p.id || newPatternId(),
        scope: p.scope === 'global' ? 'global' : 'workspace',
    }));
}

// Returns the imported patterns, or null if cancelled, or throws with a message.
export async function importLibrary(): Promise<SavedPattern[] | null> {
    if (isTauri()) {
        const path = await tauriOpenFile({
            title: 'Import regex library',
            filters: [{ name: 'JSON', extensions: ['json'] }],
        });
        if (!path) return null;
        const { readTextFile } = await import('@tauri-apps/plugin-fs');
        return parseLibrary(await readTextFile(path));
    }
    // Web: programmatic file picker.
    return new Promise<SavedPattern[] | null>(resolve => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'application/json,.json';
        input.onchange = () => {
            const f = input.files?.[0];
            if (!f) return resolve(null);
            const reader = new FileReader();
            reader.onload = () => {
                try {
                    resolve(parseLibrary(String(reader.result)));
                } catch {
                    resolve([]);
                }
            };
            reader.onerror = () => resolve([]);
            reader.readAsText(f);
        };
        input.click();
    });
}
