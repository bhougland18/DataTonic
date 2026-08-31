import { useEffect, useMemo, useState } from 'react';
import { Search, ChevronDown, Play, Loader2, Plus, Trash2, Boxes } from 'lucide-react';
import type { IonApiConfig } from './ionapi';
import type { IonApiToken } from './inforAuth';
import { listBusinessClasses, type BusinessClass } from './discovery';
import { runGenericQuery, sampleFields, type FilterCondition } from './query';
import type { GenericPage } from './inforApi';

interface InforWorkspaceProps {
    config: IonApiConfig;
    token: IonApiToken;
    workspacePath: string | null;
}

const PAGE_SIZE = 25;

// The signed-in Infor experience (tasks 1g/1o/1p): pick a business class, choose
// fields + a filter, run the `_generic` list, and see the rows in a grid.
// Mirrors the approved Query-Properties mockup.
export default function InforWorkspace({ config, token, workspacePath }: InforWorkspaceProps) {
    // ---- business-class discovery ----
    const [search, setSearch] = useState('');
    const [classes, setClasses] = useState<BusinessClass[]>([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [listLoading, setListLoading] = useState(false);
    const [listError, setListError] = useState<string | null>(null);
    const [selected, setSelected] = useState<BusinessClass | null>(null);
    const [pickerOpen, setPickerOpen] = useState(true);

    // ---- query state (per selected class) ----
    const [fields, setFields] = useState<string[]>([]);
    const [checked, setChecked] = useState<Set<string>>(new Set());
    const [fieldsLoading, setFieldsLoading] = useState(false);
    const [conds, setConds] = useState<FilterCondition[]>([]);
    const [limit, setLimit] = useState(25);
    const [running, setRunning] = useState(false);
    const [result, setResult] = useState<GenericPage | null>(null);
    const [queryError, setQueryError] = useState<string | null>(null);

    // Load a page of classes (debounced on search).
    useEffect(() => {
        let cancelled = false;
        setListLoading(true);
        setListError(null);
        const t = setTimeout(async () => {
            const res = await listBusinessClasses(
                config,
                token.accessToken,
                { page, pageSize: PAGE_SIZE, search },
                workspacePath,
            );
            if (cancelled) return;
            setListLoading(false);
            if (!res.ok) {
                setListError(res.error);
                return;
            }
            setClasses(res.page.items);
            setTotal(res.page.total);
        }, 250);
        return () => {
            cancelled = true;
            clearTimeout(t);
        };
    }, [config, token.accessToken, workspacePath, search, page]);

    const selectClass = async (bc: BusinessClass) => {
        setSelected(bc);
        setPickerOpen(false);
        setResult(null);
        setQueryError(null);
        setConds([]);
        setFields([]);
        setChecked(new Set());
        setFieldsLoading(true);
        const res = await sampleFields(config, token.accessToken, bc.entity, workspacePath);
        setFieldsLoading(false);
        if (res.ok) {
            setFields(res.fields);
            setChecked(new Set(res.fields)); // default: all sampled fields
        }
    };

    const toggleField = (f: string) =>
        setChecked((prev) => {
            const next = new Set(prev);
            if (next.has(f)) next.delete(f);
            else next.add(f);
            return next;
        });

    const runQuery = async () => {
        if (!selected) return;
        setRunning(true);
        setQueryError(null);
        setResult(null);
        const res = await runGenericQuery(
            config,
            token.accessToken,
            selected.entity,
            { fields: fields.filter((f) => checked.has(f)), filter: conds, limit },
            workspacePath,
        );
        setRunning(false);
        if (!res.ok) {
            setQueryError(`HTTP ${res.status} — ${res.error}`);
            return;
        }
        setResult(res.page);
    };

    const columns = useMemo(() => {
        const active = fields.filter((f) => checked.has(f));
        if (active.length) return active;
        // Fall back to whatever keys the rows actually have.
        return result?.rows.length ? Object.keys(result.rows[0]) : [];
    }, [fields, checked, result]);

    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

    return (
        <div className="pgi">
            {/* ---- Business class ---- */}
            <div className="pgi-section">
                <div className="pgi-lbl">Business class</div>
                {selected && !pickerOpen ? (
                    <button type="button" className="pgi-selected" onClick={() => setPickerOpen(true)}>
                        <span className="pgi-selected-nm">{selected.entity}</span>
                        <span className="pgi-selected-change">
                            change <ChevronDown size={13} />
                        </span>
                    </button>
                ) : (
                    <>
                        <div className="pgi-search">
                            <Search size={13} strokeWidth={2} />
                            <input
                                autoFocus
                                placeholder="Search business classes…"
                                value={search}
                                onChange={(e) => {
                                    setSearch(e.target.value);
                                    setPage(1);
                                }}
                            />
                            {listLoading && <Loader2 size={13} className="pg-spin" />}
                        </div>
                        {listError && <div className="pg-note" style={{ color: 'var(--danger)' }}>{listError}</div>}
                        <div className="pgi-classlist">
                            {classes.map((c) => (
                                <button
                                    key={c.entity}
                                    type="button"
                                    className={`pgi-class${selected?.entity === c.entity ? ' pgi-class--sel' : ''}`}
                                    onClick={() => void selectClass(c)}
                                    title={c.desc}
                                >
                                    <span className="pgi-class-nm">{c.entity}</span>
                                    {c.category && <span className="pgi-class-cat">{c.category}</span>}
                                </button>
                            ))}
                            {!listLoading && classes.length === 0 && (
                                <div className="pg-note">No business classes match.</div>
                            )}
                        </div>
                        <div className="pgi-pager">
                            <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                                ‹
                            </button>
                            <span>
                                {total.toLocaleString()} classes · page {page}/{totalPages}
                            </span>
                            <button
                                type="button"
                                disabled={page >= totalPages}
                                onClick={() => setPage((p) => p + 1)}
                            >
                                ›
                            </button>
                        </div>
                    </>
                )}
            </div>

            {selected && !pickerOpen && (
                <>
                    {/* ---- Fields ---- */}
                    <div className="pgi-section">
                        <div className="pgi-section-head">
                            <div className="pgi-lbl">
                                Fields <span className="pgi-maps">→ _fields</span>
                            </div>
                            <div className="pgi-acts">
                                <a onClick={() => setChecked(new Set(fields))}>All</a>
                                <a onClick={() => setChecked(new Set())}>None</a>
                            </div>
                        </div>
                        {fieldsLoading ? (
                            <div className="pg-note">
                                <Loader2 size={13} className="pg-spin" /> Loading fields…
                            </div>
                        ) : (
                            <div className="pgi-fieldbox">
                                {fields.map((f) => (
                                    <label key={f} className="pgi-fl">
                                        <input
                                            type="checkbox"
                                            checked={checked.has(f)}
                                            onChange={() => toggleField(f)}
                                        />
                                        <span>{f}</span>
                                    </label>
                                ))}
                                {fields.length === 0 && (
                                    <div className="pg-note">No sample fields — the class may have no rows.</div>
                                )}
                            </div>
                        )}
                        <div className="pgi-foot">{checked.size} selected</div>
                    </div>

                    {/* ---- Filter ---- */}
                    <div className="pgi-section">
                        <div className="pgi-section-head">
                            <div className="pgi-lbl">
                                Filter <span className="pgi-maps">→ _filter</span>
                            </div>
                        </div>
                        <div className="pgi-filters">
                            {conds.map((c, i) => (
                                <div className="pgi-frow" key={i}>
                                    <input
                                        className="pg-input"
                                        placeholder="Field"
                                        value={c.field}
                                        onChange={(e) =>
                                            setConds((cs) =>
                                                cs.map((x, j) => (j === i ? { ...x, field: e.target.value } : x)),
                                            )
                                        }
                                    />
                                    <span className="pgi-op">::</span>
                                    <input
                                        className="pg-input"
                                        placeholder="Value"
                                        value={c.value}
                                        onChange={(e) =>
                                            setConds((cs) =>
                                                cs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)),
                                            )
                                        }
                                    />
                                    <button
                                        type="button"
                                        className="pg-icon-btn"
                                        onClick={() => setConds((cs) => cs.filter((_, j) => j !== i))}
                                    >
                                        <Trash2 size={13} />
                                    </button>
                                </div>
                            ))}
                            <button
                                type="button"
                                className="pgi-add"
                                onClick={() => setConds((cs) => [...cs, { field: '', value: '' }])}
                            >
                                <Plus size={13} /> Add condition
                            </button>
                        </div>
                    </div>

                    {/* ---- Run ---- */}
                    <div className="pgi-run">
                        <label className="pgi-limit">
                            <span>Limit</span>
                            <input
                                type="number"
                                min={1}
                                value={limit}
                                onChange={(e) => setLimit(Math.max(1, Number(e.target.value) || 1))}
                            />
                        </label>
                        <button
                            type="button"
                            className="pg-btn pg-btn--primary"
                            disabled={running || checked.size === 0}
                            onClick={() => void runQuery()}
                        >
                            {running ? <Loader2 size={14} className="pg-spin" /> : <Play size={14} strokeWidth={2} />}
                            Run query
                        </button>
                    </div>

                    {queryError && (
                        <div className="pg-errors" role="alert">
                            <div className="pg-errors-head">Query failed</div>
                            <ul>
                                <li>
                                    <span>{queryError}</span>
                                </li>
                            </ul>
                        </div>
                    )}

                    {result && (
                        <div className="pgi-results">
                            <div className="pgi-results-bar">
                                <Boxes size={13} strokeWidth={2} /> {result.rows.length} row
                                {result.rows.length === 1 ? '' : 's'}
                                {result.next ? ' · more available' : ''}
                            </div>
                            <div className="pgi-grid-wrap">
                                <table className="pgi-grid">
                                    <thead>
                                        <tr>
                                            <th className="pgi-rownum">#</th>
                                            {columns.map((col) => (
                                                <th key={col}>{col}</th>
                                            ))}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {result.rows.map((row, i) => (
                                            <tr key={i}>
                                                <td className="pgi-rownum">{i + 1}</td>
                                                {columns.map((col) => (
                                                    <td key={col}>{formatCell(row[col])}</td>
                                                ))}
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    )}
                </>
            )}
        </div>
    );
}

function formatCell(v: unknown): string {
    if (v === null || v === undefined) return '';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
}
