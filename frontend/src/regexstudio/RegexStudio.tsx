import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Pin, Search, Lock, Loader2, CircleCheck, CircleX } from 'lucide-react';
import { compile, findMatches, matches as re2matches, extract as re2extract, replace as re2replace } from './re2';
import type { Re2Match } from './re2';
import type { RegexStudioRequest, RegexStudioResult, RegexColumnFetch, RegexMode } from './types';
import './regexstudio.css';

const MODE_LABEL: Record<RegexMode, string> = {
    replace: 'Replace',
    extract: 'Extract',
    match: 'Match',
    quality: 'Quality',
};

interface Props {
    workspacePath?: string | null;
    openRequest: RegexStudioRequest | null;
    onApplyToNode?: (nodeId: string, result: RegexStudioResult) => void;
    // Pull the chosen column's values from the node's upstream (partial run).
    onFetchColumn?: (nodeId: string, column: string) => Promise<RegexColumnFetch>;
}

// A rendered piece of a test string: matched (with capture-group color) or not.
interface Segment {
    text: string;
    cls: string;
}

// Split a value into colored segments from its RE2 matches. Whole matches get a
// base highlight; capture groups 1..n get cycling colors (the innermost/last
// group covering a character wins — correct for adjacent groups like phone).
function segments(value: string, ms: Re2Match[]): Segment[] {
    if (ms.length === 0) return [{ text: value, cls: 'um' }];
    const cls = new Array<string>(value.length).fill('um');
    for (const m of ms) {
        for (let i = m.start; i < m.end; i++) cls[i] = 'g0';
        for (const g of m.groups) {
            if (g.index === 0 || g.start < 0) continue;
            const color = `cg${((g.index - 1) % 6) + 1}`;
            for (let i = g.start; i < g.end; i++) cls[i] = color;
        }
    }
    const out: Segment[] = [];
    for (let i = 0; i < value.length; ) {
        const c = cls[i];
        let j = i + 1;
        while (j < value.length && cls[j] === c) j++;
        out.push({ text: value.slice(i, j), cls: c });
        i = j;
    }
    return out;
}

