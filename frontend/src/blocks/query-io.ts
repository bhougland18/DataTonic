// Saved queries — what the SQL step writes instead of applying back to a node.
//
// The node-launched Studio had somewhere to put its SQL: the `code.sqlstudio`
// node's `sql` prop. Above the graph there is no node, so a query that is not
// saved is a query that is lost on the next step change. This is that place.
//
// SHAPED AS A DIVE MINUS ITS CHART, deliberately. `Dive` is
// `{ id, title, query, chart, … }` and `parseDive` refuses a dive without a
// chart — so "a saved query" is exactly the half of a dive that exists before
// the Charts step (DAA.72) supplies the other half. Storing it in dive's own
// vocabulary (`query.sql`, `title`, `meta`) means promotion later is adding a
// field, not translating a record. Anything else would need a migration to
// become the thing it was always going to become.
//
// ONE FILE, not one per query, for now. The blocks payload directory is shared
// with the ER model, and per-item files only start paying off once blocks are
// browsable repo items (DAA.79) — which is also when they would need a `blocks`
// FOLDER entry in `repository.json`, the omission of which is precisely the bug
// that hid every pipeline in a real workspace. Splitting the file is the easy
// half of that change; the folder entry is the half worth doing deliberately.

import { isTauri, tauriOpenFile, tauriSavePath } from '../tauri-dialog';
import { loadItemPayload, saveItemPayload } from '../workspace';

const EXPORT_VERSION = 1;

interface QueryFile {
    kind: 'duckle.saved-queries';
    version: number;
    queries: SavedQuery[];
}

/** The id of the single payload holding every saved query. */
export const SAVED_QUERIES_ID = 'queries';

export interface SavedQuery {
    id: string;
    title: string;
    /** Dive's own shape, so a chart is all that is missing later. */
    query: { sql: string };
    /** What the query is for, in the author's words. `description` rather than
     *  a name of our own because `Dive` already has this exact field — the
     *  point of borrowing dive's vocabulary is that promotion adds a chart and
     *  changes nothing else. */
    description?: string;
    meta?: { createdAt?: string; updatedAt?: string };
}

interface StoredQueries {
    schemaVersion: 1;
    kind: 'queries';
    queries: SavedQuery[];
}

/** A stable-ish id from the title, with a suffix so two "Item by vendor" saves
 *  do not collide. Readable because it will become a dive file name. */
export function queryId(title: string): string {
    const slug =
        title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 40) || 'query';
    return `${slug}-${Math.random().toString(36).slice(2, 7)}`;
}

function isQuery(v: unknown): v is SavedQuery {
    if (typeof v !== 'object' || v === null) return false;
    const q = v as Record<string, unknown>;
    const query = q.query as Record<string, unknown> | undefined;
    return (
        typeof q.id === 'string' &&
        typeof q.title === 'string' &&
        !!query &&
        typeof query === 'object' &&
        typeof query.sql === 'string'
    );
}

/**
 * Load the saved queries, dropping any malformed entry.
 *
 * Dropped rather than thrown on, the same call `loadSchemaModel` makes and for
 * the same reason: this file accumulates many small independent records, so one
 * bad row should cost that row, not the whole panel. `parseDive` is strict in
 * the opposite direction because a dive is ONE record — half of it is nothing.
 */
export async function loadSavedQueries(workspacePath: string): Promise<SavedQuery[]> {
    const raw = await loadItemPayload<unknown>(workspacePath, 'block', SAVED_QUERIES_ID);
    if (typeof raw !== 'object' || raw === null) return [];
    const o = raw as Record<string, unknown>;
    return Array.isArray(o.queries) ? o.queries.filter(isQuery) : [];
}

export async function saveSavedQueries(
    workspacePath: string,
    queries: SavedQuery[],
): Promise<boolean> {
    const payload: StoredQueries = { schemaVersion: 1, kind: 'queries', queries };
    return saveItemPayload(workspacePath, 'block', SAVED_QUERIES_ID, payload);
}

/**
 * Add or replace a query by id, newest first.
 *
 * Re-saving under a title that already exists UPDATES that entry rather than
 * adding a second: the SQL step has one editor, so saving twice is almost
 * always a revision, and a list that quietly grows a near-duplicate on every
 * save is one nobody keeps using.
 */
