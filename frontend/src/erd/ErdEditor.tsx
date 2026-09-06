import { useEffect, useState } from 'react';
import { Network, X, Save, Trash2, Wand2 } from 'lucide-react';
import ErDiagram from './ErDiagram';
import { inferRelationships, type ErdModel, type ErdRelationship, type ErdTable } from './model';
import './erd.css';

interface ErdEditorProps {
    open: boolean;
    nodeName?: string;
    tables: ErdTable[];
    initialRelationships: ErdRelationship[];
    onSave: (model: ErdModel) => void;
    onClose: () => void;
}

// Authoring surface for the Working DB's ER model (SE-11, 4c). Reuses the shared
// ErDiagram in editable mode: draw a relationship by dragging one column's
// right handle to another column's left handle; select an edge + Delete (or the
// list's trash) to remove. Save persists the model onto the Working DB node.
export default function ErdEditor({
    open,
    nodeName,
    tables,
    initialRelationships,
    onSave,
    onClose,
}: ErdEditorProps) {
    const [relationships, setRelationships] = useState<ErdRelationship[]>(initialRelationships);

    // Re-seed when a different node opens the editor.
    useEffect(() => {
        if (open) setRelationships(initialRelationships);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, nodeName]);

    if (!open) return null;

    const reinfer = () => setRelationships(inferRelationships(tables));
    const removeRel = (id: string) => setRelationships(rs => rs.filter(r => r.id !== id));

    return (
        <div className="erd-modal-backdrop" onMouseDown={onClose}>
            <div className="erd-modal" onMouseDown={e => e.stopPropagation()}>
                <div className="erd-modal-head">
                    <Network size={16} />
                    <div className="erd-modal-titles">
                        <b>ER Model</b>
                        <small>{nodeName ? `Working DB · ${nodeName}` : 'Working DB'}</small>
                    </div>
                    <span className="erd-modal-spacer" />
                    <button className="erd-btn" onClick={reinfer} title="Re-infer relationships from column names">
                        <Wand2 size={14} /> Auto-infer
                    </button>
                    <button className="erd-btn" onClick={onClose}>
                        Cancel
                    </button>
                    <button
                        className="erd-btn erd-btn--primary"
                        onClick={() => onSave({ tables, relationships })}
                    >
                        <Save size={14} /> Save to node
                    </button>
                    <button className="erd-modal-x" onClick={onClose} aria-label="Close">
                        <X size={16} />
                    </button>
                </div>

                <div className="erd-modal-body">
                    <ErDiagram
                        tables={tables}
                        relationships={relationships}
                        readOnly={false}
                        onRelationshipsChange={setRelationships}
                    />
                    <aside className="erd-modal-side">
                        <div className="erd-modal-side-head">
                            Relationships <span>{relationships.length}</span>
                        </div>
                        <div className="erd-modal-hint">
                            Drag a column&rsquo;s right dot to another column&rsquo;s left dot to add
                            a relationship.
                        </div>
                        {relationships.length === 0 ? (
                            <div className="erd-modal-empty">None yet.</div>
                        ) : (
                            <div className="erd-modal-rels">
                                {relationships.map(r => (
                                    <div className="erd-modal-rel" key={r.id}>
                                        <code>
                                            {r.fromTable}.{r.fromColumn} → {r.toTable}.{r.toColumn}
                                        </code>
                                        {r.inferred && <span className="tag">inferred</span>}
                                        <button
                                            className="erd-modal-rel-rm"
                                            onClick={() => removeRel(r.id)}
                                            aria-label="Remove relationship"
                                        >
                                            <Trash2 size={12} />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </aside>
                </div>
            </div>
        </div>
    );
}
