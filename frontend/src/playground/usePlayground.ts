// State for the API Playground: the imported spec, parse errors, the selected
// endpoint, and the persistence outcome. Kept in its own hook (mirroring the
// rail's useAppMode) so App.tsx stays untouched beyond mounting the module.

import { useCallback, useState } from 'react';
import { parseSpec } from './specParser';
import { persistSpec, persistenceAvailable } from './specPersistence';
import type { ImportedText } from './specSource';
import type { ParsedSpec, SpecParseIssue, SpecSource } from './types';

export type PlaygroundStatus = 'empty' | 'parsing' | 'ready' | 'error';
export type PersistStatus = 'idle' | 'saving' | 'saved' | 'unavailable' | 'failed';

export interface PlaygroundState {
    status: PlaygroundStatus;
    spec: ParsedSpec | null;
    source: SpecSource | null;
    errors: SpecParseIssue[];
    selectedId: string | null;
    persist: { status: PersistStatus; path?: string; detail?: string };
    importSpec: (input: ImportedText) => Promise<void>;
    // Surface a pre-parse failure (e.g. a failed URL fetch or file read) using
    // the same error channel a parse failure uses.
    reportError: (issues: SpecParseIssue[]) => void;
    setSelectedId: (id: string | null) => void;
    reset: () => void;
}

export function usePlayground(workspacePath: string | null): PlaygroundState {
    const [status, setStatus] = useState<PlaygroundStatus>('empty');
    const [spec, setSpec] = useState<ParsedSpec | null>(null);
    const [source, setSource] = useState<SpecSource | null>(null);
    const [errors, setErrors] = useState<SpecParseIssue[]>([]);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [persist, setPersist] = useState<PlaygroundState['persist']>({ status: 'idle' });

    const importSpec = useCallback(
        async (input: ImportedText) => {
            setStatus('parsing');
            setErrors([]);
            setPersist({ status: 'idle' });

            const outcome = await parseSpec(input.text);
            if (!outcome.ok) {
                setSpec(null);
                setSource(null);
                setSelectedId(null);
                setErrors(outcome.errors);
                setStatus('error');
                return;
            }

            setSpec(outcome.spec);
            setSource(input.source);
            setSelectedId(outcome.spec.endpoints[0]?.id ?? null);
            setStatus('ready');

            // Persist as a workspace file (PL-6). Absence of a backend (plain
            // browser dev) is reported, not silently swallowed.
            if (!persistenceAvailable() || !workspacePath) {
                setPersist({ status: 'unavailable' });
                return;
            }
            setPersist({ status: 'saving' });
            try {
                const res = await persistSpec(workspacePath, {
                    source: input.source,
                    raw: input.text,
                    spec: outcome.spec,
                });
                setPersist({ status: 'saved', path: res.path });
            } catch (err) {
                setPersist({ status: 'failed', detail: (err as Error).message });
            }
        },
        [workspacePath],
    );

    const reportError = useCallback((issues: SpecParseIssue[]) => {
        setSpec(null);
        setSource(null);
        setSelectedId(null);
        setPersist({ status: 'idle' });
        setErrors(issues);
        setStatus('error');
    }, []);

    const reset = useCallback(() => {
        setStatus('empty');
        setSpec(null);
        setSource(null);
        setErrors([]);
        setSelectedId(null);
        setPersist({ status: 'idle' });
    }, []);

    return { status, spec, source, errors, selectedId, persist, importSpec, reportError, setSelectedId, reset };
}
