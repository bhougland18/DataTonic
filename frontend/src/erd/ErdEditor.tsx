// The ER-model editor, whole: toolbar, join library, diagram and relationship
// panel, plus the seed-merge-save lifecycle.
//
// Both hosts mount THIS, not its parts. They differ in exactly two ways, and
// both are parameters:
//
//   * where the tables come from — the Working DB node's attached sources, or
//     the workspace catalog's durable outputs. The host owns discovery and
//     passes `tables`.
//   * where the model is stored — a node property, or a file in the workspace.
//     The host passes an `ErdPersistence` adapter.
//
// Everything else — auto-arrange, per-table edge hiding, the join library,
// qualifiers, the merge rules — lives here so both surfaces have it by
// construction. They previously shared only the diagram and panel, which meant
// three capabilities existed on one surface and not the other purely because
// one host passed the optional props and the other did not.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Bookmark, Check, HelpCircle, LayoutGrid, Network, Save, Wand2 } from 'lucide-react';
import ErdAuthoring from './ErdAuthoring';
import JoinLibraryPanel from './JoinLibraryPanel';
import { maybeStartEditorTour, startEditorTour } from '../GuidedTour';
import { inferRelationships, mergeRelationships, type ErdRelationship, type ErdTable } from './model';
import {
    applicableJoins,
    loadJoinLibrary,
    removeJoin,
    saveJoinLibrary,
    toSavedJoin,
    upsertJoin,
    type JoinScope,
    type SavedJoin,
} from './join-library';
import './erd.css';

/** What a host stores and restores. Relationships and the hidden set — never
 *  tables, which the host re-discovers and which would go stale if copied. */
export interface ErdSavedModel {
    relationships: ErdRelationship[];
    hiddenRelations: string[];
    /** Canvas layout by table name. Optional so an older stored model, or a
     *  host that does not keep one, still loads. */
    positions?: Record<string, { x: number; y: number }>;
}

export interface ErdPersistence {
    /** Identifies WHAT is being edited. Changing it re-seeds — the Working DB
     *  editor stays mounted while you open a different node, and without this
     *  it would keep showing the previous node's model. */
    key: string;
    load: () => Promise<ErdSavedModel>;
    save: (model: ErdSavedModel) => Promise<boolean>;
    /** Save button text. The two hosts save to different places and say so. */
    saveLabel?: string;
}

export interface ErdEditorProps {
    tables: ErdTable[];
    subtitle?: string;
    persistence: ErdPersistence;
    /** Enables the join library. Omit to hide it entirely. */
    workspacePath?: string | null;
    /** Host buttons, placed left of Save (the node editor's Close). */
    extraActions?: ReactNode;
    /** Guided-tour id; omit for no help button. */
    tourId?: string;
    onError?: (message: string) => void;
    /**
     * Reports the current model whenever it changes, including after seeding.
     *
     * The editor OWNS the model; this is for hosts that also need to read it.
     * The Blocks SQL step builds queries from the relationships, so it keeps a
     * read-only mirror. Deliberately one-way: two owners of one document is how
     * the two surfaces drifted apart in the first place.
     */
    onModelChange?: (model: ErdSavedModel) => void;
}

