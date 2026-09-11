// Persistence for the Blocks ER model.
//
// The model is a `model`-kind block (see `types.ts`), stored as
// <workspace>/blocks/<id>.json through the same per-item payload machinery
// connections, docs and dives use — a thin typed wrapper, exactly like
// `dives/dive-io.ts`.
//
// ONE model per workspace, under a fixed id. The Blocks studio draws every
// durable dataset in the catalog on one canvas, so there is one ER model over
// that catalog rather than a library of them. A fixed id means no naming UI, no
// picker and no list — none of which mean anything while there is exactly one.
// When blocks become browsable items (DAA.79) this becomes an ordinary block
// with a generated id and this constant becomes its default.
//
// It deliberately does NOT register a repo item. A repo item would put the
// model in the sidebar tree, which needs a `blocks` FOLDER entry to hang under
// — and writing items without their folder is precisely the bug that hid every
// pipeline in a real workspace (DAA.94). Studio state does not need to be
// browsable, so the cheaper and safer thing is to not pretend it is.

import { loadItemPayload, saveItemPayload } from '../workspace';
import type { ErdModel, ErdRelationship, ErdTable } from '../erd/model';

/** The one ER model over a workspace's durable catalog. */
export const SCHEMA_MODEL_ID = 'schema-model';

/** The stored shape. Versioned from the start so a later change can migrate
 *  rather than guess what an old file meant. */
export interface StoredSchemaModel {
    schemaVersion: 1;
    kind: 'model';
    relationships: ErdRelationship[];
    /** Tables whose edges are not drawn. View state, but authored view state —
     *  deciding a derived table's joins are noise is a judgement worth keeping,
     *  and having to re-hide it on every open would make the toggle pointless. */
    hiddenRelations?: string[];
}

/**
 * Save the authored relationships.
 *
 * Relationships only — NOT tables. The tables come from the workspace catalog
 * and are re-read on every load, so persisting them would create a second,
 * staler copy that silently disagrees with the catalog the moment a pipeline
 * writes a new column. Relationships are the part a human authored and the only
 * part that cannot be recovered by looking at the data.
 */
export async function saveSchemaModel(
    workspacePath: string,
    relationships: ErdRelationship[],
    hiddenRelations: string[] = [],
): Promise<boolean> {
    const payload: StoredSchemaModel = {
        schemaVersion: 1,
        kind: 'model',
        relationships,
        hiddenRelations,
    };
    return saveItemPayload(workspacePath, 'block', SCHEMA_MODEL_ID, payload);
}

/** Whether a value looks like a usable relationship record. */
function isRelationship(v: unknown): v is ErdRelationship {
    if (typeof v !== 'object' || v === null) return false;
    const r = v as Record<string, unknown>;
    return (
        typeof r.id === 'string' &&
        typeof r.fromTable === 'string' &&
        typeof r.fromColumn === 'string' &&
        typeof r.toTable === 'string' &&
        typeof r.toColumn === 'string'
    );
}

/**
 * Load the saved relationships, or an empty list when there are none.
 *
 * Malformed entries are dropped rather than thrown on. A relationship file is
 * an accumulation of small edits, and losing one bad row is a far better
 * outcome than refusing to open the schema step at all — unlike a dive, where
 * a broken query has no partial meaning.
 */
export async function loadSchemaModel(
    workspacePath: string,
): Promise<{ relationships: ErdRelationship[]; hiddenRelations: string[] }> {
    const raw = await loadItemPayload<unknown>(workspacePath, 'block', SCHEMA_MODEL_ID);
    const empty = { relationships: [], hiddenRelations: [] };
    if (typeof raw !== 'object' || raw === null) return empty;
    const o = raw as Record<string, unknown>;
    return {
        relationships: Array.isArray(o.relationships) ? o.relationships.filter(isRelationship) : [],
        hiddenRelations: Array.isArray(o.hiddenRelations)
            ? o.hiddenRelations.filter((v): v is string => typeof v === 'string')
            : [],
    };
}

/**
 * Merge saved relationships with freshly inferred ones.
 *
 * Saved wins on conflict, and an inferred relationship whose tables are no
 * longer in the catalog is dropped. The rule that matters: a relationship the
 * user DELETED must not come back on the next load just because inference would
 * still guess it — so inference only contributes joins that were never
 * authored, and anything the user touched is authoritative.
 */
export function mergeRelationships(
    saved: ErdRelationship[],
    inferred: ErdRelationship[],
    tables: ErdTable[],
    library: ErdRelationship[] = [],
): ErdRelationship[] {
    const known = new Set(tables.map(t => t.name));
    const keep = saved.filter(r => known.has(r.fromTable) && known.has(r.toTable));
    if (keep.length > 0) return keep;

    // Nothing authored yet. THREE tiers, and the order is the whole design:
    // what this workspace saved wins, then the library (knowledge carried in
    // deliberately), then inference (a guess from column names).
    //
    // Library joins come first in the list and inference only adds what the
    // library did not already cover, so a hand-curated join is never displaced
    // by a name-matching guess between the same two columns.
    if (library.length > 0) {
        const have = new Set(library.map(r => r.id));
        return [...library, ...inferred.filter(r => !have.has(r.id))];
    }
    return inferred;
}

/** Convenience for callers that want the whole model shape. */
export function toModel(tables: ErdTable[], relationships: ErdRelationship[]): ErdModel {
    return { tables, relationships };
}
