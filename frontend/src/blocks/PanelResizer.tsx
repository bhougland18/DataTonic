// The drag handle on the builder panel's right edge.
//
// Writes the shared `--builder-panel-w`, so dragging here also moves the
// Sources panel and the node's SQL Studio sidebar. That is the point: they are
// one panel in three places, and resizing only the one you happen to be looking
// at would reintroduce the step-to-step jump the shared width removed.
//
// Pointer events with `setPointerCapture` rather than window listeners: capture
// keeps the drag alive when the pointer leaves the handle — which it
// immediately does, since the handle is four pixels wide — and releases it
// automatically if the gesture is cancelled. No listeners to leak.

import { useCallback, useRef } from 'react';
import {
    DEFAULT_PANEL_WIDTH,
    getPanelWidth,
    previewPanelWidth,
    setPanelWidth,
} from '../panel-width';

export default function PanelResizer() {
    // Not state. Nothing renders from these, and re-rendering the whole panel
    // on every pointer move to store a number would make the drag stutter.
    const startX = useRef(0);
    const startWidth = useRef(0);

    const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        // Left button only: a right-click here should open the context menu,
        // not silently begin a drag that the matching pointerup never ends.
        if (e.button !== 0) return;
        e.preventDefault();
        startX.current = e.clientX;
        startWidth.current = getPanelWidth();
        e.currentTarget.setPointerCapture(e.pointerId);
    }, []);

    const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
        previewPanelWidth(startWidth.current + (e.clientX - startX.current));
    }, []);

    const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
        e.currentTarget.releasePointerCapture(e.pointerId);
        // Saved once, at the end. The drag has already applied every
        // intermediate width; only the one it stopped at is worth keeping.
        setPanelWidth(startWidth.current + (e.clientX - startX.current));
    }, []);

    return (
        <div
            className="blk-resizer"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            // The way back from a width somebody dragged too far and cannot
            // easily undo — the same gesture that resets a column in a grid.
            onDoubleClick={() => setPanelWidth(DEFAULT_PANEL_WIDTH)}
            title="Drag to resize — double-click to reset"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the builder panel"
        />
    );
}
