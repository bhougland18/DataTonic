// Running a block's SQL against a durable source.
//
// Same trick the shipped dives use (`dives/dive-run.ts`): synthesize a one-node
// `code.sql` pipeline and push it through the existing engine path, so SSE
// progress, cancel, `${workspace}` resolution and the desktop/web split all
// come for free and no new engine command is needed.
//
// NOTE (plan §6.1 / D10): this path is a DuckDB CLI spawn per call — measured
// ~115 ms floor. That is fine here, because the funnel runs ONE query when the
// user presses Run, exactly like SQL Studio. It is NOT viable for Mosaic
// cross-filter, which is why the dashboard surface goes to DuckDB-WASM.

import type { Node } from '@xyflow/react';
import type { DuckleNodeData } from '../pipeline-types';
import { runPipeline } from '../tauri-bridge';
import type { SqlRunResult } from '../sqleditor/types';

/**
 * Run arbitrary read-only SQL against the durable source and return the grid.
 *
 * Errors are returned in the result rather than thrown: `QueryPane` renders
 * `error` inline, and a rejected promise would surface as an unhandled failure
 * in the pane instead of a message the user can act on.
 */
export async function runBlockSql(
    sql: string,
    workspacePath?: string | null,
    label = 'Block',
): Promise<SqlRunResult> {
    const start = performance.now();
    const node: Node<DuckleNodeData> = {
        id: 'block_sql',
        type: 'duckle',
        position: { x: 0, y: 0 },
        data: { label, componentId: 'code.sql', properties: { sql } },
    };
    try {
        const result = await runPipeline(
            [node],
            [],
            undefined,
            'blocks_studio',
            workspacePath ?? null,
            label,
        );
        const durationMs = performance.now() - start;
        if (!result) {
            return { columns: [], rows: [], error: 'Run is unavailable in this edition.' };
        }
        if (result.status === 'error') {
            return { columns: [], rows: [], error: result.error || 'Query failed.', durationMs };
        }
        const preview =
            result.preview.find(p => p.node_id === 'block_sql') ??
            result.preview[result.preview.length - 1];
        return {
            columns: (preview?.columns ?? []).map(c => ({
                name: c.name,
                type: c.type,
                nullable: c.nullable,
            })),
            rows: preview?.rows ?? [],
            durationMs,
        };
    } catch (e) {
        return {
            columns: [],
            rows: [],
            error: e instanceof Error ? e.message : String(e),
            durationMs: performance.now() - start,
        };
    }
}
