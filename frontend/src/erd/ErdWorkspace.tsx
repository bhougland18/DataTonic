import { useEffect, useState } from 'react';
import { Network, Save, Wand2, HelpCircle } from 'lucide-react';
import ErdAuthoring from './ErdAuthoring';
import { maybeStartEditorTour, startEditorTour } from '../GuidedTour';
import {
    inferRelationships,
    type ErdModel,
    type ErdRelationship,
    type ErdTable,
} from './model';
import './erd.css';

export interface ErdWorkspaceRequest {
    nonce: number;
    nodeId: string;
    nodeName?: string;
    tables: ErdTable[];
    relationships: ErdRelationship[];
}

interface ErdWorkspaceProps {
    openRequest: ErdWorkspaceRequest | null;
    onSave: (nodeId: string, model: ErdModel) => void;
    onClose: () => void;
}

// Full-surface ER-model authoring for the Working DB (SE-11). Rail-mounted for
// space. Draw a relationship by dragging one table onto another (join column
// auto-inferred), or add an exact From→To pair with the (searchable) form.
// Relationships are grouped by table pair; edges on the diagram aggregate per
// pair and clicking one filters the list. Save persists onto the node.
//
// The diagram and relationship panel live in `ErdAuthoring`, shared with the
// Blocks studio. What remains here is the node binding: which node's model is
// open, and that Save writes back to it.
export default function ErdWorkspace({ openRequest, onSave, onClose }: ErdWorkspaceProps) {
    const [nodeId, setNodeId] = useState<string | null>(null);
    const [nodeName, setNodeName] = useState<string | undefined>(undefined);
    const [tables, setTables] = useState<ErdTable[]>([]);
    const [relationships, setRelationships] = useState<ErdRelationship[]>([]);
    const [lastNonce, setLastNonce] = useState(-1);

    useEffect(() => {
        if (!openRequest || openRequest.nonce === lastNonce) return;
        setLastNonce(openRequest.nonce);
        setNodeId(openRequest.nodeId);
        setNodeName(openRequest.nodeName);
        setTables(openRequest.tables);
        setRelationships(openRequest.relationships);
        // First time this editor is opened, walk the ER Model tour once.
        maybeStartEditorTour('erd');
    }, [openRequest, lastNonce]);

    if (nodeId == null) {
        return (
            <div className="erd-ws">
                <div className="erd-ws-empty">
                    Open a Working DB node to author its ER model here.
                </div>
            </div>
        );
    }

    const reinfer = () => setRelationships(inferRelationships(tables));

    return (
        <div className="erd-ws">
            <div className="erd-ws-top">
                <span className="erd-ws-glyph">
                    <Network size={15} />
                </span>
                <div className="erd-ws-titles">
                    <b>ER Model</b>
                    <small>{nodeName ? `Working DB · ${nodeName}` : 'Working DB'}</small>
                </div>
                <span className="erd-ws-spacer" />
                <button
                    type="button"
                    className="editor-help-btn"
                    onClick={() => startEditorTour('erd')}
                    title="Show the ER Model tour"
                    aria-label="Show the ER Model tour"
                >
                    <HelpCircle size={16} />
                </button>
                <button
                    className="erd-btn"
                    onClick={reinfer}
                    title="Re-infer all relationships"
                    data-tour="erd-infer"
                >
                    <Wand2 size={14} /> Auto-infer all
                </button>
                <button className="erd-btn" onClick={onClose}>
                    Close
                </button>
                <button
                    className="erd-btn erd-btn--primary"
                    onClick={() => onSave(nodeId, { tables, relationships })}
                    data-tour="erd-save"
                >
                    <Save size={14} /> Save to node
                </button>
            </div>

            <ErdAuthoring
                tables={tables}
                relationships={relationships}
                onRelationshipsChange={setRelationships}
            />
        </div>
    );
}
