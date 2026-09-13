// Fork-owned test (DataTonic): a SQL node's Schema tab must track reality, not
// freeze at first authoring.
//
// The bug this pins: `code.sqlstudio` carries `schemaSource: 'declared'`, so
// `computeNodeSchema` returned the persisted snapshot. The engine's real answer
// was being computed by `deriveSchemaFromEngine` (PropertiesPanel asks for every
// selected node) and then discarded, because the only read of the `derived`
// cache sat in the `xf.*` branch. Live symptom: an Infor column detected as
// float64 and materialized as DOUBLE still showed `string` on the SQL Studio
// node indefinitely.
import { describe, it, expect } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import { deriveSchemaFromEngine, resolveOutputSchema } from './schema-resolve';
import type { NodeAnalysis } from './tauri-bridge';
import type { Column, DuckleNodeData } from './pipeline-types';

const col = (name: string, type: Column['type']): Column => ({ name, type, nullable: true });

// A full NodeAnalysis - the engine's reply shape. Built by helper so the mocks
// stay readable and cannot drift from the type.
const analysis = (nodeId: string, columns: Column[]): NodeAnalysis => ({
    nodeId,
    component: 'code.sqlstudio',
    dialect: 'duckdb',
    columns,
    diagnostics: [],
    validated: true,
});

// `derived` is a module-level cache keyed by (nodeId, componentId, props,
// upstream) — so every test needs its OWN node id. Sharing one would make a
// test pass or fail depending on which ran first, which is worse than no test.
function graph(id: string, sourceSchema: Column[], studioSchema: Column[]) {
    const srcId = `src-${id}`;
    const nodes = [
        {
            id: srcId,
            position: { x: 0, y: 0 },
            data: {
                label: 'Infor',
                componentId: 'src.infor',
                properties: { businessClass: 'Item' },
                schema: sourceSchema,
            },
        },
        {
            id,
            position: { x: 1, y: 0 },
            data: {
                label: 'SQL Studio',
                componentId: 'code.sqlstudio',
                properties: { sql: 'SELECT * FROM input' },
                schema: studioSchema,
            },
        },
    ] as unknown as Node<DuckleNodeData>[];
    const edges = [{ id: `e-${id}`, source: srcId, target: id }] as Edge[];
    return { nodes, edges };
}

describe('resolveOutputSchema for SQL nodes', () => {
    it('falls back to the stored schema when the engine has not been asked', () => {
        // No analysis yet (no engine, unfinished config): the declaration is
        // still better than nothing. Own node id, so a later test populating
        // the cache cannot make this one pass or fail by ordering.
        const { nodes, edges } = graph(
            'sql-unasked',
            [col('Item', 'string'), col('UOMConversion', 'float64')],
            [col('Item', 'string'), col('UOMConversion', 'string')],
        );
        const out = resolveOutputSchema('sql-unasked', nodes, edges);
        expect(out.find(c => c.name === 'UOMConversion')?.type).toBe('string');
    });

    it("prefers DuckDB's answer over a stale stored schema", async () => {
        const { nodes, edges } = graph(
            'sql-stale',
            [col('Item', 'string'), col('UOMConversion', 'float64')],
            // The stale snapshot, taken before the upstream type changed.
            [col('Item', 'string'), col('UOMConversion', 'string')],
        );
        const changed = await deriveSchemaFromEngine('sql-stale', nodes, edges, async () => analysis('sql-stale', [col('Item', 'string'), col('UOMConversion', 'float64')]));
        expect(changed).toBe(true);

        const out = resolveOutputSchema('sql-stale', nodes, edges);
        expect(out.find(c => c.name === 'UOMConversion')?.type).toBe('float64');
    });

    it('re-asks the engine when an upstream TYPE changes', async () => {
        // The self-updating property: derivedKey includes upstream [name, type],
        // so a type change invalidates the cache instead of serving a stale hit.
        // Without this, fixing a source's types would never reach downstream.
        // Same node id across before/after on purpose - that IS the scenario.
        const before = graph('sql-drift', [col('Amount', 'string')], []);
        await deriveSchemaFromEngine('sql-drift', before.nodes, before.edges, async () => analysis('sql-drift', [col('Amount', 'string')]));
        expect(resolveOutputSchema('sql-drift', before.nodes, before.edges)[0].type).toBe('string');

        const after = graph('sql-drift', [col('Amount', 'float64')], []);
        let asked = false;
        await deriveSchemaFromEngine('sql-drift', after.nodes, after.edges, async () => {
            asked = true;
            return analysis('sql-drift', [col('Amount', 'float64')]);
        });
        expect(asked, 'a changed upstream type must re-ask the engine').toBe(true);
        expect(resolveOutputSchema('sql-drift', after.nodes, after.edges)[0].type).toBe('float64');
    });

    it('ignores an empty analysis rather than blanking the schema', async () => {
        // A node that analyses to nothing must not wipe a usable declaration.
        const { nodes, edges } = graph('sql-empty', [col('Item', 'string')], [col('Item', 'string')]);
        await deriveSchemaFromEngine('sql-empty', nodes, edges, async () => analysis('sql-empty', []));
        expect(resolveOutputSchema('sql-empty', nodes, edges)).toHaveLength(1);
    });
});
