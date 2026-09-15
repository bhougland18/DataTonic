// Everything the chart editor needs, in one place any host can mount.
//
// The second kind of seam (`chart-editor-handoff.md` §7), like
// `useQueryBuilder` and unlike `ErdEditor`: this does NOT own a savable
// document. What it produces is a SPEC, and the host decides where that goes —
// saved beside the SQL in Blocks, and wherever the next host keeps it. Giving
// this a Save of its own would invent a moment that does not exist and put two
// owners on one document, which is how the two SQL surfaces drifted apart.
//
// So the state lives here and the host reads `spec`. `spec` is an OUTPUT and
// nothing pushes it back in by an effect — derived state that also writes is the
// shape that goes subtly wrong the moment the two disagree.
//
// THE STEP IS REFINEMENT, NOT CONSTRUCTION (plan §7). A chart type can only be
// picked when the matcher says the result fits it, because a fit is what carries
// the column-to-channel assignment. Everything here edits that proposal:
// remapping a channel among the columns its contract accepts, naming axes,
// sorting, scaling, colouring, formatting. There is deliberately no way to hand-
// assemble an encoding for a chart the data does not support — that is the
// "draw it and find out what is wrong" loop the whole feature replaces.

import { useCallback, useMemo, useState } from 'react';
import type { DiveChart } from '../dives/dive-types';
import type { SqlStudioColumn } from '../sqleditor/types';
import {
    allCharts,
    checkShape,
    fieldsFromColumns,
    shapeFor,
    type Channel,
    type ChannelNeed,
    type ChartType,
    type Field,
    type Verdict,
} from './chart-shapes';
import {
    assignChannel,
    buildSpec,
    channelOptions,
    escapeField,
    missingFields,
    readSpec,
    stateFromVerdict,
    type ChannelOption,
    type ChannelSpec,
    type ChartSpecState,
    type StackMode,
    VL_SCHEMA,
} from './chart-spec';

export type { ChannelOption } from './chart-spec';
import {
    applyCustom,
    checkCustom,
    type CustomChart,
    type CustomVerdict,
} from './custom-charts';

/**
 * Which representation is being edited.
 *
 * Not a preference but a STATEMENT about the spec: `json` is where a spec goes
 * when it does something the controls cannot model, and `readSpec` decides that,
 * not the user. Offering "edit as JSON" as a mere view would mean silently
 * flattening a layered spec the moment somebody switched back.
 */
export type ChartEditMode = 'gui' | 'json';

export interface ChartEditorInput {
    /** The columns of the result the chart is drawn over. */
    columns: SqlStudioColumn[];
    /** Rows in that result — part of whether a distribution chart is worth offering. */
    rowCount?: number;
    /** One row per group. Undefined for hand-written SQL, where telling a GROUP
     *  BY from a window function would mean parsing. */
    aggregated?: boolean;
    /**
     * Saved custom templates. The HOST owns the list and its persistence, the
     * same way it owns the saved queries — this only matches and applies them.
     */
    customs?: CustomChart[];
    /**
     * Columns that are KEYS rather than measures.
     *
     * From the host, because only it has the ER model. Without it a foreign
     * key reads as a number and a line chart over vendor IDs ranks first —
     * see `fieldsFromColumns`.
     */
    identifiers?: ReadonlySet<string>;
}

export interface ChartEditor {
    /** The chart being edited, or null before one is picked. */
    state: ChartSpecState | null;
    /** The spec the host saves and the renderer draws. An output. */
    spec: DiveChart | null;

    mode: ChartEditMode;
    /** The JSON text, live while `mode` is `json`. */
    json: string;
    /** Why the JSON cannot be used, or null. */
    jsonError: string | null;
    /** True when the spec is beyond the controls, so `gui` is not available. */
    jsonOnly: boolean;

    /** Result columns that can go on a chart at all. */
    fields: Field[];
    /** Every chart with its verdict, best first — what the gallery renders. */
    charts: Verdict[];
    /** The saved templates, each with the same kind of verdict as a built-in. */
    customCharts: CustomVerdict[];
    /** The verdict for the chart being edited. */
    verdict: Verdict | null;
    /** The chosen chart's channels, so the panel knows what to offer. */
    needs: ChannelNeed[];
    /** Columns the spec names that the result no longer has. */
    missing: string[];
    /** Columns this channel may hold, by its contract. */
    optionsFor: (channel: Channel) => ChannelOption[];

    /** Take a chart from the gallery. Only a fit carries an encoding. */
    pick: (chart: ChartType) => void;
    /**
     * Take a SAVED template and put this result's columns into it.
     *
     * Lands in JSON mode whenever the template does something the controls do
     * not model, which is most of the reason to save one — and is exactly what
     * `load` already decides. Unlike `pick`, this accepts a template that does
     * not fit: it applies as-is so the field names can be fixed by hand, which
     * is the only option for a layered spec with no contract to read.
     */
    pickCustom: (custom: CustomChart) => void;
    /** Throw the chart away and go back to the gallery. */
    clear: () => void;
    /** Seed from a saved spec — an opened block. `null` clears. */
    load: (chart: DiveChart | null) => void;

