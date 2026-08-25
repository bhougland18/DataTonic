import { useCallback, useState } from 'react';
import type { AppMode } from './types';
import { RAIL_MODES } from './types';

// Holds the active rail mode. Kept in its own hook rather than App.tsx's main
// state block so the rail feature stays isolated from upstream churn in App.tsx.
export function useAppMode(initial: AppMode = 'canvas') {
    const [mode, setModeState] = useState<AppMode>(initial);

    const setMode = useCallback((next: AppMode) => {
        // Selecting a not-yet-implemented mode is a no-op (RAIL-5): the icon is
        // shown but disabled, so this is a defensive guard.
        const meta = RAIL_MODES.find((m) => m.id === next);
        if (!meta || !meta.enabled) return;
        setModeState(next);
    }, []);

    return { mode, setMode };
}