export default function ErdEditor({
    tables,
    subtitle,
    persistence,
    workspacePath,
    extraActions,
    tourId,
    onError,
    onModelChange,
}: ErdEditorProps) {
    const [relationships, setRelationships] = useState<ErdRelationship[]>([]);
    const [hiddenRelations, setHiddenRelations] = useState<string[]>([]);
    const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
    const [library, setLibrary] = useState<SavedJoin[]>([]);
    const [libraryOpen, setLibraryOpen] = useState(false);
    const [arrangeNonce, setArrangeNonce] = useState(0);

    // The layout is held in TWO places on purpose.
    //
    // `loadedPositions` is what came from storage and is handed to the diagram
    // to restore. `livePositions` is a ref the diagram writes back to as the
    // user drags. Feeding drags back into the prop instead would re-enter the
    // diagram's restore effect on every drag and snap the viewport back.
    const [loadedPositions, setLoadedPositions] = useState<
        Record<string, { x: number; y: number }> | undefined
    >(undefined);
    const livePositions = useRef<Record<string, { x: number; y: number }>>({});

    // Seeding state as REFS, not state. Writing a flag inside the effect that
    // also depends on it makes the effect re-run and cancel its own in-flight
    // load — a bug this codebase has hit twice.
    const seededKey = useRef<string | null>(null);
    const seededWithColumns = useRef(false);

    // `load` and `save` are usually inline closures, so depending on them would
    // re-seed on every host render. `key` is the honest dependency.
    const io = useRef(persistence);
    io.current = persistence;

    const notify = useRef(onError);
    notify.current = onError;

    // Held in a ref so an inline closure from the host does not re-fire this.
    const report = useRef(onModelChange);
    report.current = onModelChange;
    useEffect(() => {
        report.current?.({ relationships, hiddenRelations });
    }, [relationships, hiddenRelations]);

    /**
     * Seed the model from storage, reconciled against the tables on screen.
     *
     * Re-seeds when the key changes (a different node), and ALSO once columns
     * arrive if the first seed ran without them. That second pass matters
     * because the two hosts differ: a Working DB node's tables carry their
     * columns immediately, while the Blocks catalog supplies names first and
     * columns later from a probe. `inferRelationships` matches on column names,
     * so seeding early would otherwise produce nothing and never retry.
     */
    useEffect(() => {
        if (tables.length === 0) return;
        const hasColumns = tables.some(t => t.columns.length > 0);
        const fresh = seededKey.current !== persistence.key;
        if (!fresh && (seededWithColumns.current || !hasColumns)) return;

        let cancelled = false;
        seededKey.current = persistence.key;
        seededWithColumns.current = hasColumns;

        void Promise.all([io.current.load(), loadJoinLibrary(workspacePath)])
            .then(([saved, lib]) => {
                if (cancelled) return;
                setLibrary(lib);
                setRelationships(
                    mergeRelationships(
                        saved.relationships,
                        inferRelationships(tables),
                        tables,
                        applicableJoins(lib, tables),
                    ),
                );
                setHiddenRelations(saved.hiddenRelations);
                setLoadedPositions(saved.positions);
                livePositions.current = saved.positions ?? {};
                setSaveState('idle');
            })
            .catch(() => {
                // A model we cannot read must not block authoring a new one.
                if (!cancelled) setRelationships(inferRelationships(tables));
            });
        return () => {
            cancelled = true;
        };
    }, [persistence.key, tables, workspacePath]);

    useEffect(() => {
        if (tourId) maybeStartEditorTour(tourId);
    }, [tourId, persistence.key]);

    const edit = useCallback((next: ErdRelationship[]) => {
        setRelationships(next);
        setSaveState('idle');
    }, []);

    const reinfer = useCallback(() => edit(inferRelationships(tables)), [edit, tables]);

    const toggleRelations = useCallback((table: string) => {
        setHiddenRelations(prev =>
            prev.includes(table) ? prev.filter(t => t !== table) : [...prev, table],
        );
        setSaveState('idle');
    }, []);

    const save = useCallback(async () => {
        setSaveState('saving');
        const ok = await io.current.save({
            relationships,
            hiddenRelations,
            positions: livePositions.current,
        });
        setSaveState(ok ? 'saved' : 'idle');
        if (!ok) notify.current?.('Could not save the ER model.');
    }, [relationships, hiddenRelations]);

    /** A moved table is unsaved work, so Save stops reading as done. */
    const onPositionsChange = useCallback((p: Record<string, { x: number; y: number }>) => {
        livePositions.current = p;
        setSaveState(s => (s === 'saved' ? 'idle' : s));
    }, []);

    // ---- Join library ----

    // One place writes both stores (the workspace file and localStorage), so
    // they cannot drift from what is on screen.
    const commitLibrary = useCallback(
        (next: SavedJoin[]) => {
            setLibrary(next);
            void saveJoinLibrary(workspacePath, next);
        },
        [workspacePath],
    );

    const savedJoinIds = useMemo(() => new Set(library.map(j => j.id)), [library]);

    const saveJoins = useCallback(
        (rels: ErdRelationship[]) => {
            // Workspace scope by default. Promoting to global is a deliberate
            // second step: a join that works here is not yet a claim about
            // every future engagement.
            let next = library;
            for (const r of rels) next = upsertJoin(next, toSavedJoin(r, 'workspace'));
            commitLibrary(next);
            setLibraryOpen(true);
        },
        [library, commitLibrary],
    );

    const applyJoin = useCallback((join: SavedJoin) => {
        setRelationships(prev =>
            prev.some(r => r.id === join.id)
                ? prev
                : [
                      ...prev,
                      {
                          id: join.id,
                          fromTable: join.fromTable,
                          fromColumn: join.fromColumn,
                          toTable: join.toTable,
                          toColumn: join.toColumn,
                          qualifiers: join.qualifiers,
                          inferred: false,
                      },
                  ],
        );
        setSaveState('idle');
    }, []);

    const rescopeJoin = useCallback(
        (join: SavedJoin, scope: JoinScope) =>
            commitLibrary(upsertJoin(removeJoin(library, join.id, join.scope), { ...join, scope })),
        [library, commitLibrary],
    );

    return (
        <div className="erd-ed">
            <div className="erd-ws-top">
                <span className="erd-ws-glyph">
                    <Network size={15} />
                </span>
                <div className="erd-ws-titles">
                    <b>ER Model</b>
                    {subtitle ? <small>{subtitle}</small> : null}
                </div>
                <span className="erd-ws-spacer" />
                {tourId ? (
                    <button
                        type="button"
                        className="editor-help-btn"
                        onClick={() => startEditorTour(tourId)}
                        title="Show the ER Model tour"
                        aria-label="Show the ER Model tour"
                    >
                        <HelpCircle size={16} />
                    </button>
                ) : null}
                {workspacePath !== undefined ? (
                    <button
                        className={`erd-btn${libraryOpen ? ' erd-btn--on' : ''}`}
                        onClick={() => setLibraryOpen(o => !o)}
                        title="Saved joins you can reuse here and in other workspaces"
                    >
                        <Bookmark size={14} /> Library
                        {library.length > 0 ? ` (${library.length})` : ''}
                    </button>
                ) : null}
                <button
                    className="erd-btn"
                    onClick={() => setArrangeNonce(n => n + 1)}
                    title="Arrange the tables by how they connect"
                >
                    <LayoutGrid size={14} /> Arrange
                </button>
                <button
                    className="erd-btn"
                    onClick={reinfer}
                    title="Re-infer all relationships from column names"
                    data-tour="erd-infer"
                >
                    <Wand2 size={14} /> Auto-infer all
                </button>
                {extraActions}
                <button
                    className="erd-btn erd-btn--primary"
                    onClick={() => void save()}
                    disabled={saveState !== 'idle'}
                    data-tour="erd-save"
                >
                    {saveState === 'saved' ? (
                        <>
                            <Check size={14} /> Saved
                        </>
                    ) : (
                        <>
                            <Save size={14} />{' '}
                            {saveState === 'saving'
                                ? 'Saving…'
                                : (persistence.saveLabel ?? 'Save model')}
                        </>
                    )}
                </button>
            </div>

            <div className="erd-ed-body">
                {libraryOpen ? (
                    <JoinLibraryPanel
                        joins={library}
                        tables={tables}
                        onApply={applyJoin}
                        onRemove={(id, scope) => commitLibrary(removeJoin(library, id, scope))}
                        onRescope={rescopeJoin}
                        onExport={() => void exportLibrary()}
                        onImport={() => void importLibrary()}
                        onClose={() => setLibraryOpen(false)}
                    />
                ) : null}
                <ErdAuthoring
                    tables={tables}
                    relationships={relationships}
                    onRelationshipsChange={edit}
                    hiddenRelations={hiddenRelations}
                    onToggleRelations={toggleRelations}
                    arrangeNonce={arrangeNonce}
                    onSaveJoins={saveJoins}
                    savedJoinIds={savedJoinIds}
                    positions={loadedPositions}
                    onPositionsChange={onPositionsChange}
                />
            </div>
        </div>
    );

    async function importLibrary() {
        try {
            const { importJoinLibrary } = await import('./join-library');
            const imported = await importJoinLibrary();
            if (!imported) return;
            let next = library;
            for (const j of imported) next = upsertJoin(next, j);
            commitLibrary(next);
        } catch (e) {
            notify.current?.(e instanceof Error ? e.message : String(e));
        }
    }

    async function exportLibrary() {
        const { exportJoinLibrary } = await import('./join-library');
        const res = await exportJoinLibrary(library);
        if (res !== 'ok' && res !== 'cancelled') notify.current?.(`Export failed: ${res}`);
    }
}
