import { useCallback, useMemo } from 'react';
import {
    ReactFlow,
    Background,
    Controls,
    Handle,
    Position,
    useNodesState,
    type Node,
    type Edge,
    type NodeProps,
    type Connection,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './erd.css';
import type { ErdRelationship, ErdTable } from './model';

interface ErDiagramProps {
    tables: ErdTable[];
    relationships: ErdRelationship[];
    // Read-only mode (the Studio's ER tab). When false, columns expose connect
    // handles and edges are editable; changes flow through onRelationshipsChange.
    readOnly?: boolean;
    onRelationshipsChange?: (rels: ErdRelationship[]) => void;
}

type TableNodeData = { table: ErdTable; editable: boolean };

const relId = (r: Omit<ErdRelationship, 'id'>) =>
    `${r.fromTable}.${r.fromColumn}->${r.toTable}.${r.toColumn}`;

// A table rendered as a ReactFlow node — header + column rows. In editable mode
// each column exposes a left (target) and right (source) handle so the user can
// draw relationships column-to-column; read-only mode uses single table handles.
function TableNode({ data }: NodeProps) {
    const { table, editable } = data as TableNodeData;
    return (
        <div className="erd-node">
            {!editable && <Handle type="target" position={Position.Left} className="erd-handle" />}
            <div className="erd-node-head">{table.name}</div>
            <div className="erd-node-cols">
                {table.columns.length === 0 ? (
                    <div className="erd-node-col erd-node-col--empty">schema unknown</div>
                ) : (
                    table.columns.map(c => (
                        <div className="erd-node-col" key={c.name}>
                            {editable && (
                                <Handle
                                    type="target"
                                    id={c.name}
                                    position={Position.Left}
                                    className="erd-handle erd-handle--col"
                                />
                            )}
                            <span className="cn">{c.name}</span>
                            {c.primaryKey && <span className="pk">PK</span>}
                            {c.type && <span className="ty">{c.type}</span>}
                            {editable && (
                                <Handle
                                    type="source"
                                    id={c.name}
                                    position={Position.Right}
                                    className="erd-handle erd-handle--col"
                                />
                            )}
                        </div>
                    ))
                )}
            </div>
            {!editable && <Handle type="source" position={Position.Right} className="erd-handle" />}
        </div>
    );
}

const nodeTypes = { erdTable: TableNode };

// Shared ER diagram (SE-11). Read-only in the SQL Studio; the same component
// backs the editable authoring surface on the Working DB node.
export default function ErDiagram({
    tables,
    relationships,
    readOnly = true,
    onRelationshipsChange,
}: ErDiagramProps) {
    const initialNodes = useMemo<Node<TableNodeData>[]>(
        () =>
            tables.map((t, i) => ({
                id: t.name,
                type: 'erdTable',
                position: { x: (i % 3) * 300, y: Math.floor(i / 3) * 300 },
                data: { table: t, editable: !readOnly },
                draggable: !readOnly,
            })),
        [tables, readOnly],
    );
    // Local node state so positions survive drags in editable mode; re-seeded
    // when the table set changes.
    const [nodes, , onNodesChange] = useNodesState(initialNodes);

    const edges = useMemo<Edge[]>(
        () =>
            relationships.map(r => ({
                id: r.id,
                source: r.fromTable,
                target: r.toTable,
                sourceHandle: readOnly ? undefined : r.fromColumn,
                targetHandle: readOnly ? undefined : r.toColumn,
                label: `${r.fromColumn} → ${r.toColumn}`,
                animated: false,
                selectable: !readOnly,
                deletable: !readOnly,
                style: { stroke: 'var(--accent)', strokeWidth: 1.5 },
                labelStyle: { fill: 'var(--text-2)', fontSize: 10 },
                labelBgStyle: { fill: 'var(--bg-2)' },
            })),
        [relationships, readOnly],
    );

    const onConnect = useCallback(
        (conn: Connection) => {
            if (readOnly || !onRelationshipsChange) return;
            if (!conn.source || !conn.target || !conn.sourceHandle || !conn.targetHandle) return;
            const base = {
                fromTable: conn.source,
                fromColumn: conn.sourceHandle,
                toTable: conn.target,
                toColumn: conn.targetHandle,
                inferred: false,
            };
            const id = relId(base);
            if (relationships.some(r => r.id === id)) return;
            onRelationshipsChange([...relationships, { id, ...base }]);
        },
        [readOnly, onRelationshipsChange, relationships],
    );

    const onEdgesDelete = useCallback(
        (deleted: Edge[]) => {
            if (readOnly || !onRelationshipsChange) return;
            const gone = new Set(deleted.map(e => e.id));
            onRelationshipsChange(relationships.filter(r => !gone.has(r.id)));
        },
        [readOnly, onRelationshipsChange, relationships],
    );

    return (
        <div className="erd-diagram">
            <ReactFlow
                nodes={nodes}
                edges={edges}
                nodeTypes={nodeTypes}
                onNodesChange={onNodesChange}
                onConnect={onConnect}
                onEdgesDelete={onEdgesDelete}
                fitView
                minZoom={0.2}
                proOptions={{ hideAttribution: true }}
                nodesConnectable={!readOnly}
                nodesDraggable={!readOnly}
                elementsSelectable={!readOnly}
            >
                <Background gap={16} color="var(--border)" />
                <Controls showInteractive={false} />
            </ReactFlow>
        </div>
    );
}
