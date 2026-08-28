// Persisting an imported spec as a plain workspace file (PL-6 / ARCH-2).
//
// The artifact is a single self-describing JSON file under `<workspace>/
// api-specs/<id>.apispec.json`, holding the source descriptor plus the original
// raw text. Storing the raw text (not just the parsed tree) means a later
// re-parse — or the PL-6b Rust-side validation extension point — works from
// exactly what the user imported.
//
// Isolation note (D4): this uses its own tiny fs accessor mirroring
// workspace.ts's Tauri/web pattern rather than importing that module's private
// helpers, so the Playground touches no shared upstream file. Full integration
// into repository.json as a first-class RepoItemType (the S4 recipe) is the
// documented next step; it is deliberately deferred to keep this increment's
// shared-surface footprint at zero.

import { isTauri } from '../tauri-dialog';
import { isWebBackend, webFs } from '../web-fs';
import type { ParsedSpec, SpecSource } from './types';

export function persistenceAvailable(): boolean {
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

const SPECS_DIR = 'api-specs';

// The on-disk artifact shape. `schemaVersion` lets a future reader migrate.
export interface PersistedSpecArtifact {
    schemaVersion: 1;
    id: string;
    source: SpecSource;
    // A parse summary for cheap listing without re-parsing the raw text.
    summary: { version: ParsedSpec['version']; title: string; apiVersion?: string; endpointCount: number };
    // Exactly what was imported, so a re-parse is faithful (PL-6b handoff).
    raw: string;
}

export interface PersistResult {
    // Workspace-relative path of the written artifact.
    path: string;
    id: string;
}

// Write the artifact. Caller guards on persistenceAvailable(); if a backend is
// somehow absent this throws so the UI can report it honestly rather than
// silently dropping the file.
export async function persistSpec(
    workspacePath: string,
    input: { source: SpecSource; raw: string; spec: ParsedSpec },
): Promise<PersistResult> {
    const { exists, mkdir, writeTextFile } = await fs();
    const dir = joinPath(workspacePath, SPECS_DIR);
    if (!(await exists(dir))) await mkdir(dir, { recursive: true });

    const id = crypto.randomUUID();
    const artifact: PersistedSpecArtifact = {
        schemaVersion: 1,
        id,
        source: input.source,
        summary: {
            version: input.spec.version,
            title: input.spec.title,
            apiVersion: input.spec.apiVersion,
            endpointCount: input.spec.endpoints.length,
        },
        raw: input.raw,
    };
    const file = joinPath(dir, `${id}.apispec.json`);
    await writeTextFile(file, JSON.stringify(artifact, null, 2));
    return { path: joinPath(SPECS_DIR, `${id}.apispec.json`), id };
}

// ---- Saved requests (PL-14) ----
//
// A constructed request persisted as its own plain workspace file, independent
// of any Canvas transfer. Auth is stored by REFERENCE only — a connectionRef
// and/or the auth *type* — never secret values, so the artifact is safe to keep
// (and commit) alongside the rest of the workspace.

const REQUESTS_DIR = 'api-requests';

export interface SavedRequestArtifact {
    schemaVersion: 1;
    id: string;
    savedAt: string;
    // Provenance back to the spec this came from.
    spec: { title: string; version: string; sourceRef?: string; operationId?: string };
    operation: { method: string; path: string };
    request: {
        baseUrl: string;
        // Keyed `${location}:${name}`.
        paramValues: Record<string, string>;
        extraHeaders: { key: string; value: string }[];
        body?: string;
        contentType?: string;
        // Reference only — no secrets.
        auth: { connectionRef?: string; authType?: string };
    };
}

export async function persistRequest(
    workspacePath: string,
    artifact: Omit<SavedRequestArtifact, 'schemaVersion' | 'id' | 'savedAt'> & { savedAt: string },
): Promise<PersistResult> {
    const { exists, mkdir, writeTextFile } = await fs();
    const dir = joinPath(workspacePath, REQUESTS_DIR);
    if (!(await exists(dir))) await mkdir(dir, { recursive: true });

    const id = crypto.randomUUID();
    const full: SavedRequestArtifact = { schemaVersion: 1, id, ...artifact };
    const file = joinPath(dir, `${id}.apireq.json`);
    await writeTextFile(file, JSON.stringify(full, null, 2));
    return { path: joinPath(REQUESTS_DIR, `${id}.apireq.json`), id };
}