export function upsertQuery(list: SavedQuery[], q: SavedQuery): SavedQuery[] {
    const byTitle = list.find(x => x.id !== q.id && x.title.trim() === q.title.trim());
    const target = byTitle ? { ...q, id: byTitle.id } : q;
    const rest = list.filter(x => x.id !== target.id);
    return [{ ...target, meta: { ...target.meta, updatedAt: new Date().toISOString() } }, ...rest];
}

export function removeQuery(list: SavedQuery[], id: string): SavedQuery[] {
    return list.filter(q => q.id !== id);
}

// ---- The title/description header ----------------------------------------
//
// Written INTO the SQL, not only into the record beside it, so the query
// explains itself wherever it ends up — pasted into a ticket, opened in
// another tool, read in a git diff. A description that only exists in a JSON
// sidecar is a description that is gone the moment the SQL is copied.
//
// `-- name:` / `-- description:` follows the yesql / dbt convention rather
// than a bare comment, and the labels are what make the block machine-findable
// again: a plain leading comment cannot be told apart from the author's own
// notes, so re-saving would either stack headers or eat their remarks.

const HEADER_LINE = /^--\s*(name|description)\s*:/i;

/** One line each, newlines flattened — a comment cannot span a line break. */
export function queryHeader(title: string, description?: string): string {
    const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
    const lines = [`-- name: ${flat(title)}`];
    if (description?.trim()) lines.push(`-- description: ${flat(description)}`);
    return lines.join('\n');
}

/** Remove a leading header block, so re-saving replaces rather than stacks. */
export function stripQueryHeader(sql: string): string {
    const lines = sql.split('\n');
    let i = 0;
    while (i < lines.length && HEADER_LINE.test(lines[i])) i += 1;
    if (i === 0) return sql;
    // Blank separator lines belong to the header, not to the query.
    while (i < lines.length && !lines[i].trim()) i += 1;
    return lines.slice(i).join('\n');
}

/** The query as it is stored: a fresh header over the body. */
export function withQueryHeader(sql: string, title: string, description?: string): string {
    return `${queryHeader(title, description)}\n\n${stripQueryHeader(sql)}`;
}

// ---- Portability ----------------------------------------------------------

function isQueryFile(v: unknown): v is QueryFile {
    if (typeof v !== 'object' || v === null) return false;
    const f = v as Record<string, unknown>;
    return f.kind === 'duckle.saved-queries' && Array.isArray(f.queries);
}

/** Parse an exported file, keeping only the entries that are usable. */
export function parseQueryFile(text: string): SavedQuery[] {
    const raw = JSON.parse(text) as unknown;
    if (!isQueryFile(raw)) throw new Error('Not a Duckle saved-queries file.');
    return raw.queries.filter(isQuery);
}

export async function exportQueries(
    queries: SavedQuery[],
): Promise<'ok' | 'cancelled' | string> {
    const file: QueryFile = { kind: 'duckle.saved-queries', version: EXPORT_VERSION, queries };
    const json = JSON.stringify(file, null, 2);
    try {
        if (isTauri()) {
            const path = await tauriSavePath({
                defaultPath: 'saved-queries.json',
                title: 'Export saved queries',
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
        a.download = 'saved-queries.json';
        a.click();
        URL.revokeObjectURL(url);
        return 'ok';
    } catch (e) {
        return e instanceof Error ? e.message : String(e);
    }
}

export async function importQueries(): Promise<SavedQuery[] | null> {
    if (isTauri()) {
        const path = await tauriOpenFile({
            title: 'Import saved queries',
            filters: [{ name: 'JSON', extensions: ['json'] }],
        });
        if (!path) return null;
        const { readTextFile } = await import('@tauri-apps/plugin-fs');
        return parseQueryFile(await readTextFile(path));
    }
    return new Promise<SavedQuery[] | null>(resolve => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'application/json,.json';
        input.onchange = () => {
            const f = input.files?.[0];
            if (!f) return resolve(null);
            const reader = new FileReader();
            reader.onload = () => {
                try {
                    resolve(parseQueryFile(String(reader.result)));
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
