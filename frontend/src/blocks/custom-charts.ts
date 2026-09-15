// Custom chart templates: a Vega-Lite spec somebody saved, offered as a chart.
//
// Ben's ask (2026-09-14): "save custom vega-lite json as a chart type that could
// show below the standard charts in a custom charts template area." This is the
// data half — the contract, the matching, and the field remapping.
//
// THE PROBLEM WORTH SOLVING HERE. A template's field names came from whatever
// result it was made on, so applied to the next query it would reference columns
// that are not there and Vega-Lite would draw correct-looking axes over nothing
// (see `escapeField`'s header for how that failure looks — it cost a rebuild to
// find). So a template is not stored as "a spec to paste". It is read as a
// CONTRACT — which channels it uses and what type each wants — and then matched
// against the current columns with the same `matchNeeds` the built-in shapes
// use. A custom chart therefore earns the same verdict as a built-in: it fits,
// or it says what it still needs.
//
// What that buys, concretely: a template made over `Vendor`/`count Item.Item`
// applies cleanly to `Manufacturer`/`n`, because what carried over was "a
// category on x, a measure on y", not two column names.

import type { DiveChart } from '../dives/dive-types';
import {
    matchNeeds,
    type ChannelNeed,
    type Encoding,
    type Field,
    type ShapeVariant,
    type VlType,
} from './chart-shapes';
import { escapeField, markType, unescapeField } from './chart-spec';

/** Where the templates live, beside the saved queries. */
export const CUSTOM_CHARTS_ID = 'custom-charts';

export interface CustomChart {
    id: string;
    name: string;
    /** The spec as saved — data-free, exactly like a block's chart. */
    spec: DiveChart;
    createdAt?: string;
}

const CHANNELS = ['x', 'y', 'color', 'theta', 'size'] as const;
type Channel = (typeof CHANNELS)[number];
const VL_TYPES: VlType[] = ['nominal', 'ordinal', 'quantitative', 'temporal'];

/**
 * Which channels a person must supply a column for.
 *
 * Positional channels and a pie's angle are load-bearing — the chart is not
 * that chart without them. Colour and size are garnish, and demanding them
 * would make half the templates permanently unusable.
 */
const REQUIRED = new Set<Channel>(['x', 'y', 'theta']);

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

