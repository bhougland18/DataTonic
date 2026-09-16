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
import { stripTerminator } from '../sqleditor/qualify';
import type { SqlRunResult } from '../sqleditor/types';

/**
 * Rows a Blocks run asks for, so a chart is drawn over the data and not over a
 * sample of it.
 *
 * RAISED, not removed, and the distinction is the point. The engine will go to
 * 100,000 (`MAX_PREVIEW_ROWS`) but a chart with 100,000 marks answers no
 * question, and the rows travel as JSON through a marker file and the IPC
 * channel on every run. Five thousand covers what the charts here can actually
 * say — twenty categories over ten years of months for a small-multiple, which
 * is past the point where a reader can hold it — and the step still SAYS when a
 * result hit the ceiling, because a truncated chart means something slightly
 * different and nothing else on screen would show it.
 */
export const BLOCK_ROW_LIMIT = 5000;

/**
 * Run arbitrary read-only SQL against the durable source and return the grid.
 *
 * `database`, when given, is a DuckDB file the query needs attached. We do not
 * write the ATTACH ourselves — the engine wraps a node's SQL in `CREATE OR
 * REPLACE VIEW … AS (…)` and DDL cannot live in a view body. Instead we
 * synthesize a `src.duckdb` node, whose stage prelude already emits
 * `ATTACH '<database>' AS duckle_src (READ_ONLY)` and whose `sql` prop is
 * passed through as the view body. So the same one-node trick still holds; only
 * the component changes, and read-only is the engine's default rather than
 * something we have to remember.
 *
 * The alias is fixed at `duckle_src` by the engine, so one run reaches one
 * database. Joining across two `.duckdb` files is therefore not expressible
 * here — the caller is expected to have resolved which database it is querying.
 *
 * `duckle_src` is what you WRITE, but not what DuckDB ends up seeing. Issue #76
 * gives every attach-backed source its own alias so several can coexist as live
 * views in one batched session, so `plan/mod.rs` rewrites the token to
 * `duckle_src_<node id>` — here, `duckle_src_block_sql` — in both the prelude
 * and the body. The rewrite is token-boundaried and so reaches inside quotes:
 * `"duckle_src"."Item"` becomes `"duckle_src_block_sql"."Item"`.
 *
 * Which is why a bare `FROM Item` fails with `Did you mean
 * "duckle_src_block_sql.Item"?` — a name with no `duckle_src` token in it has
 * nothing to rewrite. Read that error as "you omitted the alias", not as
 * "the alias we tell you to write is the wrong one".
 *
 * Errors are returned in the result rather than thrown: `QueryPane` renders
 * `error` inline, and a rejected promise would surface as an unhandled failure
 * in the pane instead of a message the user can act on.
 *
 * `rowLimit` raises the engine's 100-row preview cap for this run. Omitted
 * keeps it. The cap is right for a GRID — a preview is a glance, and the grid
 * says how many rows it is showing — and wrong for a CHART, which draws every
 * row it is handed. The cap does not make a chart smaller, it makes it say
 * something else: bars go missing, and a small-multiple chart loses whole
 * panels with nothing on screen to mark the loss.
 *
 * Safe here, and only here, because this synthesizes a SINGLE node. The limit
 * is per-engine, so raising it on a real multi-node pipeline would read every
 * node's preview at the new size.
 */
export async function runBlockSql(
    sql: string,
    workspacePath?: string | null,
    label = 'Block',
    database?: string | null,
    rowLimit?: number,
): Promise<SqlRunResult> {
    const start = performance.now();
    sql = stripTerminator(sql);
    const node: Node<DuckleNodeData> = {
        id: 'block_sql',
        type: 'duckle',
        position: { x: 0, y: 0 },
        data: database
            ? { label, componentId: 'src.duckdb', properties: { database, sql } }
            : { label, componentId: 'code.sql', properties: { sql } },
    };
    try {
        const result = await runPipeline(
            [node],
            [],
            undefined,
            'blocks_studio',
            workspacePath ?? null,
            label,
            rowLimit,
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
