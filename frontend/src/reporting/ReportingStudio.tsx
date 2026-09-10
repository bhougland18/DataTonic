import './reporting.css';
import { useMemo } from 'react';
import { FileText, LayoutDashboard, Presentation } from 'lucide-react';
import type { Assembler } from './types';

interface ReportingStudioProps {
    workspacePath?: string | null;
    /** How many analysis blocks exist to assemble. Assembling nothing is the
     *  one failure mode this surface can actually explain up front. */
    blockCount?: number;
    /** Send the user to the Blocks studio to author some. */
    onOpenBlocks?: () => void;
}

/**
 * Reporting — assembling analysis blocks into a deliverable.
 *
 * Every assembler is `planned` today, so every tile is unclickable by
 * construction (see `types.ts`). That is the honest state: the Blocks studio
 * authors pieces, and nothing yet arranges them. The meters are the roadmap
 * drawn, not decoration — the same discipline as the Home launcher.
 */
export default function ReportingStudio({
    workspacePath,
    blockCount = 0,
    onOpenBlocks,
}: ReportingStudioProps) {
    const assemblers: Assembler[] = useMemo(
        () => [
            {
                id: 'dashboard',
                label: 'Dashboard',
                blurb: 'Cross-filtered live views you can explore and share',
                icon: LayoutDashboard,
                status: 'planned',
                parts: [
                    { name: 'DuckDB-WASM connector', ref: 'DAA.82', done: false },
                    { name: 'Visual mosaic-spec builder', ref: 'DAA.80', done: false },
                    { name: 'Dive/dashboard migration', ref: 'DAA.81', done: false },
                ],
            },
            {
                id: 'report',
                label: 'Report',
                blurb: 'A conditional document — hosted, or typeset to PDF',
                icon: FileText,
                status: 'planned',
                parts: [
                    { name: 'Stitch core to self-contained HTML', ref: 'DAA.69', done: false },
                    { name: 'Outline editor + status map', ref: 'DAA.70', done: false },
                    { name: 'Vivliostyle paged preview', ref: 'DAA.71', done: false },
                    { name: 'PDF export', ref: 'DAA.74', done: false },
                    { name: 'Hosted output + access control', ref: 'DAA.73', done: false },
                ],
            },
            {
                id: 'deck',
                label: 'Deck',
                blurb: 'Slides populated from the same blocks, not retyped',
                icon: Presentation,
                status: 'planned',
                parts: [
                    { name: 'Bento consumed as a dependency', ref: 'DAA.77', done: false },
                    { name: 'Chart bake to SVG', ref: 'DAA.72', done: false },
                ],
            },
        ],
        [],
    );

    if (!workspacePath) {
        return (
            <div className="rpt rpt-empty">
                <p>Open a workspace to assemble a deliverable.</p>
            </div>
        );
    }

    return (
        <div className="rpt">
            <div className="rpt-inner">
                <header className="rpt-intro">
                    <h2>Assemble a deliverable</h2>
                    <p>
                        {blockCount > 0 ? (
                            <>
                                {blockCount} analysis block{blockCount === 1 ? '' : 's'} ready to
                                arrange. The same block can feed all three — it is never rewritten
                                per output.
                            </>
                        ) : (
                            <>
                                Nothing to assemble yet. Author a query or chart in{' '}
                                {onOpenBlocks ? (
                                    <button type="button" className="rpt-link" onClick={onOpenBlocks}>
                                        Blocks
                                    </button>
                                ) : (
                                    'Blocks'
                                )}{' '}
                                first — one block can feed all three outputs.
                            </>
                        )}
                    </p>
                </header>

                <div className="home-launcher-groups rpt-groups">
                    {assemblers.map(a => {
                        const Icon = a.icon;
                        const done = a.parts.filter(p => p.done).length;
                        const pct = Math.round((done / Math.max(a.parts.length, 1)) * 100);
                        return (
                            <button
                                key={a.id}
                                type="button"
                                className="home-group-tile"
                                // A planned assembler has no `open`, so this is
                                // always disabled — the type makes a live-looking
                                // dead tile unwritable.
                                disabled={a.status !== 'ready'}
                                onClick={a.status === 'ready' ? a.open : undefined}
                                title={
                                    a.status === 'ready'
                                        ? `Assemble a ${a.label.toLowerCase()}`
                                        : `${a.label} assembler — not built yet`
                                }
                            >
                                <span className="home-group-rule" aria-hidden="true" />
                                <span className="home-group-top">
                                    <Icon size={15} />
                                    <span className="home-group-name">{a.label}</span>
                                </span>
                                <span className="home-group-blurb">{a.blurb}</span>
                                <span className="home-group-foot">
                                    {/* The bar is the readiness number drawn, not
                                        decoration — all three empty is the truth
                                        about where this layer stands. */}
                                    <span className="home-group-meter" aria-hidden="true">
                                        <span
                                            className="home-group-meter-fill"
                                            style={{ width: `${pct}%` }}
                                        />
                                    </span>
                                    <span className="home-group-count">
                                        {done} of {a.parts.length} ready
                                    </span>
                                </span>
                            </button>
                        );
                    })}
                </div>

            </div>
        </div>
    );
}