export default function RegexStudio({ openRequest, onApplyToNode, onFetchColumn }: Props) {
    const lastNonce = useRef<number | null>(null);
    const [nodeId, setNodeId] = useState('');
    const [mode, setMode] = useState<RegexMode>('replace');
    const [nodeName, setNodeName] = useState<string | undefined>();
    const [columns, setColumns] = useState<{ name: string; type?: string }[]>([]);
    const [column, setColumn] = useState('');
    const [pattern, setPattern] = useState('');
    const [replacement, setReplacement] = useState('');
    const [groupIndex, setGroupIndex] = useState(0);
    const [groupNames, setGroupNames] = useState('');

    const [values, setValues] = useState<string[]>([]);
    const [colTotal, setColTotal] = useState(0);
    const [colError, setColError] = useState<string | undefined>();
    const [colLoading, setColLoading] = useState(false);
    const [filter, setFilter] = useState('');
    const [pinned, setPinned] = useState<string[]>([]);

    // Open / reopen: load the request into local state.
    useEffect(() => {
        if (!openRequest) return;
        if (openRequest.nonce === lastNonce.current) return;
        lastNonce.current = openRequest.nonce;
        setNodeId(openRequest.nodeId);
        setMode(openRequest.mode);
        setNodeName(openRequest.nodeName);
        setColumns(openRequest.columns ?? []);
        setColumn(openRequest.column ?? '');
        setPattern(openRequest.pattern ?? '');
        setReplacement(openRequest.replacement ?? '');
        setGroupIndex(openRequest.groupIndex ?? 0);
        setGroupNames(openRequest.groupNames ?? '');
        setPinned([]);
        setFilter('');
    }, [openRequest]);

    // Fetch the column's values whenever the node or column changes.
    useEffect(() => {
        if (!nodeId || !column || !onFetchColumn) {
            setValues([]);
            setColTotal(0);
            return;
        }
        let cancelled = false;
        setColLoading(true);
        setColError(undefined);
        onFetchColumn(nodeId, column)
            .then(r => {
                if (cancelled) return;
                setValues(r.values);
                setColTotal(r.total);
                setColError(r.error);
            })
            .catch(e => {
                if (!cancelled) setColError(e instanceof Error ? e.message : String(e));
            })
            .finally(() => {
                if (!cancelled) setColLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [nodeId, column, onFetchColumn]);

    const lint = useMemo(
        () => (pattern.trim() ? compile(pattern) : ({ ok: true, groupCount: 0 } as const)),
        [pattern],
    );

    const filtered = useMemo(() => {
        const f = filter.trim();
        const base = f ? values.filter(v => v.includes(f)) : values;
        return base.slice(0, 300);
    }, [values, filter]);

    const togglePin = (v: string) =>
        setPinned(p => (p.includes(v) ? p.filter(x => x !== v) : [...p, v]));

    const apply = () => {
        if (!onApplyToNode || !nodeId) return;
        const res: RegexStudioResult = { column, pattern };
        if (mode === 'replace') res.replacement = replacement;
        if (mode === 'extract') {
            res.groupIndex = groupIndex;
            res.groupNames = groupNames;
        }
        onApplyToNode(nodeId, res);
    };

    // Per-test outcome for the current mode; guards against invalid patterns.
    function preview(value: string) {
        if (!lint.ok || !pattern.trim()) {
            return { kind: 'idle' as const, ms: [] as Re2Match[] };
        }
        try {
            const ms = findMatches(pattern, value);
            if (mode === 'replace') {
                return { kind: 'replace' as const, ms, out: re2replace(pattern, value, replacement) };
            }
            if (mode === 'extract') {
                return { kind: 'extract' as const, ms, out: re2extract(pattern, value, groupIndex) };
            }
            // match + quality both boil down to a boolean
            return { kind: 'bool' as const, ms, hit: re2matches(pattern, value) };
        } catch (e) {
            return { kind: 'error' as const, ms: [] as Re2Match[], msg: e instanceof Error ? e.message : String(e) };
        }
    }

    if (!openRequest) {
        return (
            <div className="rgx rgx-empty">
                <p>Open a Regex Studio node and pick a column to start.</p>
            </div>
        );
    }

    const passCount = pinned.filter(v => {
        const p = preview(v);
        return p.kind === 'bool' ? p.hit : p.ms.length > 0;
    }).length;

    return (
        <div className="rgx">
            {/* top bar */}
            <div className="rgx-top">
                <div className="rgx-node">
                    <div className="rgx-node-ico">.*</div>
                    <div className="rgx-node-t">
                        <b>{nodeName || 'Regex Studio'}</b>
                        <small>
                            column <code>{column || '—'}</code>
                        </small>
                    </div>
                </div>
                <div className="rgx-mode">
                    <Lock size={11} /> Mode: {MODE_LABEL[mode]}
                </div>
                <div className="rgx-grow" />
                <button className="rgx-apply" onClick={apply} disabled={!lint.ok || !column}>
                    <Check size={14} /> Apply to node
                </button>
            </div>

            {/* pattern block */}
            <div className="rgx-pat">
                <div className="rgx-field">
                    <label>Column</label>
                    <select value={column} onChange={e => setColumn(e.target.value)}>
                        {column && !columns.some(c => c.name === column) && (
                            <option value={column}>{column}</option>
                        )}
                        {columns.map(c => (
                            <option key={c.name} value={c.name}>
                                {c.name}
                                {c.type ? ` — ${c.type}` : ''}
                            </option>
                        ))}
                    </select>
                </div>
                <div className="rgx-field">
                    <label>Pattern</label>
                    <input
                        className="rgx-mono"
                        spellCheck={false}
                        value={pattern}
                        placeholder="RE2 pattern, e.g. (\d{3})(\d{3})(\d{4})"
                        onChange={e => setPattern(e.target.value)}
                    />
                </div>
                {mode === 'replace' && (
                    <div className="rgx-field">
                        <label>Replacement</label>
                        <input
                            className="rgx-mono"
                            spellCheck={false}
                            value={replacement}
                            placeholder="use \1 \2 for capture groups (RE2 syntax)"
                            onChange={e => setReplacement(e.target.value)}
                        />
                    </div>
                )}
                {mode === 'extract' && (
                    <>
                        <div className="rgx-field rgx-field--sm">
                            <label>Group</label>
                            <input
                                type="number"
                                min={0}
                                value={groupIndex}
                                onChange={e => setGroupIndex(Math.max(0, Number(e.target.value) || 0))}
                            />
                        </div>
                        <div className="rgx-field">
                            <label>Group names</label>
                            <input
                                className="rgx-mono"
                                spellCheck={false}
                                value={groupNames}
                                placeholder="optional: id, type — emits a STRUCT"
                                onChange={e => setGroupNames(e.target.value)}
                            />
                        </div>
                    </>
                )}
                <div className={`rgx-lint ${lint.ok ? 'ok' : 'bad'}`}>
                    {lint.ok ? (
                        <>
                            <CircleCheck size={13} /> RE2 valid — DuckDB compatible
                            {lint.groupCount > 0 && (
                                <span className="rgx-lint-note">
                                    {lint.groupCount} capture group{lint.groupCount > 1 ? 's' : ''}
                                </span>
                            )}
                        </>
                    ) : (
                        <>
                            <CircleX size={13} /> Not valid for DuckDB (RE2): {lint.message}
                        </>
                    )}
                </div>
            </div>

            {/* split: column data | tests */}
            <div className="rgx-split">
                <div className="rgx-col">
                    <div className="rgx-panel-head">
                        <span className="ttl">Column data</span>
                        <span className="cnt">
                            {colLoading ? <Loader2 size={12} className="rgx-spin" /> : `${colTotal} rows`}
                        </span>
                    </div>
                    <div className="rgx-filter">
                        <Search size={13} />
                        <input
                            value={filter}
                            placeholder="Contains…"
                            onChange={e => setFilter(e.target.value)}
                        />
                    </div>
                    <div className="rgx-col-rows">
                        {colError && <div className="rgx-col-err">{colError}</div>}
                        {!colError && filtered.length === 0 && !colLoading && (
                            <div className="rgx-col-empty">No values.</div>
                        )}
                        {filtered.map((v, i) => {
                            const on = pinned.includes(v);
                            return (
                                <button
                                    key={`${v}-${i}`}
                                    className={`rgx-col-row${on ? ' pinned' : ''}`}
                                    onClick={() => togglePin(v)}
                                    title={on ? 'Unpin' : 'Pin to test area'}
                                >
                                    <span className="v">{v === '' ? '∅ empty' : v}</span>
                                    <Pin size={12} className="pin" />
                                </button>
                            );
                        })}
                    </div>
                </div>

                <div className="rgx-tests">
                    <div className="rgx-panel-head">
                        <span className="ttl">Test area — pinned records</span>
                        <span className="cnt">
                            {pinned.length} pinned{pinned.length ? ` · ${passCount} match` : ''}
                        </span>
                    </div>
                    <div className="rgx-test-rows">
                        {pinned.length === 0 && (
                            <div className="rgx-test-empty">
                                Pin records from the column data to preview them here.
                            </div>
                        )}
                        {pinned.map((v, i) => {
                            const p = preview(v);
                            return (
                                <div className="rgx-test" key={`${v}-${i}`}>
                                    <div className="rgx-test-in">
                                        {segments(v, p.ms).map((s, j) => (
                                            <span key={j} className={`seg ${s.cls}`}>
                                                {s.text === '' ? '∅' : s.text}
                                            </span>
                                        ))}
                                    </div>
                                    {p.kind === 'replace' && (
                                        <>
                                            <div className="rgx-arrow">replace →</div>
                                            <div className="rgx-test-out">{p.out}</div>
                                        </>
                                    )}
                                    {p.kind === 'extract' && (
                                        <>
                                            <div className="rgx-arrow">extract →</div>
                                            <div className="rgx-test-out">
                                                {p.out === '' ? <span className="muted">(no capture)</span> : p.out}
                                            </div>
                                        </>
                                    )}
                                    <div className="rgx-test-status">
                                        {p.kind === 'bool' && (
                                            <span className={`tag ${p.hit ? 'ok' : 'no'}`}>
                                                {p.hit ? 'match' : 'no match'}
                                            </span>
                                        )}
                                        {(p.kind === 'replace' || p.kind === 'extract') && (
                                            <span className={`tag ${p.ms.length ? 'ok' : 'no'}`}>
                                                {p.ms.length ? `${p.ms.length} match${p.ms.length > 1 ? 'es' : ''}` : 'no match'}
                                            </span>
                                        )}
                                        {p.kind === 'error' && <span className="tag err">{p.msg}</span>}
                                        {p.kind === 'idle' && <span className="muted">enter a valid pattern</span>}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            </div>
        </div>
    );
}