export function customId(name: string): string {
    const slug =
        name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 40) || 'chart';
    return `${slug}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * The contract a template's own encoding states.
 *
 * `null` when there is nothing to read — a spec with no top-level `encoding`,
 * which is what a LAYERED or faceted template looks like. Those are still worth
 * saving (they are most of the reason to want custom charts at all), they just
 * cannot be remapped automatically; `applyCustom` says so rather than guessing
 * which of several nested encodings was the one that mattered.
 *
 * A channel with a `value` or a `datum` instead of a `field` is a CONSTANT, not
 * a column slot, so it is deliberately not part of the contract.
 */
export function variantFromSpec(spec: DiveChart): ShapeVariant | null {
    if (!isRecord(spec)) return null;
    const enc = spec.encoding;
    if (!isRecord(enc)) return null;

    const needs: ChannelNeed[] = [];
    for (const channel of CHANNELS) {
        const def = enc[channel];
        if (!isRecord(def)) continue;
        // An aggregate with no field (`{aggregate: 'count'}`) needs no column.
        if (typeof def.field !== 'string') continue;
        if ('value' in def || 'datum' in def) continue;
        const type = def.type;
        if (typeof type !== 'string' || !VL_TYPES.includes(type as VlType)) continue;
        const vl = type as VlType;
        needs.push({
            channel,
            // The template's declared type IS the requirement. An ordinal slot
            // also takes a nominal column: both are categories, and Vega-Lite
            // will render either, so refusing would be stricter than the chart.
            accepts: vl === 'ordinal' || vl === 'nominal' ? ['nominal', 'ordinal'] : [vl],
            required: REQUIRED.has(channel),
            label: labelFor(channel, vl),
        });
    }
    return needs.length === 0
        ? null
        : { id: 'custom', label: 'Saved chart', needs };
}

function labelFor(channel: Channel, type: VlType): string {
    const what =
        type === 'quantitative'
            ? 'a number'
            : type === 'temporal'
              ? 'a date'
              : 'a category';
    if (channel === 'theta') return `${what} to size the slices`;
    if (channel === 'color') return `${what} to colour by`;
    if (channel === 'size') return `${what} to size by`;
    return `${what} for ${channel}`;
}

export interface CustomVerdict {
    custom: CustomChart;
    /** `wrong` when more than one required channel has nothing to fill it. */
    kind: 'fits' | 'close' | 'wrong' | 'unreadable';
    /** Present on a fit — channel → the column that will go there. */
    encoding?: Encoding;
    missing?: ChannelNeed[];
}

/**
 * Can this result use that template?
 *
 * `unreadable` is its own answer, not a failure: the template has no top-level
 * encoding to match (it is layered, or faceted), so it can still be applied —
 * just as-is, with its field names intact, for the person to fix by hand. Saying
 * that is better than reporting "wrong shape" about a contract that was never
 * read.
 */
export function checkCustom(custom: CustomChart, fields: Field[]): CustomVerdict {
    const variant = variantFromSpec(custom.spec);
    if (!variant) return { custom, kind: 'unreadable' };
    const { encoding, missing } = matchNeeds(variant.needs, fields);
    if (missing.length === 0) return { custom, kind: 'fits', encoding };
    return { custom, kind: missing.length === 1 ? 'close' : 'wrong', missing };
}

/** "needs a number for y" — the phrase a custom verdict puts in front of somebody. */
export function customSummary(v: CustomVerdict): string | null {
    if (v.kind === 'fits') return null;
    if (v.kind === 'unreadable') return 'applied as-is — set the column names by hand';
    return `needs ${(v.missing ?? []).map(m => m.label).join(', and ')}`;
}

/**
 * The template with this result's columns in its channels.
 *
 * A deep clone, and only the `field` of each matched channel is touched —
 * everything the template said about scales, axes, legends, transforms and
 * marks is the REASON it was saved, so none of it may be normalised away. That
 * is also why this returns a raw spec rather than a `ChartSpecState`: most
 * custom templates do something `readSpec` deliberately refuses to model, and
 * the editor will hold them as JSON.
 *
 * With no readable contract the spec comes back untouched, which is the honest
 * outcome — its field names are whatever they were.
 */
export function applyCustom(custom: CustomChart, encoding: Encoding | undefined): DiveChart {
    const spec = structuredClone(custom.spec) as Record<string, unknown>;
    if (!encoding || !isRecord(spec.encoding)) return spec;
    const enc = spec.encoding as Record<string, unknown>;
    for (const channel of CHANNELS) {
        const assigned = encoding[channel];
        const def = enc[channel];
        if (!assigned || !isRecord(def)) continue;
        // Escaped here, because a column name with a dot in it is a nested
        // lookup to Vega-Lite — the builder names every aggregate that way.
        enc[channel] = { ...def, field: escapeField(assigned.field) };
    }
    return spec;
}

/**
 * Canned rows for a template's thumbnail, keyed by its own field names.
 *
 * The card has to show the chart rather than a name, or a wall of custom
 * templates is a wall of identical grey boxes. The template has no data, so
 * this makes some that satisfies its declared types — the same trick
 * `chart-thumbnails.ts` uses, except the column names have to be the
 * template's, since its spec is what will be rendered.
 */
export function cannedRowsFor(spec: DiveChart, n = 6): Record<string, unknown>[] {
    const variant = variantFromSpec(spec);
    if (!variant) return [];
    const enc = (spec as Record<string, unknown>).encoding as Record<string, unknown>;
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < n; i += 1) {
        const row: Record<string, unknown> = {};
        for (const need of variant.needs) {
            const def = enc[need.channel] as Record<string, unknown>;
            // UNESCAPED, because this is a data KEY and the spec holds a
            // reference. A template saved from the controls carries
            // `count Item\.Item`, and a row keyed by that literal is a row
            // Vega-Lite never finds — every GUI-built template would have had
            // a blank thumbnail.
            const field = unescapeField(String(def.field));
            const type = def.type as VlType;
            if (type === 'quantitative') row[field] = [8, 5, 13, 3, 9, 11][i % 6];
            else if (type === 'temporal') row[field] = `2026-0${(i % 6) + 1}-01`;
            else row[field] = 'ABCDEF'[i % 6];
        }
        rows.push(row);
    }
    return rows;
}

/** A tiny, sized copy of the template for a gallery card. */
export function customThumb(spec: DiveChart): DiveChart | null {
    const rows = cannedRowsFor(spec);
    if (rows.length === 0) return null;
    const mark = markType(spec);
    if (!mark) return null;
    return {
        ...(structuredClone(spec) as Record<string, unknown>),
        data: { values: rows },
        width: 76,
        height: 46,
        padding: 2,
        // The template's own title would overflow a 46px card, and the card
        // already says the name underneath.
        title: null,
        config: { view: { stroke: null }, axis: { disable: true }, legend: { disable: true } },
    };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

interface StoredCustomCharts {
    schemaVersion: 1;
    kind: 'custom-charts';
    charts: CustomChart[];
}

export function isCustomChart(v: unknown): v is CustomChart {
    if (!isRecord(v)) return false;
    return (
        typeof v.id === 'string' &&
        !!v.id &&
        typeof v.name === 'string' &&
        !!v.name &&
        isRecord(v.spec)
    );
}

/** Add or replace by id, newest first. */
export function upsertCustom(list: CustomChart[], c: CustomChart): CustomChart[] {
    return [c, ...list.filter(x => x.id !== c.id)];
}

export function removeCustom(list: CustomChart[], id: string): CustomChart[] {
    return list.filter(c => c.id !== id);
}

export function parseCustomCharts(raw: unknown): CustomChart[] {
    if (!isRecord(raw)) return [];
    return Array.isArray(raw.charts) ? raw.charts.filter(isCustomChart) : [];
}

export function storedCustomCharts(charts: CustomChart[]): StoredCustomCharts {
    return { schemaVersion: 1, kind: 'custom-charts', charts };
}
