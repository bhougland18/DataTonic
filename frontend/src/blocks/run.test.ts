// `runBlockSql` is a thin wrapper over `runPipeline`, and the interesting part
// is what it passes DOWN: a synthesized node, and — since charts stopped being
// happy with a 100-row glance — a preview row limit.
//
// Worth pinning because the failure is silent at every layer. A dropped
// `rowLimit` does not error; the engine keeps its default, the chart draws, and
// the picture is simply over fewer rows than the query returned.

import { describe, expect, it, vi, beforeEach } from 'vitest';

const runPipeline = vi.hoisted(() => vi.fn());
vi.mock('../tauri-bridge', () => ({ runPipeline }));

const { BLOCK_ROW_LIMIT, runBlockSql } = await import('./run');

const ok = () => ({
    status: 'ok',
    duration_ms: 1,
    nodes: {},
    preview: [{ node_id: 'block_sql', columns: [{ name: 'n', type: 'int64' }], rows: [{ n: 1 }] }],
});

/** The positional argument `runPipeline` takes the limit in. */
const ROW_LIMIT_ARG = 6;

describe('runBlockSql passes a row limit through', () => {
    beforeEach(() => {
        runPipeline.mockReset();
        runPipeline.mockResolvedValue(ok());
    });

    it('sends the limit it was given', async () => {
        await runBlockSql('SELECT 1', '/w', 'Block', null, 4242);
        expect(runPipeline.mock.calls[0][ROW_LIMIT_ARG]).toBe(4242);
    });

    // Omitted has to stay UNDEFINED rather than becoming a number here: the
    // engine's default is the one place that value should live, and a default
    // repeated in the frontend is a second definition that drifts.
    it('sends nothing when no limit is given', async () => {
        await runBlockSql('SELECT 1', '/w');
        expect(runPipeline.mock.calls[0][ROW_LIMIT_ARG]).toBeUndefined();
    });

    it('is generous enough for the charts, and still a limit', () => {
        expect(BLOCK_ROW_LIMIT).toBeGreaterThan(100);
        // Under the engine's MAX_PREVIEW_ROWS, which clamps anything larger.
        expect(BLOCK_ROW_LIMIT).toBeLessThanOrEqual(100_000);
    });

    // The limit rides alongside the existing arguments rather than replacing
    // any of them — it was appended, and an off-by-one in the position would
    // silently send the workspace path as a row count.
    it('still sends the synthesized node and the workspace', async () => {
        await runBlockSql('SELECT 1', '/w/space', 'Block', 'C:/db.duckdb', BLOCK_ROW_LIMIT);
        const [nodes, edges, , pipelineId, workspacePath] = runPipeline.mock.calls[0];
        expect(nodes).toHaveLength(1);
        expect(nodes[0].data.componentId).toBe('src.duckdb');
        expect(nodes[0].data.properties.database).toBe('C:/db.duckdb');
        expect(edges).toEqual([]);
        expect(pipelineId).toBe('blocks_studio');
        expect(workspacePath).toBe('/w/space');
    });

    // No database means no attach, so the plain code.sql node — the branch that
    // decides whether the SQL may say `duckle_src`.
    it('synthesizes code.sql when there is no database', async () => {
        await runBlockSql('SELECT 1', '/w', 'Block', null, BLOCK_ROW_LIMIT);
        expect(runPipeline.mock.calls[0][0][0].data.componentId).toBe('code.sql');
    });
});
