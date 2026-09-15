import { useCallback, useEffect, useMemo, useRef } from 'react';
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
    type ReactFlowInstance,
} from '@xyflow/react';
import { Eye, EyeOff } from 'lucide-react';
import '@xyflow/react/dist/style.css';
import './erd.css';
import { inferBetween, type ErdRelationship, type ErdTable } from './model';
import { layoutErd } from './layout';

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
    // Tables whose edges are hidden on the canvas. The relationships still
    // EXIST — this only stops them being drawn. A table derived from several
    // others (a query result written back as parquet) legitimately joins to all
    // of them, and its edges can swamp the diagram.
    hiddenRelations?: string[];
    onToggleRelations?: (table: string) => void;
    /** Bump to re-run auto-arrange. A nonce rather than a callback because
     *  positions live in this component's node state, which the caller cannot
     *  reach — the same idiom the editors use for `openRequest`. */
    arrangeNonce?: number;
    /** Saved layout to restore, by table name. */
    positions?: Record<string, { x: number; y: number }>;
    /** Reports the layout after it changes, so the host can persist it. Fired
     *  when a drag ends or an arrange completes — not during a drag, which
     *  would be one call per frame. */
    onPositionsChange?: (positions: Record<string, { x: number; y: number }>) => void;
}

type TableNodeData = {
    table: ErdTable;
    hidden?: boolean;
    onToggle?: (table: string) => void;
};

// Unordered pair key so both directions collapse to one edge.
const pairKey = (a: string, b: string) =>
    [a.toLowerCase(), b.toLowerCase()].sort().join('||');

