// Drawing a dropdown that is not clipped by the panel it lives in.
//
// Extracted because two pickers now need it and the reasoning behind it is not
// guessable from the code. Both facts here were found the hard way and are
// recorded in `blocks-erd-handoff.md` §4:
//
//   * A popup inside `overflow: auto` is CLIPPED, z-index regardless. The
//     accordion sections scroll, so anything positioned inside one is cut off
//     at the section's edge. The list has to be portalled to `body` and
//     positioned `fixed` in viewport coordinates.
//
//   * Because it is fixed, it has to be REPOSITIONED on scroll — and the
//     listener has to be on the CAPTURE phase, because the section scrolls
//     rather than the window, so the event never bubbles up to us.
//
// Written twice, these would be wrong in one of the two places eventually.

import { useEffect, useLayoutEffect, useState, type RefObject } from 'react';

export interface PopupRect {
    left: number;
    top: number;
    width: number;
}

/** Tallest a portalled list may be, and the room it needs to open downwards. */
const MAX_HEIGHT = 220;
const MIN_ROOM_BELOW = 160;

/**
 * Where to draw an anchored dropdown, in viewport coordinates.
 *
 * Flips above the anchor when there is more room there — near the bottom of a
 * laptop screen a list that always opened downwards opened off-screen.
 */
export function useAnchoredPopup(
    open: boolean,
    anchor: RefObject<HTMLElement | null>,
): PopupRect | null {
    const [at, setAt] = useState<PopupRect | null>(null);

    useLayoutEffect(() => {
        if (!open) return;
        const place = () => {
            const r = anchor.current?.getBoundingClientRect();
            if (!r) return;
            const below = window.innerHeight - r.bottom;
            const height = Math.min(MAX_HEIGHT, below > MIN_ROOM_BELOW ? below - 8 : r.top - 8);
            setAt({
                left: r.left,
                top: below > MIN_ROOM_BELOW ? r.bottom + 2 : r.top - height - 2,
                width: r.width,
            });
        };
        place();
        window.addEventListener('scroll', place, true);
        window.addEventListener('resize', place);
        return () => {
            window.removeEventListener('scroll', place, true);
            window.removeEventListener('resize', place);
        };
    }, [open, anchor]);

    return at;
}

/**
 * Close when the mouse goes down anywhere that is not the field or its list.
 *
 * `listClass` is needed because the list is portalled OUT of the anchor, so
 * `anchor.contains(target)` is false for a click on the list itself — which
 * would close the popup before the click could land on an option.
 */
export function useClickAway(
    open: boolean,
    anchor: RefObject<HTMLElement | null>,
    listClass: string,
    onAway: () => void,
): void {
    useEffect(() => {
        if (!open) return;
        const away = (e: MouseEvent) => {
            const t = e.target as Node;
            const inList = (t as HTMLElement).closest?.(`.${listClass}`);
            if (anchor.current && !anchor.current.contains(t) && !inList) onAway();
        };
        document.addEventListener('mousedown', away);
        return () => document.removeEventListener('mousedown', away);
    }, [open, anchor, listClass, onAway]);
}
