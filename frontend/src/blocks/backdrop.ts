// Dismissing a dialog by clicking away, without dismissing it by accident.
//
// The obvious version is `onClick={e => e.target === e.currentTarget && close()}`
// and every dialog here had it. It has a real failure, and it is one people hit
// constantly without being able to describe it:
//
//   **Select-all-by-dragging inside a text field, and release past the edge of
//   the dialog.** A `click` fires on the nearest common ancestor of where the
//   mouse went DOWN and where it came UP. Down on the input, up on the
//   backdrop, and the common ancestor IS the backdrop — so `target` really does
//   equal `currentTarget`, the check passes, and the dialog closes taking the
//   half-typed name with it.
//
// It only happens when somebody drags far enough to overshoot, which is why it
// reads as random. Reported against the transformation dialog, where the name
// field invites exactly that gesture.
//
// The fix is to ask where the gesture STARTED. A click-away is a press on the
// backdrop followed by a release on the backdrop; anything that began inside
// the dialog is not a click-away however far the mouse travelled.

import { useCallback, useMemo } from 'react';

/** Just the part of an event this needs, so the logic is testable as itself. */
export interface Hit {
    target: unknown;
    currentTarget: unknown;
}

export interface BackdropProps {
    onMouseDown: (e: Hit) => void;
    onClick: (e: Hit) => void;
}

/**
 * The gesture tracker, with no React in it.
 *
 * Separated from the hook so the rule can be tested as the thing that actually
 * runs, rather than as a copy of it in a test file — this is a bug that will
 * regress silently, and a test that re-implements the logic would keep passing
 * while the dialog started closing again.
 */
export function backdropGesture(onDismiss: () => void): BackdropProps {
    let startedOnBackdrop = false;
    return {
        onMouseDown: e => {
            startedOnBackdrop = e.target === e.currentTarget;
        },
        onClick: e => {
            const away = startedOnBackdrop && e.target === e.currentTarget;
            // Cleared either way, so a press on the backdrop released somewhere
            // else does not leave the NEXT click armed.
            startedOnBackdrop = false;
            if (away) onDismiss();
        },
    };
}

export function useBackdropDismiss(onDismiss: () => void): BackdropProps {
    // The callback is wrapped so the tracker survives re-renders: rebuilding it
    // on every render would reset the flag between the press and the release,
    // which is the whole state it keeps.
    const stable = useCallback(() => onDismiss(), [onDismiss]);
    return useMemo(() => backdropGesture(stable), [stable]);
}