// A table rendered as a ReactFlow node — header + column rows, with a single
// left (target) / right (source) handle. Relationships are drawn table-to-table
// (the join columns are inferred), so per-column handles aren't needed.
function TableNode({ data }: NodeProps) {
    const { table, hidden, onToggle } = data as TableNodeData;
    return (
        <div className={`erd-node${hidden ? ' erd-node--muted' : ''}`}>
            {/* Both a source and a target handle on EACH side, so an edge can
                leave and arrive on whichever side faces the other table. With
                one fixed pair, a table sitting to the left forced its edge to
                loop all the way around the node. The two handles on a side sit
                at the same point and look like one dot. */}
            <Handle id="tl" type="target" position={Position.Left} className="erd-handle" />
            <Handle id="sl" type="source" position={Position.Left} className="erd-handle" />
            <div className="erd-node-head">
                <span className="erd-node-name">{table.name}</span>
                {table.columns.length > 0 && (
                    <span className="erd-node-count" title={`${table.columns.length} columns`}>
                        {table.columns.length}
                    </span>
                )}
                {onToggle && (
                    <button
                        type="button"
                        className="erd-node-eye"
                        title={
                            hidden
                                ? `Show ${table.name}'s relationships`
                                : `Hide ${table.name}'s relationships`
                        }
                        aria-label={
                            hidden
                                ? `Show ${table.name}'s relationships`
                                : `Hide ${table.name}'s relationships`
                        }
                        aria-pressed={hidden ? 'true' : 'false'}
                        // The node is draggable, so the press must not start a
                        // drag or the button is unclickable on a slow click.
                        onMouseDown={e => e.stopPropagation()}
                        onClick={e => {
                            e.stopPropagation();
                            onToggle(table.name);
                        }}
                    >
                        {hidden ? <EyeOff size={12} /> : <Eye size={12} />}
                    </button>
                )}
            </div>
            {/* `nowheel` keeps the canvas from zooming when the pointer is over
                a scrolling column list — without it the wheel is captured by
                ReactFlow and the list cannot be scrolled at all. */}
            <div className="erd-node-cols nowheel">
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
            <Handle id="sr" type="source" position={Position.Right} className="erd-handle" />
            <Handle id="tr" type="target" position={Position.Right} className="erd-handle" />
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
    hiddenRelations,
    onToggleRelations,
    arrangeNonce,
    positions,
    onPositionsChange,
}: ErDiagramProps) {
    const hidden = useMemo(() => new Set(hiddenRelations ?? []), [hiddenRelations]);
    const initialNodes = useMemo<Node<TableNodeData>[]>(
        () =>
            tables.map((t, i) => ({
                id: t.name,
                type: 'erdTable',
                // A saved layout wins; otherwise a grid, which Arrange replaces.
                position: positions?.[t.name] ?? { x: (i % 3) * 320, y: Math.floor(i / 3) * 320 },
                data: { table: t, hidden: hidden.has(t.name), onToggle: onToggleRelations },
                draggable: !readOnly,
            })),
        [tables, readOnly, hidden, onToggleRelations, positions],
    );
    const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);

    // `useNodesState` seeds from its argument ONCE and ignores it afterwards,
    // so a diagram whose tables arrive after mount would render whatever it was
    // first handed — an empty canvas, or boxes stuck reading "schema unknown".
    //
    // Both hosts feed it late data: the Blocks studio reads the catalog and
    // then probes for columns, and the Working DB editor swaps in a different
    // node's tables without ever unmounting. Positions are carried over by id
    // so a re-sync does not throw away a layout the user dragged.
    useEffect(() => {
        setNodes(prev => {
            const placed = new Map(prev.map(n => [n.id, n.position]));
            return initialNodes.map(n => ({ ...n, position: placed.get(n.id) ?? n.position }));
        });
    }, [initialNodes, setNodes]);

    // Report the layout upward. Called at moments the user has FINISHED moving
    // something — never mid-drag, which would fire once per frame.
    const reportPositions = useRef(onPositionsChange);
    reportPositions.current = onPositionsChange;
    const publish = useCallback((ns: Node<TableNodeData>[]) => {
        const out: Record<string, { x: number; y: number }> = {};
        for (const n of ns) out[n.id] = { x: n.position.x, y: n.position.y };
        reportPositions.current?.(out);
    }, []);

    // A saved layout usually arrives AFTER the tables — the host reads it from
    // storage — by which point the sync effect above has already preserved the
    // grid positions it seeded. So apply it when it lands.
    useEffect(() => {
        if (!positions || Object.keys(positions).length === 0) return;
        setNodes(prev => prev.map(n => (positions[n.id] ? { ...n, position: positions[n.id] } : n)));
        const id = requestAnimationFrame(() => flow.current?.fitView({ padding: 0.2 }));
        return () => cancelAnimationFrame(id);
    }, [positions, setNodes]);

    // `fitView` is an INITIAL-render option, so a diagram that mounts before its
    // tables arrive fits an empty graph and keeps that viewport. The nodes then
    // appear outside it and the canvas looks empty even though it is populated.
    // Refit whenever the set of tables changes — keyed on the names rather than
    // the count, so swapping one table for another also refits, and dragging a
    // node (which changes neither) does not yank the view back.
    const flow = useRef<ReactFlowInstance<Node<TableNodeData>, Edge> | null>(null);
    const tableKey = useMemo(() => tables.map(t => t.name).join(' '), [tables]);
    useEffect(() => {
        if (!tableKey) return;
        // After the nodes have been committed and measured, or it fits to
        // elements that do not have a size yet.
        const id = requestAnimationFrame(() => flow.current?.fitView({ padding: 0.2 }));
        return () => cancelAnimationFrame(id);
    }, [tableKey]);

    // Refit when the canvas goes from having NO size to having some.
    //
    // A host may keep this mounted inside a `display: none` container — the
    // Blocks studio does (App.tsx), so in-progress work survives a trip to
    // Canvas. An element hidden that way has no layout box at all, so ReactFlow
    // measures 0x0, its initial `fitView` has no bounds to fit, and the nodes
    // stay outside the viewport once the container is finally shown. Neither
    // the table list nor the node list changes at that moment, so watching the
    // element itself is the only thing that catches it.
    // Auto-arrange. Skipped on the first render (nonce undefined / unchanged)
    // so opening a diagram never silently discards a layout the user dragged.
    const lastArrange = useRef(arrangeNonce);
    useEffect(() => {
        if (arrangeNonce === undefined || arrangeNonce === lastArrange.current) return;
        lastArrange.current = arrangeNonce;
        setNodes(prev => {
            // Measured sizes, so a tall table does not overlap the one below.
            const sizes = new Map(
                prev.map(n => [
                    n.id,
                    {
                        width: n.measured?.width ?? 0,
                        height: n.measured?.height ?? 0,
                    },
                ]),
            );
            const placed = layoutErd(tables, relationships, sizes);
            const next = prev.map(n => ({ ...n, position: placed.get(n.id) ?? n.position }));
            // Arranging is a layout change like any drag, so it becomes
            // unsaved work the Save button can commit.
            publish(next);
            return next;
        });
        requestAnimationFrame(() => flow.current?.fitView({ padding: 0.2 }));
    }, [arrangeNonce, setNodes, tables, relationships, publish]);

    const containerRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const el = containerRef.current;
        if (!el || typeof ResizeObserver === 'undefined') return;
        const sized = () => el.clientWidth > 0 && el.clientHeight > 0;
        let had = sized();
        const ro = new ResizeObserver(() => {
            const now = sized();
            // Only the hidden -> shown edge. Firing on every resize would fight
            // a user who has panned or zoomed and then resizes the window.
            if (now && !had) requestAnimationFrame(() => flow.current?.fitView({ padding: 0.2 }));
            had = now;
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    // One edge per table pair. Label shows the join when there's exactly one,
    // else the count (click to filter).
    /** Nodes by id, for deciding which side of a table an edge should meet. */
    const placed = useMemo(() => new Map(nodes.map(n => [n.id, n] as const)), [nodes]);

    const edges = useMemo<Edge[]>(() => {
        const groups = new Map<string, ErdRelationship[]>();
        for (const r of relationships) {
            // Either end being hidden drops the edge: hiding a table means
            // "stop drawing its joins", which only works if it applies from
            // both directions.
            if (hidden.has(r.fromTable) || hidden.has(r.toTable)) continue;
            const key = pairKey(r.fromTable, r.toTable);
            const arr = groups.get(key);
            if (arr) arr.push(r);
            else groups.set(key, [r]);
        }
        return Array.from(groups.values()).map(rels => {
            const first = rels[0];
            const many = rels.length > 1;
            // Attach on the sides that FACE each other, using each node's
            // centre so a wide table does not read as being to the left of one
            // it actually overlaps. Recomputed as nodes move, so the edge flips
            // sides the moment you drag a table past another.
            const centre = (id: string) => {
                const n = placed.get(id);
                if (!n) return 0;
                return n.position.x + (n.measured?.width ?? 0) / 2;
            };
            const targetIsRight = centre(first.toTable) >= centre(first.fromTable);
            return {
                id: `pair:${pairKey(first.fromTable, first.toTable)}`,
                source: first.fromTable,
                target: first.toTable,
                sourceHandle: targetIsRight ? 'sr' : 'sl',
                targetHandle: targetIsRight ? 'tl' : 'tr',
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
    }, [relationships, readOnly, hidden, placed]);

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
        <div className="erd-diagram" ref={containerRef}>
            <ReactFlow
                nodes={nodes}
                edges={edges}
                nodeTypes={nodeTypes}
                onNodesChange={onNodesChange}
                onNodeDragStop={(_, __, dragged) => publish(nodes.map(n => dragged.find(d => d.id === n.id) ?? n))}
                onConnect={onConnect}
                onEdgeClick={onEdgeClick}
                onInit={inst => {
                    flow.current = inst;
                }}
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
