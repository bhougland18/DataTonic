// The saved-join library — reusable relationships, per workspace and global.
//
// Modelled on `regexstudio/library.ts`, which already solved this shape: two
// scopes, a portable versioned JSON export, tauri dialogs with a web fallback.
// Where it differs is WHERE each scope lives, and that difference is deliberate:
//
//   * workspace joins go in the workspace (`blocks/join-library.json`), so an
//     engagement's join knowledge is committed alongside the pipelines it
//     describes and travels with the repo.
//   * global joins go in localStorage, because they are the consultant's own
//     accumulated knowledge of a source system — the Infor FSM joins that hold
//     in every engagement — and belong to the person, not to any one workspace.
//
// A saved join is one column-to-column relationship. Matching is by name: a
// join applies when both of its tables are on the canvas and both columns
// exist. That is intentionally dumb. Fingerprinting a source system by its
// column set would be cleverer and would occasionally be wrong, and a wrong
// join is a silently wrong number in a client report.

import { isTauri, tauriOpenFile, tauriSavePath } from '../tauri-dialog';
import { loadItemPayload, saveItemPayload } from '../workspace';
import type { ErdQualifier, ErdRelationship, ErdTable } from '../erd/model';

export type JoinScope = 'workspace' | 'global';

export interface SavedJoin {
    id: string;
    scope: JoinScope;
    fromTable: string;
    fromColumn: string;
    toTable: string;
    toColumn: string;
    /** Constant predicates that qualify the join, e.g. `MMDIST.source = 'RQ'`.
     *  The main reason a join is worth SAVING rather than re-inferring: a key
     *  can be guessed from column names, a discriminator never can. */
    qualifiers?: ErdQualifier[];
    /** Free-text note — why this join exists, what it means. The part that is
     *  worth saving and that inference can never recover. */
    notes?: string;
    updatedAt: number;
}

const EXPORT_VERSION = 1;
const LIBRARY_ITEM_ID = 'join-library';
const GLOBAL_KEY = 'duckle.erdlib::__global__';

interface LibraryFile {
    kind: 'duckle.erd-library';
    version: number;
    joins: SavedJoin[];
}

/** Stable id for a join: the join IS its two endpoints, so the same
 *  relationship saved twice is one entry rather than a duplicate. */
export function joinId(r: {
    fromTable: string;
    fromColumn: string;
    toTable: string;
    toColumn: string;
}): string {
    return `${r.fromTable}.${r.fromColumn}->${r.toTable}.${r.toColumn}`;
}

function isSavedJoin(v: unknown): v is SavedJoin {
    if (typeof v !== 'object' || v === null) return false;
    const j = v as Record<string, unknown>;
    return (
        typeof j.fromTable === 'string' &&
        typeof j.fromColumn === 'string' &&
        typeof j.toTable === 'string' &&
        typeof j.toColumn === 'string'
    );
}

function coerce(raw: unknown, scope: JoinScope): SavedJoin[] {
    if (!Array.isArray(raw)) return [];
    return raw.filter(isSavedJoin).map(j => ({
        ...j,
        id: j.id || joinId(j),
        scope,
        updatedAt: typeof j.updatedAt === 'number' ? j.updatedAt : Date.now(),
    }));
}

// ---- Global scope (localStorage) ----

export function loadGlobalJoins(): SavedJoin[] {
    try {
        return coerce(JSON.parse(localStorage.getItem(GLOBAL_KEY) ?? '[]'), 'global');
    } catch {
        return [];
    }
}

export function saveGlobalJoins(joins: SavedJoin[]): void {
    try {
        localStorage.setItem(GLOBAL_KEY, JSON.stringify(joins.filter(j => j.scope === 'global')));
    } catch {
        // A full or disabled localStorage must not take the studio down with
        // it; the workspace half of the library still works.
    }
}

// ---- Workspace scope (a file in the workspace) ----

export async function loadWorkspaceJoins(workspacePath: string): Promise<SavedJoin[]> {
    const raw = await loadItemPayload<unknown>(workspacePath, 'block', LIBRARY_ITEM_ID);
    if (typeof raw !== 'object' || raw === null) return [];
    return coerce((raw as Record<string, unknown>).joins, 'workspace');
}

export async function saveWorkspaceJoins(
    workspacePath: string,
    joins: SavedJoin[],
): Promise<boolean> {
    const file: LibraryFile = {
        kind: 'duckle.erd-library',
        version: EXPORT_VERSION,
        joins: joins.filter(j => j.scope === 'workspace'),
    };
    return saveItemPayload(workspacePath, 'block', LIBRARY_ITEM_ID, file);
}

/** The combined library: global first, then this workspace's own. */
export async function loadJoinLibrary(workspacePath?: string | null): Promise<SavedJoin[]> {
    const global = loadGlobalJoins();
    if (!workspacePath) return global;
    return [...global, ...(await loadWorkspaceJoins(workspacePath))];
}

