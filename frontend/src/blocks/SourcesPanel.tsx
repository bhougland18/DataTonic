// The durable sources a block may read, as a persistent left panel.
//
// Grouped by DATABASE rather than listed flat, because the grouping is not
// cosmetic: a query attaches one database at a time (the engine's `src.duckdb`
// prelude uses the fixed alias `duckle_src`), so which group a source belongs
// to determines whether it is reachable from the current query at all. A flat
// list would hide the one constraint the user most needs to see.
//
// Each source carries the three facts that decide whether to trust it: when it
// was last written, how many rows it holds, and which pipeline produced it.
// `writtenBy` is what distinguishes a raw pull from a derived table — a
// dataset written by a pipeline that reads the others is a query result, and
// its relationships mean something different.

import { Check, Database, FileText, Layers } from 'lucide-react';
import type { BlockSource } from './types';
import type { DatabaseGroup } from './sources';

export interface SourcesPanelProps {
    sources: BlockSource[];
    groups: DatabaseGroup[];
    /** Source ids currently on the canvas. */
    selected: Set<string>;
    onToggle: (id: string) => void;
    onToggleMany: (ids: string[], next: boolean) => void;
    /** The database a query attaches; others are reachable only by switching. */
    activeDb: string | null;
    onSelectDb: (dbPath: string) => void;
    /** Pipeline id -> display name. Ids without a name are not shown. */
    pipelineNames?: Record<string, string>;
}

/** Coarse relative age. Deliberately coarse: the decision a freshness stamp
 *  informs is "is this current enough to report on", which minutes do not
 *  change, and a precise timestamp invites false confidence in a cached read. */
function age(iso?: string): string | null {
    if (!iso) return null;
    const then = Date.parse(iso);
    if (!Number.isFinite(then)) return null;
    const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.round(hrs / 24)}d ago`;
}

function rows(n?: number): string | null {
    if (n == null) return null;
    if (n < 1000) return `${n} rows`;
    if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k rows`;
    return `${(n / 1_000_000).toFixed(1)}M rows`;
}

function SourceRow({
    source,
    checked,
    onToggle,
    pipelineNames,
}: {
    source: BlockSource;
    checked: boolean;
    onToggle: (id: string) => void;
    pipelineNames?: Record<string, string>;
}) {
    const meta = [rows(source.rows), age(source.lastWrittenAt)].filter(Boolean).join(' · ');
    // Only NAMED pipelines are shown. An unresolved id like `p_mtw3t3op_8wx0m`
    // is noise dressed as provenance — it answers "which pipeline" with a
    // string the reader cannot match to anything they have seen.
    const by = source.writtenBy.map(id => pipelineNames?.[id]).filter((n): n is string => !!n);
    return (
        <label className={`blk-src${checked ? '' : ' blk-src--off'}`}>
            <input type="checkbox" checked={checked} onChange={() => onToggle(source.id)} />
            <span className="blk-src-body">
                <span className="blk-src-name" title={source.id}>
                    {source.name}
                </span>
                {meta ? <span className="blk-src-meta">{meta}</span> : null}
                {by.length > 0 ? (
                    <span className="blk-src-by" title={`Written by ${by.join(', ')}`}>
                        {by.join(', ')}
                    </span>
                ) : null}
            </span>
        </label>
    );
}

export default function SourcesPanel({
    sources,
    groups,
    selected,
    onToggle,
    onToggleMany,
    activeDb,
    onSelectDb,
    pipelineNames,
}: SourcesPanelProps) {
    // Anything not inside a database file: parquet, csv, json, and whatever we
    // could not place. Listed second because it is the less constrained set.
    const grouped = new Set(groups.flatMap(g => g.sources.map(s => s.id)));
    const files = sources.filter(s => !grouped.has(s.id));

    const allOn = (ids: string[]) => ids.every(id => selected.has(id));

    return (
        <aside className="blk-sources">
            <div className="blk-sources-head">
                Sources <span>{selected.size} of {sources.length}</span>
            </div>

            {groups.map(g => {
                const ids = g.sources.map(s => s.id);
                const active = g.dbPath === activeDb;
                return (
                    <section key={g.dbPath} className="blk-src-group">
                        <header className="blk-src-group-head">
                            <Database size={13} strokeWidth={1.75} />
                            <button
                                type="button"
                                className={`blk-src-db${active ? ' blk-src-db--active' : ''}`}
                                title={
                                    active
                                        ? 'Queries attach this database'
                                        : `Switch queries to ${g.name}`
                                }
                                onClick={() => onSelectDb(g.dbPath)}
                            >
                                {g.name}
                                {active ? <Check size={12} /> : null}
                            </button>
                            <button
                                type="button"
                                className="blk-src-all"
                                onClick={() => onToggleMany(ids, !allOn(ids))}
                            >
                                {allOn(ids) ? 'none' : 'all'}
                            </button>
                        </header>
                        {g.sources.map(s => (
                            <SourceRow
                                key={s.id}
                                source={s}
                                checked={selected.has(s.id)}
                                onToggle={onToggle}
                                pipelineNames={pipelineNames}
                            />
                        ))}
                    </section>
                );
            })}

            {files.length > 0 ? (
                <section className="blk-src-group">
                    <header className="blk-src-group-head">
                        <FileText size={13} strokeWidth={1.75} />
                        <span className="blk-src-db">Files</span>
                        <button
                            type="button"
                            className="blk-src-all"
                            onClick={() =>
                                onToggleMany(
                                    files.map(s => s.id),
                                    !allOn(files.map(s => s.id)),
                                )
                            }
                        >
                            {allOn(files.map(s => s.id)) ? 'none' : 'all'}
                        </button>
                    </header>
                    {files.map(s => (
                        <SourceRow
                            key={s.id}
                            source={s}
                            checked={selected.has(s.id)}
                            onToggle={onToggle}
                            pipelineNames={pipelineNames}
                        />
                    ))}
                </section>
            ) : null}

            {sources.length === 0 ? (
                <div className="blk-src-empty">
                    <Layers size={14} />
                    <span>No durable datasets yet. Run a pipeline that writes one, then rescan.</span>
                </div>
            ) : null}
        </aside>
    );
}
