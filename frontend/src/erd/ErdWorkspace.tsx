import { useEffect, useMemo, useState } from 'react';
import { Network, Save, Wand2, Trash2, Plus, ArrowRight } from 'lucide-react';
import ErDiagram from './ErDiagram';
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

const relId = (r: Omit<ErdRelationship, 'id'>) =>
    `${r.fromTable}.${r.fromColumn}->${r.toTable}.${r.toColumn}`;

// Full-surface ER-model authoring for the Working DB (SE-11). Rail-mounted (not
// a modal) for space. Draw a relationship by dragging one table onto another
// (the join column is auto-inferred), or add an exact From→To pair with the
// form for custom joins — a table pair can hold many. Save persists onto the
// Working DB node; downstream Studios inherit it.
export default function ErdWorkspace({ openRequest, onSave, onClose }: ErdWorkspaceProps) {
    const [nodeId, setNodeId] = useState<string | null>(null);
    const [nodeName, setNodeName] = useState<string | undefined>(undefined);
    const [tables, setTables] = useState<ErdTable[]>([]);
    const [relationships, setRelationships] = useState<ErdRelationship[]>([]);
    const [lastNonce, setLastNonce] = useState(-1);

    // Add-relationship form state.
    const [fromTable, setFromTable] = useState('');
    const [fromCol, setFromCol] = useState('');
    const [toTable, setToTable] = useState('');
    const [toCol, setToCol] = useState('');

    useEffect(() => {
        if (!openRequest || openRequest.nonce === lastNonce) return;
        setLastNonce(openRequest.nonce);
        setNodeId(openRequest.nodeId);
        setNodeName(openRequest.nodeName);
        setTables(openRequest.tables);
        setRelationships(openRequest.relationships);
        setFromTable(openRequest.tables[0]?.name ?? '');
        setToTable(openRequest.tables[1]?.name ?? openRequest.tables[0]?.name ?? '');
        setFromCol('');
        setToCol('');
    }, [openRequest, lastNonce]);

    const colsOf = useMemo(
        () => (name: string) => tables.find(t => t.name === name)?.columns ?? [],
        [tables],
    );

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
    const removeRel = (id: string) => setRelationships(rs => rs.filter(r => r.id !== id));
    const addManual = () => {
        if (!fromTable || !fromCol || !toTable || !toCol) return;
        const base = {
            fromTable,
            fromColumn: fromCol,
            toTable,
            toColumn: toCol,
            inferred: false,
        };
        const id = relId(base);
        setRelationships(rs => (rs.some(r => r.id === id) ? rs : [...rs, { id, ...base }]));
    };

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
                <button className="erd-btn" onClick={reinfer} title="Re-infer all relationships">
                    <Wand2 size={14} /> Auto-infer all
                </button>
                <button className="erd-btn" onClick={onClose}>
                    Close
                </button>
                <button
                    className="erd-btn erd-btn--primary"
                    onClick={() => onSave(nodeId, { tables, relationships })}
                >
                    <Save size={14} /> Save to node
                </button>
            </div>

            <div className="erd-ws-body">
                <ErDiagram
                    tables={tables}
                    relationships={relationships}
                    readOnly={false}
                    onRelationshipsChange={setRelationships}
                />
                <aside className="erd-ws-side">
                    <div className="erd-ws-side-head">
                        Relationships <span>{relationships.length}</span>
                    </div>

                    <div className="erd-ws-add">
                        <div className="erd-ws-add-row">
                            <select value={fromTable} onChange={e => setFromTable(e.target.value)}>
                                {tables.map(t => (
                                    <option key={t.name} value={t.name}>
                                        {t.name}
                                    </option>
                                ))}
                            </select>
                            <select value={fromCol} onChange={e => setFromCol(e.target.value)}>
                                <option value="">column…</option>
                                {colsOf(fromTable).map(c => (
                                    <option key={c.name} value={c.name}>
                                        {c.name}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <div className="erd-ws-add-arrow">
                            <ArrowRight size={13} />
                        </div>
                        <div className="erd-ws-add-row">
                            <select value={toTable} onChange={e => setToTable(e.target.value)}>
                                {tables.map(t => (
                                    <option key={t.name} value={t.name}>
                                        {t.name}
                                    </option>
                                ))}
                            </select>
                            <select value={toCol} onChange={e => setToCol(e.target.value)}>
                                <option value="">column…</option>
                                {colsOf(toTable).map(c => (
                                    <option key={c.name} value={c.name}>
                                        {c.name}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <button
                            className="erd-btn erd-ws-add-btn"
                            onClick={addManual}
                            disabled={!fromCol || !toCol}
                        >
                            <Plus size={13} /> Add relationship
                        </button>
                    </div>

                    <div className="erd-ws-hint">
                        Or drag a table onto another on the diagram — the join column is
                        auto-inferred.
                    </div>

                    {relationships.length === 0 ? (
                        <div className="erd-ws-empty-list">No relationships yet.</div>
                    ) : (
                        <div className="erd-ws-rels">
                            {relationships.map(r => (
                                <div className="erd-ws-rel" key={r.id}>
                                    <code>
                                        {r.fromTable}.{r.fromColumn} → {r.toTable}.{r.toColumn}
                                    </code>
                                    {r.inferred && <span className="tag">inferred</span>}
                                    <button
                                        className="erd-ws-rel-rm"
                                        onClick={() => removeRel(r.id)}
                                        aria-label="Remove"
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
    );
}