    setChannel: (channel: Channel, field: string | null) => void;
    setChannelOption: (channel: Channel, patch: Partial<ChannelSpec>) => void;
    setTitle: (title: string) => void;
    setSubtitle: (subtitle: string) => void;
    setStack: (stack: StackMode | undefined) => void;
    setScheme: (scheme: string | undefined) => void;
    setPoints: (points: boolean) => void;

    setJson: (text: string) => void;
    /** Hand the spec to the JSON editor. Always available. */
    editAsJson: () => void;
    /** Take the JSON back into the controls. False when they cannot model it. */
    applyJson: () => boolean;
    /**
     * Back to the controls WITHOUT applying the JSON.
     *
     * What the Builder tab does, and the reason it can be a tab at all:
     * `applyJson` used to be the only way out, so a spec edited into something
     * unparseable trapped you — the one moment you most want to back out is the
     * one where applying is refused. Throws the text away and restores it from
     * the state still held.
     *
     * NULL when there is no state to go back to, which is also what disables
     * the Builder tab: a spec the controls never modelled has no other
     * representation, and a tab leading nowhere is worse than a disabled one.
     */
    cancelJson: (() => void) | null;
    /**
     * Start a CUSTOM chart from scratch, in the JSON editor.
     *
     * The authoring path that was missing: templates could only be saved from a
     * chart the gallery already offered, so a spec Vega-Lite can draw but the
     * built-in shapes do not describe had no way in. Seeded with this result's
     * own columns, so the skeleton runs as soon as it opens.
     */
    startCustom: () => void;
}

