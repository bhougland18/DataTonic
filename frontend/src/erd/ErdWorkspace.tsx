import { useEffect, useMemo, useState } from 'react';
import ErdEditor, { type ErdSavedModel } from './ErdEditor';
import type { ErdModel, ErdRelationship, ErdTable } from './model';
import './erd.css';

export interface ErdWorkspaceRequest {
    nonce: number;
    nodeId: string;
    nodeName?: string;
    tables: ErdTable[];
    relationships: ErdRelationship[];
    /** Tables whose edges the node has saved as hidden. */
    hiddenRelations?: string[];
    /** The layout the node last saved. */
    positions?: Record<string, { x: number; y: number }>;
}

interface ErdWorkspaceProps {
    openRequest: ErdWorkspaceRequest | null;
    onSave: (nodeId: string, model: ErdModel) => void;
    onClose: () => void;
    /** Enables the join library, which is stored per workspace and globally. */
    workspacePath?: string | null;
}

/**
 * ER-model authoring for the Working DB node (SE-11), rail-mounted for space.
 *
 * All the editing lives in `ErdEditor`, shared with the Blocks studio. What
 * remains here is the node binding: which node is open, where its tables come
 * from (the sources attached to that node, supplied in the open request), and
 * that Save writes back onto the node rather than into the workspace.
 */
export default function ErdWorkspace({
    openRequest,
    onSave,
    onClose,
    workspacePath,
}: ErdWorkspaceProps) {
    const [open, setOpen] = useState<ErdWorkspaceRequest | null>(null);
    const [lastNonce, setLastNonce] = useState(-1);

    useEffect(() => {
        if (!openRequest || openRequest.nonce === lastNonce) return;
        setLastNonce(openRequest.nonce);
        setOpen(openRequest);
    }, [openRequest, lastNonce]);

    // The node IS the store. Keyed by node id so opening a second Working DB
    // node re-seeds the editor rather than showing the first node's model.
    const persistence = useMemo(() => {
        const nodeId = open?.nodeId ?? '';
        const tables = open?.tables ?? [];
        return {
            key: `node:${nodeId}`,
            saveLabel: 'Save to node',
            load: async (): Promise<ErdSavedModel> => ({
                relationships: open?.relationships ?? [],
                hiddenRelations: open?.hiddenRelations ?? [],
                positions: open?.positions,
            }),
            save: async (model: ErdSavedModel) => {
                onSave(nodeId, {
                    tables,
                    relationships: model.relationships,
                    hiddenRelations: model.hiddenRelations,
                    positions: model.positions,
                });
                return true;
            },
        };
    }, [open, onSave]);

    if (!open) {
        return (
            <div className="erd-ws">
                <div className="erd-ws-empty">
                    Open a Working DB node to author its ER model here.
                </div>
            </div>
        );
    }

    return (
        <div className="erd-ws">
            <ErdEditor
                tables={open.tables}
                subtitle={open.nodeName ? `Working DB · ${open.nodeName}` : 'Working DB'}
                persistence={persistence}
                workspacePath={workspacePath}
                tourId="erd"
                extraActions={
                    <button className="erd-btn" onClick={onClose}>
                        Close
                    </button>
                }
            />
        </div>
    );
}
