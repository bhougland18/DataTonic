// Renders a dive's Vega-Lite spec. Data is bound as a NAMED dataset, so when the
// rows change (a re-query) we rebind without a full re-embed - that is what makes
// a dive stay never-stale cheaply. vega-embed is lazy-imported so the editor hot
// path pays nothing until a dive opens. See docs/design/dives.md.
//
// THE renderer, and deliberately the only one. The Blocks Charts step mounts
// this rather than embedding vega itself, so the brand config, the light/dark
// handling and the rebind-without-re-embed trick have exactly one home. A second
// renderer is how the dives gallery and the Charts step would drift apart.

import { useEffect, useRef } from 'react';
import type { Result, VisualizationSpec } from 'vega-embed';

interface VegaChartProps {
    spec: Record<string, unknown>;
    /**
     * Rows to bind as the named dataset.
     *
     * OMITTED for a spec that carries its own `data` — the gallery's thumbnails,
     * which are tiny specs over canned values. Binding a dataset there would
     * replace the canned rows with nothing and draw eight empty cards.
     */
    rows?: Record<string, unknown>[];
    theme?: 'light' | 'dark';
    /**
     * Size the chart to its container instead of Vega-Lite's 200px default.
     *
     * A RENDER-time concern, injected here for the same reason the data is: a
     * spec carrying `width` cannot be re-rendered at another size, and being
     * re-renderable on every surface is the whole point of keeping one spec.
     * Only applied when the spec does not set its own size.
     */
    fit?: boolean;
    /** Height in px, same reasoning as `fit`. */
    height?: number;
    className?: string;
}

const DATASET = 'dive';

/** Brand-token Vega config (lemon/orange/maya/slate; success = maya, no green). */
function vegaConfig(theme: 'light' | 'dark') {
    const ink = theme === 'dark' ? '#ecf0f7' : '#1b2030';
    const grid = theme === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
    return {
        background: 'transparent',
        range: { category: ['#ffd84d', '#ff7a45', '#2eafff', '#ed5f22', '#aab3c5'] },
        axis: { labelColor: ink, titleColor: ink, gridColor: grid, domainColor: grid, tickColor: grid },
        legend: { labelColor: ink, titleColor: ink },
        title: { color: ink },
        view: { stroke: 'transparent' },
    };
}

export function VegaChart({
    spec,
    rows,
    theme = 'dark',
    fit,
    height,
    className = 'dive-chart',
}: VegaChartProps) {
    const elRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<Result['view'] | null>(null);
    const specKey = JSON.stringify(spec);

    // (Re)embed only when the spec or theme changes.
    useEffect(() => {
        const el = elRef.current;
        if (!el) return;
        let cancelled = false;
        let view: Result['view'] | null = null;
        void (async () => {
            try {
                const { default: embed } = await import('vega-embed');
                const full: Record<string, unknown> = rows
                    ? { ...spec, data: { name: DATASET }, datasets: { [DATASET]: rows } }
                    : { ...spec };
                if (fit && full.width === undefined) {
                    full.width = 'container';
                    full.autosize = { type: 'fit', contains: 'padding' };
                }
                if (height != null && full.height === undefined) full.height = height;
                const res = await embed(el, full as unknown as VisualizationSpec, {
                    actions: false,
                    renderer: 'canvas',
                    config: vegaConfig(theme),
                });
                if (cancelled) {
                    res.finalize();
                    return;
                }
                view = res.view;
                viewRef.current = res.view;
            } catch (e) {
                if (el) el.textContent = `Chart error: ${String(e)}`;
            }
        })();
        return () => {
            cancelled = true;
            if (view) view.finalize();
            viewRef.current = null;
        };
        // rows are rebound by the effect below; re-embedding on every row change
        // would throw away the chart state.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [specKey, theme, fit, height]);

    // Rebind data in place when only the rows change.
    useEffect(() => {
        const v = viewRef.current;
        if (!v || !rows) return;
        v.data(DATASET, rows);
        void v.runAsync();
    }, [rows]);

    return <div ref={elRef} className={className} />;
}