export function useChartEditor({
    columns,
    rowCount,
    aggregated,
    customs,
    identifiers,
}: ChartEditorInput): ChartEditor {
    const [state, setState] = useState<ChartSpecState | null>(null);
    const [mode, setMode] = useState<ChartEditMode>('gui');
    const [json, setJsonText] = useState('');
    const [jsonError, setJsonError] = useState<string | null>(null);
    /**
     * A spec held ONLY as text, because the controls cannot model it.
     *
     * Kept separate from `state` rather than as a flag on it: the whole point is
     * that there is no state for this spec, and a `ChartSpecState` standing in
     * for one would be the silent flattening `readSpec` exists to prevent.
     */
    const [rawSpec, setRawSpec] = useState<DiveChart | null>(null);

    const fields = useMemo(() => fieldsFromColumns(columns, identifiers), [columns, identifiers]);
    const ctx = useMemo(() => ({ rowCount, aggregated }), [rowCount, aggregated]);
    const charts = useMemo(() => allCharts(fields, ctx), [fields, ctx]);
    // Same matcher as the built-ins (`matchNeeds`), so a custom card can say
    // "needs a number" instead of drawing an empty chart over columns that are
    // not there.
    const customCharts = useMemo(
        () => (customs ?? []).map(c => checkCustom(c, fields)),
        [customs, fields],
    );

    const spec = useMemo(() => {
        if (rawSpec) return rawSpec;
        return state ? buildSpec(state) : null;
    }, [state, rawSpec]);

    const verdict = useMemo(
        () => (state ? checkShape(fields, state.chart, ctx) : null),
        [state, fields, ctx],
    );

    // The channels of the variant that actually matched, so a grouped bar chart
    // offers its colour channel and a simple one does not pretend to.
    const needs = useMemo((): ChannelNeed[] => {
        if (!state) return [];
        const shape = shapeFor(state.chart);
        if (!shape) return [];
        if (verdict && (verdict.kind === 'fits' || verdict.kind === 'close')) {
            return verdict.variant.needs;
        }
        return shape.variants[0]?.needs ?? [];
    }, [state, verdict]);

    const missing = useMemo(() => (state ? missingFields(state, fields) : []), [state, fields]);

    const optionsFor = useCallback(
        (channel: Channel): ChannelOption[] => {
            const need = needs.find(n => n.channel === channel);
            return need && state ? channelOptions(state, need, fields) : [];
        },
        [needs, state, fields],
    );

    const pick = useCallback(
        (chart: ChartType) => {
            // Only a `fits` verdict carries an encoding, and the encoding is the
            // proposal — see the module header. Anything else leaves the gallery
            // showing what that chart still needs.
            const next = stateFromVerdict(checkShape(fields, chart, ctx));
            if (!next) return;
            setState(next);
            setRawSpec(null);
            setJsonError(null);
            setMode('gui');
        },
        [fields, ctx],
    );

    const clear = useCallback(() => {
        setState(null);
        setRawSpec(null);
        setJsonText('');
        setJsonError(null);
        setMode('gui');
    }, []);

    const load = useCallback((chart: DiveChart | null) => {
        if (!chart || Object.keys(chart).length === 0) {
            setState(null);
            setRawSpec(null);
            setJsonText('');
            setJsonError(null);
            setMode('gui');
            return;
        }
        const read = readSpec(chart);
        setJsonText(JSON.stringify(chart, null, 2));
        setJsonError(null);
        if (read) {
            setState(read);
            setRawSpec(null);
            setMode('gui');
        } else {
            // A hand-written or AI-written spec beyond these controls. It opens in
            // JSON exactly as a hand-written query opens in SQL mode rather than
            // in the builder.
            setState(null);
            setRawSpec(chart);
            setMode('json');
        }
    }, []);

    /**
     * Apply a saved template to the result on screen.
     *
     * Goes through `load`, so the template lands in whichever representation is
     * honest for it — the controls when it is within the modelled subset, JSON
     * when it is not, which is most custom templates and most of the point of
     * having them.
     *
     * Applies even when the verdict is not a fit, unlike `pick`. A template
     * whose channels cannot be filled still has its field names, and letting
     * somebody load it and correct them by hand is the only route for a layered
     * spec with no contract to read.
     */
    const pickCustom = useCallback(
        (custom: CustomChart) => {
            load(applyCustom(custom, checkCustom(custom, fields).encoding));
        },
        [fields, load],
    );

    /** Every GUI edit funnels through here, so `rawSpec` can never linger. */
    const edit = useCallback((fn: (s: ChartSpecState) => ChartSpecState) => {
        setState(s => (s ? fn(s) : s));
    }, []);

    const setChannel = useCallback(
        (channel: Channel, field: string | null) => {
            const need = needs.find(n => n.channel === channel);
            if (!need) return;
            edit(s => assignChannel(s, need, fields, field));
        },
        [edit, needs, fields],
    );

    const setChannelOption = useCallback(
        (channel: Channel, patch: Partial<ChannelSpec>) => {
            edit(s => {
                const prev = s.encoding[channel];
                if (!prev) return s;
                return { ...s, encoding: { ...s.encoding, [channel]: { ...prev, ...patch } } };
            });
        },
        [edit],
    );

    const setJson = useCallback((text: string) => {
        setJsonText(text);
        setJsonError(null);
    }, []);

    const editAsJson = useCallback(() => {
        if (state) setJsonText(JSON.stringify(buildSpec(state), null, 2));
        setMode('json');
    }, [state]);

    // Only offered when the controls have something to go back TO.
    const cancelJson = useCallback(() => {
        if (!state) return;
        setJsonText(JSON.stringify(buildSpec(state), null, 2));
        setJsonError(null);
        setMode('gui');
    }, [state]);

    const startCustom = useCallback(() => {
        // A skeleton over real columns beats an empty object: it renders
        // immediately, so the first edit is a refinement rather than a guess at
        // what the shape of a spec even is.
        const category = fields.find(f => f.vlType === 'nominal' || f.vlType === 'ordinal');
        const measure = fields.find(f => f.vlType === 'quantitative');
        const encoding: Record<string, unknown> = {};
        if (category) encoding.x = { field: escapeField(category.name), type: category.vlType };
        if (measure) encoding.y = { field: escapeField(measure.name), type: measure.vlType };
        setState(null);
        setRawSpec(null);
        setJsonError(null);
        setJsonText(
            JSON.stringify({ $schema: VL_SCHEMA, mark: 'bar', encoding }, null, 2),
        );
        setMode('json');
    }, [fields]);

    const applyJson = useCallback((): boolean => {
        let parsed: unknown;
        try {
            parsed = JSON.parse(json);
        } catch (e) {
            setJsonError(e instanceof Error ? e.message : String(e));
            return false;
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            setJsonError('A chart spec is a JSON object.');
            return false;
        }
        const chart = parsed as DiveChart;
        const read = readSpec(chart);
        if (read) {
            setState(read);
            setRawSpec(null);
            setJsonError(null);
            setMode('gui');
            return true;
        }
        // Kept, not rejected. The spec is valid Vega-Lite that these controls do
        // not model, so it stays the source of truth and the editor stays in
        // JSON — the same answer `load` gives an opened block.
        setState(null);
        setRawSpec(chart);
        setJsonError(null);
        return false;
    }, [json]);

    return {
        state,
        spec,
        mode,
        json,
        jsonError,
        jsonOnly: rawSpec !== null,
        fields,
        charts,
        customCharts,
        verdict,
        needs,
        missing,
        optionsFor,
        pick,
        pickCustom,
        clear,
        load,
        setChannel,
        setChannelOption,
        setTitle: useCallback((title: string) => edit(s => ({ ...s, title })), [edit]),
        setSubtitle: useCallback((subtitle: string) => edit(s => ({ ...s, subtitle })), [edit]),
        setStack: useCallback((stack: StackMode | undefined) => edit(s => ({ ...s, stack })), [edit]),
        setScheme: useCallback((scheme: string | undefined) => edit(s => ({ ...s, scheme })), [edit]),
        setPoints: useCallback((points: boolean) => edit(s => ({ ...s, points })), [edit]),
        setJson,
        editAsJson,
        applyJson,
        cancelJson: state ? cancelJson : null,
        startCustom,
    };
}
