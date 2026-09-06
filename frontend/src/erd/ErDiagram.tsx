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
import { inferBetween, type ErdRelationship, type ErdTable } from './model';

interface ErDiagramProps {
    tables: ErdTable[];
    relationships: ErdRelationship[];
    // Read-only mode (no drawing). When false, dragging a table onto another
    // adds inferred join(s) via onRelationshipsChange.
    readOnly?: boolean;
    onRelationshipsChange?: (rels: ErdRelationship[]) => void;
    // Clicking an edge (a table pair) reports the two tables so the caller can
    // filter its relationship list to that pair.
    onPairSelect?: (a: string, b: string) => void;
}

type TableNodeData = { table: ErdTable };

// Unordered pair key so both directions collapse to one edge.
const pairKey = (a: string, b: string) =>
    [a.toLowerCase(), b.toLowerCase()].sort().join('||');

// A table rendered as a ReactFlow node — header + column rows, with a single
// left (target) / right (source) handle. Relationships are drawn table-to-table
// (the join columns are inferred), so per-column handles aren't needed.
function TableNode({ data }: NodeProps) {
    const { table } = data as TableNodeData;
    return (
        <div className="erd-node">
            <Handle type="target" position={Position.Left} className="erd-handle" />
            <div className="erd-node-head">{table.name}</div>
            <div className="erd-node-cols">
                {table.columns.length === 0 ? (
                    <div className="erd-node-col erd-node-col--empty">schema unknown</div>
                ) : (
                    table.columns.map(c => (
                        <div className="erd-node-col" key={c.name}>
                            <span className="cn">{c.name}</span>
                            {c.primaryKey && <span className="pk">PK</span>}
                            {c.type && <span className="ty">{c.type}</span>}
                        </div>
                    ))
                )}
            </div>
            <Handle type="source" position={Position.Right} className="erd-handle" />
        </div>
    );
}

const nodeTypes = { erdTable: TableNode };

// Shared ER diagram (SE-11). Edges are aggregated per table pair: one line, and
// a "N" count label when a pair holds several joins (click it to filter the
// panel). Read-only in the Studio's autocomplete/AI path (currently unused
// visually); editable on the Working DB rail surface.
export default function ErDiagram({
    tables,
    relationships,
    readOnly = true,
    onRelationshipsChange,
    onPairSelect,
}: ErDiagramProps) {
    const initialNodes = useMemo<Node<TableNodeData>[]>(
        () =>
            tables.map((t, i) => ({
                id: t.name,
                type: 'erdTable',
                position: { x: (i % 3) * 320, y: Math.floor(i / 3) * 320 },
                data: { table: t },
                draggable: !readOnly,
            })),
        [tables, readOnly],
    );
    const [nodes, , onNodesChange] = useNodesState(initialNodes);

    // One edge per table pair. Label shows the join when there's exactly one,
    // else the count (click to filter).
    const edges = useMemo<Edge[]>(() => {
        const groups = new Map<string, ErdRelationship[]>();
        for (const r of relationships) {
            const key = pairKey(r.fromTable, r.toTable);
            const arr = groups.get(key);
            if (arr) arr.push(r);
            else groups.set(key, [r]);
        }
        return Array.from(groups.values()).map(rels => {
            const first = rels[0];
            const many = rels.length > 1;
            return {
                id: `pair:${pairKey(first.fromTable, first.toTable)}`,
                source: first.fromTable,
                target: first.toTable,
                label: many ? `${rels.length} joins` : `${first.fromColumn} → ${first.toColumn}`,
                selectable: !readOnly,
                style: { stroke: 'var(--accent)', strokeWidth: many ? 2 : 1.5 },
                labelStyle: {
                    fill: many ? 'var(--accent)' : 'var(--text-2)',
                    fontSize: many ? 11 : 10,
                    fontWeight: many ? 700 : 400,
                    cursor: 'pointer',
                },
                labelBgStyle: { fill: 'var(--bg-2)' },
                labelBgPadding: [6, 3] as [number, number],
                labelBgBorderRadius: 4,
            };
        });
    }, [relationships, readOnly]);

    const onConnect = useCallback(
        (conn: Connection) => {
            if (readOnly || !onRelationshipsChange) return;
            if (!conn.source || !conn.target || conn.source === conn.target) return;
            const existing = new Set(relationships.map(r => r.id));
            const inferred = inferBetween(tables, conn.source, conn.target).filter(
                r => !existing.has(r.id),
            );
            if (inferred.length) onRelationshipsChange([...relationships, ...inferred]);
            else onPairSelect?.(conn.source, conn.target);
        },
        [readOnly, onRelationshipsChange, relationships, tables, onPairSelect],
    );

    const onEdgeClick = useCallback(
        (_: unknown, edge: Edge) => onPairSelect?.(edge.source, edge.target),
        [onPairSelect],
    );

    return (
        <div className="erd-diagram">
            <ReactFlow
                nodes={nodes}
                edges={edges}
                nodeTypes={nodeTypes}
                onNodesChange={onNodesChange}
                onConnect={onConnect}
                onEdgeClick={onEdgeClick}
                fitView
                minZoom={0.2}
                proOptions={{ hideAttribution: true }}
                nodesConnectable={!readOnly}
                nodesDraggable={!readOnly}
                elementsSelectable
            >
                <Background gap={16} color="var(--border)" />
                <Controls showInteractive={false} />
            </ReactFlow>
        </div>
    );
}
