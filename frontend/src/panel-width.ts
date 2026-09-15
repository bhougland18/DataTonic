import { loadPersisted, savePersisted } from './persistence';

// Width of the builder's left panel, persisted locally and applied by setting
// the --builder-panel-w CSS variable on the root element. Deliberately the same
// shape as `font-size.ts`, which does this for --app-font-size.
//
// ONE value drives three panels — the Sources step, the SQL step and the node's
// SQL Studio sidebar — because switching steps should move the content, not the
// layout. That is also why this lives here rather than as component state: a
// panel that owned its own width would resize only itself, and the jump between
// steps is exactly what the shared value exists to prevent.
//
// Bounded so the layout stays usable. The floor is the point below which the
// filter rows stop being readable at all; the ceiling leaves the SQL enough
// room to still be the thing you are editing.
export const DEFAULT_PANEL_WIDTH = 300;
export const MIN_PANEL_WIDTH = 220;
export const MAX_PANEL_WIDTH = 560;

export function getPanelWidth(): number {
    const v = loadPersisted('builderPanelWidth', DEFAULT_PANEL_WIDTH);
    return typeof v === 'number' && v >= MIN_PANEL_WIDTH && v <= MAX_PANEL_WIDTH
        ? v
        : DEFAULT_PANEL_WIDTH;
}

export function applyPanelWidth(px: number): void {
    document.documentElement.style.setProperty('--builder-panel-w', `${px}px`);
}

export function clampPanelWidth(px: number): number {
    return Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, Math.round(px)));
}

/**
 * Clamp and apply, WITHOUT persisting.
 *
 * Used while dragging, which fires on every pointer move: writing to storage a
 * hundred times a second to record states nobody stopped at is waste. The
 * value is saved once, on release.
 */
export function previewPanelWidth(px: number): number {
    const clamped = clampPanelWidth(px);
    applyPanelWidth(clamped);
    return clamped;
}

/** Clamp, persist and apply; returns the value actually used. */
export function setPanelWidth(px: number): number {
    const clamped = clampPanelWidth(px);
    savePersisted('builderPanelWidth', clamped);
    applyPanelWidth(clamped);
    return clamped;
}