/** Persist a combined list by splitting it back to the store each scope owns. */
export async function saveJoinLibrary(
    workspacePath: string | null | undefined,
    joins: SavedJoin[],
): Promise<boolean> {
    saveGlobalJoins(joins);
    if (!workspacePath) return true;
    return saveWorkspaceJoins(workspacePath, joins);
}

// ---- List operations ----

export function upsertJoin(list: SavedJoin[], join: SavedJoin): SavedJoin[] {
    const i = list.findIndex(j => j.id === join.id && j.scope === join.scope);
    if (i < 0) return [...list, join];
    const next = [...list];
    next[i] = join;
    return next;
}

export function removeJoin(list: SavedJoin[], id: string, scope: JoinScope): SavedJoin[] {
    return list.filter(j => !(j.id === id && j.scope === scope));
}

/** Turn a relationship into a library entry. */
export function toSavedJoin(r: ErdRelationship, scope: JoinScope, notes?: string): SavedJoin {
    return {
        id: joinId(r),
        scope,
        fromTable: r.fromTable,
        fromColumn: r.fromColumn,
        toTable: r.toTable,
        toColumn: r.toColumn,
        qualifiers: r.qualifiers,
        notes,
        updatedAt: Date.now(),
    };
}

/**
 * The saved joins that APPLY to a given set of tables — both tables present and
 * both columns real.
 *
 * The column check is what stops a stale entry from producing a join to a
 * column a pipeline has since dropped, which would fail at Run with an error
 * pointing at the query rather than at the library that caused it.
 */
export function applicableJoins(library: SavedJoin[], tables: ErdTable[]): ErdRelationship[] {
    const cols = new Map(tables.map(t => [t.name, new Set(t.columns.map(c => c.name))]));
    // Keyed by id so the same join held in both scopes yields one relationship.
    // LAST wins, and `loadJoinLibrary` lists global first, so the WORKSPACE
    // entry overrides the global one. The narrower scope should win: a global
    // join is the general shape of an ERP's key, and an engagement that has
    // refined it — usually by adding a qualifier — knows something the general
    // case does not. First-wins would silently drop that refinement.
    const byId = new Map<string, ErdRelationship>();
    for (const j of library) {
        if (!cols.get(j.fromTable)?.has(j.fromColumn)) continue;
        if (!cols.get(j.toTable)?.has(j.toColumn)) continue;
        const id = joinId(j);
        byId.set(id, {
            id,
            fromTable: j.fromTable,
            fromColumn: j.fromColumn,
            toTable: j.toTable,
            toColumn: j.toColumn,
            qualifiers: j.qualifiers,
            inferred: false,
        });
    }
    return [...byId.values()];
}

// ---- Export / import ----

export async function exportJoinLibrary(joins: SavedJoin[]): Promise<'ok' | 'cancelled' | string> {
    const file: LibraryFile = { kind: 'duckle.erd-library', version: EXPORT_VERSION, joins };
    const json = JSON.stringify(file, null, 2);
    try {
        if (isTauri()) {
            const path = await tauriSavePath({
                defaultPath: 'erd-library.json',
                title: 'Export join library',
                filters: [{ name: 'JSON', extensions: ['json'] }],
            });
            if (!path) return 'cancelled';
            const { writeTextFile } = await import('@tauri-apps/plugin-fs');
            await writeTextFile(path, json);
            return 'ok';
        }
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'erd-library.json';
        a.click();
        URL.revokeObjectURL(url);
        return 'ok';
    } catch (e) {
        return e instanceof Error ? e.message : String(e);
    }
}

export function parseJoinLibrary(text: string): SavedJoin[] {
    const data = JSON.parse(text) as LibraryFile | SavedJoin[];
    const joins = Array.isArray(data) ? data : data?.joins;
    // An imported file's own scope is honoured, defaulting to workspace: an
    // import is somebody else's library, and quietly promoting it to global
    // would spread it into every workspace the user opens afterwards.
    if (!Array.isArray(joins)) return [];
    return joins
        .filter(isSavedJoin)
        .map(j => ({
            ...j,
            id: j.id || joinId(j),
            scope: j.scope === 'global' ? 'global' : ('workspace' as JoinScope),
            updatedAt: typeof j.updatedAt === 'number' ? j.updatedAt : Date.now(),
        }));
}

/** Imported joins, or null if cancelled. */
export async function importJoinLibrary(): Promise<SavedJoin[] | null> {
    if (isTauri()) {
        const path = await tauriOpenFile({
            title: 'Import join library',
            filters: [{ name: 'JSON', extensions: ['json'] }],
        });
        if (!path) return null;
        const { readTextFile } = await import('@tauri-apps/plugin-fs');
        return parseJoinLibrary(await readTextFile(path));
    }
    return new Promise<SavedJoin[] | null>(resolve => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'application/json,.json';
        input.onchange = () => {
            const f = input.files?.[0];
            if (!f) return resolve(null);
            const reader = new FileReader();
            reader.onload = () => {
                try {
                    resolve(parseJoinLibrary(String(reader.result)));
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
