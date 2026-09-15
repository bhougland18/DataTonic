// Promoting a block to a dive, and opening one back up.
//
// `chart-editor-handoff.md` §7a said a block IS a dive. What it did not say,
// and what Ben settled on 2026-09-14, is the CARDINALITY:
//
//   **one query → many dives.**
//
// A dive is (this query, ONE chart). The same result usually has several
// stories in it — items per vendor as ranked bars, the same counts as a pie,
// the added-date trend as a line — and each of those is a dive. So "Save as
// dive" MAKES one rather than overwriting "the" chart of the query, and
// `SavedQuery.chart` stops being the published artefact and becomes what it
// always really was: the draft you had open, restored when you reopen the query.
//
// Pure and separate from `query-io.ts` because this is a TRANSLATION between
// two persisted shapes, and the interesting parts (which fields carry over,
// what a stable id looks like, whether two dives share a dataset) are all
// answerable without a workspace.

import {
    DIVE_SCHEMA_VERSION,
    type Dive,
    type DiveChart,
    type DiveSource,
} from '../dives/dive-types';
import type { BuilderState } from './builder-types';
import { stripQueryHeader } from './query-io';

/** What a block hands over when it is saved as a dive. */
export interface BlockParts {
    /** Reuse an existing dive's id to UPDATE it; omit to make a new one. */
    id?: string;
    title: string;
    description?: string;
    sql: string;
    chart: DiveChart;
    /** How the query was authored, when it was built rather than written. */
    builder?: BuilderState;
    /**
     * The database the SQL needs ATTACHed, when it needs one.
     *
     * NOT optional in practice, and the reason is a bug this fixed: the Blocks
     * SQL step queries through `src.duckdb`, so its SQL names
     * `duckle_src."Vendor"` — an alias that exists only because that node's
     * prelude created it. A dive saved without this ran fine in Blocks and
     * failed everywhere else with `schema "duckle_src" does not exist`, which
     * is precisely the moment a saved artefact is least useful.
     */
    source?: DiveSource;
    createdAt?: string;
}

/**
 * A dive carries the builder state as a SIBLING of `query`, not inside `state`.
 *
 * `DiveState` is what you are LOOKING at — params, sort, drill, row limit —
 * whereas the builder is what PRODUCED the query. Keeping them apart is what
 * lets `parseDive` go on ignoring a field it has never heard of: a dive written
 * by this build opens in older code as a perfectly good hand-written dive.
 */
export interface BlockDive extends Dive {
    builder?: BuilderState;
}

/** A readable, collision-resistant id. Readable because it becomes a filename. */
export function diveId(title: string): string {
    const slug =
        title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 40) || 'dive';
    return `${slug}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * The dive a block becomes.
 *
 * `meta.generator` is `'manual'` because a person chose this chart from the
 * gallery and adjusted it. `'duckie'` is reserved for the text-to-dive path,
 * and the distinction is worth keeping honest — it is the only record of
 * whether anybody looked at this chart before it was saved.
 */
export function toDive(parts: BlockParts): BlockDive {
    const title = parts.title.trim() || 'Untitled dive';
    const now = new Date().toISOString();
    const dive: BlockDive = {
        diveSchemaVersion: DIVE_SCHEMA_VERSION,
        id: parts.id ?? diveId(title),
        title,
        query: { sql: parts.sql },
        chart: parts.chart,
        meta: {
            createdAt: parts.createdAt ?? now,
            updatedAt: now,
            generator: 'manual',
        },
    };
    const description = parts.description?.trim();
    if (description) dive.description = description;
    if (parts.builder) dive.builder = parts.builder;
    if (parts.source) dive.source = parts.source;
    return dive;
}

/**
 * The SQL two dives would have to share to be facets of ONE dataset.
 *
 * Normalised, because the `-- name:` header is rewritten on every save and
 * whitespace is not a difference anybody means. Without this, two dives over
 * the same query looked like two datasets and switching between them re-ran a
 * query whose answer was already on screen.
 */
export function datasetKey(sql: string): string {
    return stripQueryHeader(sql)
        .replace(/--[^\n]*/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

/** Are these two queries the same dataset, so a chart swap needs no re-run? */
export const sameDataset = (a: string, b: string): boolean => datasetKey(a) === datasetKey(b);

/**
 * A repo item's payload as a dive, or null when it is not one.
 *
 * Deliberately lenient about `chart`: `DiveModal` writes `chart: {}` for a dive
 * with no chart yet, and that is a real record rather than a broken one — it
 * opens with the gallery showing, exactly like a query that has never been
 * charted.
 */
export function asDive(raw: unknown): BlockDive | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const d = raw as Record<string, unknown>;
    if (typeof d.id !== 'string' || !d.id) return null;
    if (typeof d.title !== 'string' || !d.title) return null;
    const q = d.query as Record<string, unknown> | undefined;
    if (!q || typeof q !== 'object' || typeof q.sql !== 'string' || !q.sql.trim()) return null;
    if (typeof d.chart !== 'object' || d.chart === null) return null;
    // A version from the future would be half-read rather than read, which is
    // the one case where dropping the record is kinder than showing it.
    const ver = d.diveSchemaVersion;
    if (typeof ver === 'number' && Math.floor(ver) > DIVE_SCHEMA_VERSION) return null;
    return raw as BlockDive;
}

/** Does this dive actually carry a chart, or is it a query waiting for one? */
export const hasChart = (dive: BlockDive): boolean =>
    !!dive.chart && Object.keys(dive.chart).length > 0;
