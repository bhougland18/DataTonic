import { useEffect, useMemo, useState } from 'react';
import { Network, Save, Wand2, Trash2, Plus, ArrowRight, X } from 'lucide-react';
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

interface Pair {
    a: string;
    b: string;
}
interface PairGroup extends Pair {
    key: string;
    rels: ErdRelationship[];
}

const relId = (r: Omit<ErdRelationship, 'id'>) =>
    `${r.fromTable}.${r.fromColumn}->${r.toTable}.${r.toColumn}`;

const samePair = (g: Pair, p: Pair) => {
    const [ga, gb] = [g.a.toLowerCase(), g.b.toLowerCase()];
    const [pa, pb] = [p.a.toLowerCase(), p.b.toLowerCase()];
    return (ga === pa && gb === pb) || (ga === pb && gb === pa);
};

// Full-surface ER-model authoring for the Working DB (SE-11). Rail-mounted for
// space. Draw a relationship by dragging one table onto another (join column
// auto-inferred), or add an exact From→To pair with the (searchable) form.
// Relationships are grouped by table pair; edges on the diagram aggregate per
// pair and clicking one filters the list. Save persists onto the node.
export default function ErdWorkspace({ openRequest, onSave, onClose }: ErdWorkspaceProps) {
    const [nodeId, setNodeId] = useState<string | null>(null);
    const [nodeName, setNodeName] = useState<string | undefined>(undefined);
    const [tables, setTables] = useState<ErdTable[]>([]);
    const [relationships, setRelationships] = useState<ErdRelationship[]>([]);
    const [lastNonce, setLastNonce] = useState(-1);
    const [selectedPair, setSelectedPair] = useState<Pair | null>(null);

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
        setSelectedPair(null);
        setFromTable(openRequest.tables[0]?.name ?? '');
        setToTable(openRequest.tables[1]?.name ?? openRequest.tables[0]?.name ?? '');
        setFromCol('');
        setToCol('');
    }, [openRequest, lastNonce]);

    const colsOf = (name: string) => tables.find(t => t.name === name)?.columns ?? [];

    // Group relationships by unordered table pair for the list.
    const groups = useMemo<PairGroup[]>(() => {
        const m = new Map<string, PairGroup>();
        for (const r of relationships) {
            const [a, b] = [r.fromTable, r.toTable].sort((x, y) =>
                x.toLowerCase().localeCompare(y.toLowerCase()),
            );
            const key = `${a.toLowerCase()}||${b.toLowerCase()}`;
            const g = m.get(key);
            if (g) g.rels.push(r);
            else m.set(key, { key, a, b, rels: [r] });
        }
        return Array.from(m.values());
    }, [relationships]);

    const shownGroups = selectedPair ? groups.filter(g => samePair(g, selectedPair)) : groups;

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
        const base = { fromTable, fromColumn: fromCol, toTable, toColumn: toCol, inferred: false };
        const id = relId(base);
        setRelationships(rs => (rs.some(r => r.id === id) ? rs : [...rs, { id, ...base }]));
        setFromCol('');
        setToCol('');
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
                    onPairSelect={(a, b) => setSelectedPair({ a, b })}
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
                            <input
                                list="erd-from-cols"
                                value={fromCol}
                                placeholder="search column…"
                                onChange={e => setFromCol(e.target.value)}
                            />
                            <datalist id="erd-from-cols">
                                {colsOf(fromTable).map(c => (
                                    <option key={c.name} value={c.name} />
                                ))}
                            </datalist>
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
                            <input
                                list="erd-to-cols"
                                value={toCol}
                                placeholder="search column…"
                                onChange={e => setToCol(e.target.value)}
                            />
                            <datalist id="erd-to-cols">
                                {colsOf(toTable).map(c => (
                                    <option key={c.name} value={c.name} />
                                ))}
                            </datalist>
                        </div>
                        <button
                            className="erd-btn erd-ws-add-btn"
                            onClick={addManual}
                            disabled={!fromCol || !toCol}
                        >
                            <Plus size={13} /> Add relationship
                        </button>
                    </div>

                    {selectedPair ? (
                        <div className="erd-ws-filter">
                            Showing{' '}
                            <b>
                                {selectedPair.a} ↔ {selectedPair.b}
                            </b>
                            <button onClick={() => setSelectedPair(null)} aria-label="Clear filter">
                                <X size={12} /> Show all
                            </button>
                        </div>
                    ) : (
                        <div className="erd-ws-hint">
                            Drag a table onto another to add a join; click a diagram link to filter.
                        </div>
                    )}

                    {relationships.length === 0 ? (
                        <div className="erd-ws-empty-list">No relationships yet.</div>
                    ) : (
                        <div className="erd-ws-groups">
                            {shownGroups.map(g => (
                                <div className="erd-ws-group" key={g.key}>
                                    <div className="erd-ws-group-head">
                                        <span className="pair">
                                            {g.a} ↔ {g.b}
                                        </span>
                                        <span className="cnt">{g.rels.length}</span>
                                    </div>
                                    {g.rels.map(r => (
                                        <div className="erd-ws-rel" key={r.id}>
                                            <code>
                                                {r.fromTable}.{r.fromColumn} → {r.toTable}.
                                                {r.toColumn}
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
                            ))}
                        </div>
                    )}
                </aside>
            </div>
        </div>
    );
}
