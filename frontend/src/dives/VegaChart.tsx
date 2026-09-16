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

/**
 * Top-level keys that make a spec MULTI-VIEW rather than a single chart.
 *
 * Worth knowing here because Vega-Lite refuses `width: 'container'` and
 * `autosize: 'fit'` on all of them — it warns twice and ignores both, and the
 * chart renders at whatever its inner view asked for. Measured: a faceted
 * sparkline table drew at 150px inside a 760px panel, with nothing in the
 * console the app surfaces.
 */
const COMPOSED_KEYS = ['facet', 'concat', 'hconcat', 'vconcat', 'repeat'];

const isComposed = (spec: Record<string, unknown>) => COMPOSED_KEYS.some(k => k in spec);

/** Below this a panel is not a chart any more, however narrow the container. */
const MIN_CHILD_WIDTH = 40;

/**
 * Size a composed view to its container, by measuring rather than by asking.
 *
 * Vega-Lite compiles `facet` and `repeat` to a Vega spec whose inner panel
 * width is the `child_width` signal, and the CHROME around it — the row header,
 * the axis, the padding — is a constant that does not move when the panel
 * does. So one correction is exact: render once, read what the whole scene
 * actually spans, and the difference is the chrome.
 *
 * Measured off the SCENEGRAPH, not the DOM. The wrapper element reports a stale
 * width straight after a re-run, which reads as "the fit did nothing" when the
 * fit has in fact already worked.
 *
 * And it has to be measured, not reserved: the chrome was 49px for `Apples` and
 * 130px for `Wound Care Consumables` in the same layout. Any fixed allowance is
 * wrong for one of them.
 *
 * Idempotent, so it doubles as the resize handler — it reads the current
 * `child_width` back out of the view rather than tracking it here.
 */
async function fitComposed(view: Result['view'], available: number): Promise<void> {
    let child: unknown;
    try {
        child = view.signal('child_width');
    } catch {
        // A composed spec whose inner width is not a signal (an explicit size,
        // or a `concat` of differently-sized views). It asked for a size; leave
        // it at it.
        return;
    }
    if (typeof child !== 'number' || !Number.isFinite(available) || available <= 0) return;
    // `Scene` is typed as the root mark rather than the wrapper vega actually
    // returns, so the shape is asserted here rather than fought with.
    const scene = view.scenegraph() as unknown as {
        root?: { bounds?: { x1: number; x2: number } };
    };
    const bounds = scene.root?.bounds;
    if (!bounds) return;
    const chrome = bounds.x2 - bounds.x1 - child;
    const target = Math.max(MIN_CHILD_WIDTH, available - chrome);
    // Sub-pixel churn is not worth a re-render, and this runs on every resize.
    if (Math.abs(target - child) < 1) return;
    view.signal('child_width', target);
    await view.runAsync();
}

/** Brand-token Vega config (lemon/orange/maya/slate; success = maya, no green). */
function vegaConfig(theme: 'light' | 'dark') {
    const ink = theme === 'dark' ? '#ecf0f7' : '#1b2030';
    const grid = theme === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
    return {
        background: 'transparent',
        range: { category: ['#ffd84d', '#ff7a45', '#2eafff', '#ed5f22', '#aab3c5'] },
        axis: { labelColor: ink, titleColor: ink, gridColor: grid, domainColor: grid, tickColor: grid },
        legend: { labelColor: ink, titleColor: ink },
        // A facet's row/column labels are `header`, not `axis` — a separate
        // config family that nothing needed until the sparkline table arrived.
        // Without it the labels keep Vega's near-black default and vanish into
        // the dark theme, which reads as a rendering fault rather than a
        // missing setting.
        header: { labelColor: ink, titleColor: ink },
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
        let observer: ResizeObserver | null = null;
        void (async () => {
            try {
                const { default: embed } = await import('vega-embed');
                const full: Record<string, unknown> = rows
                    ? { ...spec, data: { name: DATASET }, datasets: { [DATASET]: rows } }
                    : { ...spec };
                const composed = isComposed(full);
                if (fit && full.width === undefined) {
                    if (composed) {
                        // `'container'` is refused here, so the inner panel gets
                        // a NUMBER — the container width as a first guess, which
                        // overshoots by the chrome and is corrected below.
                        const inner = full.spec;
                        if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
                            const child = inner as Record<string, unknown>;
                            if (child.width === undefined) child.width = el.clientWidth;
                            full.spec = child;
                        }
                    } else {
                        full.width = 'container';
                        full.autosize = { type: 'fit', contains: 'padding' };
                    }
                }
                // A composed spec sizes itself per panel; a top-level height is
                // as unwelcome there as a top-level width.
                if (height != null && full.height === undefined && !composed) full.height = height;
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
                if (composed && fit) {
                    await fitComposed(res.view, el.clientWidth);
                    // The panel is resizable — collapsing the dives rail changes
                    // it — and nothing re-embeds for that. `width: 'container'`
                    // handles the single-view case itself; this is the other one.
                    observer = new ResizeObserver(() => {
                        void fitComposed(res.view, el.clientWidth);
                    });
                    observer.observe(el);
                }
            } catch (e) {
                if (el) el.textContent = `Chart error: ${String(e)}`;
            }
        })();
        return () => {
            cancelled = true;
            observer?.disconnect();
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
