import { useEffect, useMemo, useRef, useState } from 'react';
import {
    Check,
    Pin,
    Search,
    Lock,
    Loader2,
    CircleCheck,
    CircleX,
    Sparkles,
    PanelRightClose,
    PanelRightOpen,
    BookMarked,
    Download,
    Upload,
    Save,
    RotateCw,
    Trash2,
    X,
    HelpCircle,
} from 'lucide-react';
import { compile, findMatches, matches as re2matches, extract as re2extract, replace as re2replace } from './re2';
import type { Re2Match } from './re2';
import { explain } from './explain';
import type { ExplainNode } from './explain';
import {
    loadLibrary,
    saveLibrary,
    upsertPattern,
    removePattern,
    newPatternId,
    exportLibrary,
    importLibrary,
    DESCRIPTION_MAX,
    type SavedPattern,
    type RegexTest,
    type PatternScope,
} from './library';
import { chatSend, type ChatMessage } from '../tauri-bridge';
import { isTauri } from '../tauri-dialog';
import { maybeStartEditorTour, startEditorTour } from '../GuidedTour';
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
    onFetchColumn?: (nodeId: string, column: string) => Promise<RegexColumnFetch>;
}

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

// Deterministic explanation, rendered as nested cards.
function ExplainCards({ nodes }: { nodes: ExplainNode[] }) {
    return (
        <>
            {nodes.map((n, i) => (
                <div key={i} className={`rgx-exc ${n.kind}`}>
                    <div className="row">
                        <span className="sym">{n.sym}</span>
                        <span className="ttl">{n.title}.</span> <span className="desc">{n.desc}</span>
                    </div>
                    {n.children && n.children.length > 0 && (
                        <div className="nest">
                            <ExplainCards nodes={n.children} />
                        </div>
                    )}
                    {n.kind === 'group' && <div className="close">)</div>}
                </div>
            ))}
        </>
    );
}

// Pull a regex out of an assistant reply: a ```regex/``` fence, else a lone /…/,
// else a single-line body that looks like a pattern.
function extractPattern(text: string): string | null {
    const fence = text.match(/```(?:regex|re)?\s*([\s\S]*?)```/i);
    if (fence) return fence[1].trim().split('\n')[0].trim();
    const slash = text.match(/(?:^|\s)\/(.+?)\/[a-z]*(?:\s|$)/);
    if (slash) return slash[1];
    return null;
}

interface ChatTurn {
    role: 'user' | 'assistant';
    content: string;
    // Auto-generated correction turns (the verify-and-retry loop) render subtly.
    auto?: boolean;
}

const MAX_AI_ATTEMPTS = 4; // 1 draft + up to 3 self-corrections

export default function RegexStudio({ workspacePath, openRequest, onApplyToNode, onFetchColumn }: Props) {
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
    const [expected, setExpected] = useState<Record<string, string>>({});

    // Library
    const [library, setLibrary] = useState<SavedPattern[]>([]);
    const [libFilter, setLibFilter] = useState('');
    // Inline save bar: a title + short description (also fed to the AI as intent)
    // + a Local/Global scope, saved from the toolbar row under the pattern.
    const [title, setTitle] = useState('');
    const [descr, setDescr] = useState('');
    const [scope, setScope] = useState<PatternScope>('workspace');
    const [savedFlash, setSavedFlash] = useState(false);

    // Persistent AI chat (collapsible, open by default)
    const [chatOpen, setChatOpen] = useState(true);
    const [chatTurns, setChatTurns] = useState<ChatTurn[]>([]);
    const [chatInput, setChatInput] = useState('');
    const [chatStreaming, setChatStreaming] = useState(false);
    const [chatError, setChatError] = useState<string | null>(null);
    const chatBodyRef = useRef<HTMLDivElement>(null);

    // One-shot "Explain with AI" (kept OUT of the chat)
    const [oneShotOpen, setOneShotOpen] = useState(false);
    const [oneShot, setOneShot] = useState('');
    const [oneShotStreaming, setOneShotStreaming] = useState(false);
    const [oneShotError, setOneShotError] = useState<string | null>(null);

    const desktopAi = isTauri();

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
        setExpected({});
        setFilter('');
        setChatTurns([]);
        setChatError(null);
        setOneShotOpen(false);
        setTitle('');
        setDescr('');
        setScope('workspace');
        // First time this editor is opened, walk the Regex Studio tour once.
        maybeStartEditorTour('regex');
    }, [openRequest]);

    // Load the saved-pattern library for this workspace.
    useEffect(() => {
        setLibrary(loadLibrary(workspacePath));
    }, [workspacePath]);

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
    const explanation = useMemo(
        () => (lint.ok && pattern.trim() ? explain(pattern) : []),
        [lint.ok, pattern],
    );

    const filtered = useMemo(() => {
        const f = filter.trim();
        const base = f ? values.filter(v => v.includes(f)) : values;
        return base.slice(0, 300);
    }, [values, filter]);

    const libFiltered = useMemo(() => {
        const f = libFilter.trim().toLowerCase();
        return f
            ? library.filter(
                  p =>
                      p.name.toLowerCase().includes(f) ||
                      p.pattern.toLowerCase().includes(f) ||
                      (p.description ?? '').toLowerCase().includes(f),
              )
            : library;
    }, [library, libFilter]);
    const libGlobal = useMemo(() => libFiltered.filter(p => p.scope === 'global'), [libFiltered]);
    const libWorkspace = useMemo(() => libFiltered.filter(p => p.scope !== 'global'), [libFiltered]);

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
            return { kind: 'bool' as const, ms, hit: re2matches(pattern, value) };
        } catch (e) {
            return { kind: 'error' as const, ms: [] as Re2Match[], msg: e instanceof Error ? e.message : String(e) };
        }
    }

    const expectedPlaceholder =
        mode === 'match' || mode === 'quality'
            ? 'expect: match / no'
            : mode === 'extract'
              ? 'expected capture'
              : 'expected output';

    // Interpret a free-text expectation for match/quality modes as a boolean.
    const boolExpected = (s: string): boolean | null => {
        const t = s.trim().toLowerCase();
        if (['match', 'matches', 'yes', 'true', 'pass', 'y', '1'].includes(t)) return true;
        if (['no match', 'nomatch', 'no', 'false', 'fail', 'n', '0'].includes(t)) return false;
        return null;
    };

    // Compare an expectation against the live outcome: 'pass' | 'fail' | null
    // (null when nothing is expected or it can't be interpreted).
    const checkExpected = (exp: string, p: ReturnType<typeof preview>): 'pass' | 'fail' | null => {
        if (!exp.trim()) return null;
        if (p.kind === 'bool') {
            const want = boolExpected(exp);
            return want === null ? null : want === p.hit ? 'pass' : 'fail';
        }
        if (p.kind === 'replace' || p.kind === 'extract') {
            return exp.trim() === (p.out ?? '').trim() ? 'pass' : 'fail';
        }
        return null;
    };

    // ---- Library actions ----
    const currentTests = (): RegexTest[] =>
        pinned.map(v => ({ value: v, expected: expected[v] || undefined }));

    const doSave = () => {
        const name = title.trim();
        if (!name || !pattern.trim() || !lint.ok) return;
        const p: SavedPattern = {
            id: newPatternId(),
            name,
            description: descr.trim().slice(0, DESCRIPTION_MAX) || undefined,
            scope,
            mode,
            pattern,
            replacement: mode === 'replace' ? replacement : undefined,
            groupIndex: mode === 'extract' ? groupIndex : undefined,
            groupNames: mode === 'extract' ? groupNames : undefined,
            tests: currentTests(),
            updatedAt: Date.now(),
        };
        const next = upsertPattern(library, p);
        setLibrary(next);
        saveLibrary(workspacePath, next);
        setSavedFlash(true);
        setTimeout(() => setSavedFlash(false), 1400);
    };

    const applySaved = (p: SavedPattern) => {
        setPattern(p.pattern);
        setTitle(p.name);
        setDescr(p.description ?? '');
        setScope(p.scope);
        if (p.replacement !== undefined) setReplacement(p.replacement);
        if (p.groupIndex !== undefined) setGroupIndex(p.groupIndex);
        if (p.groupNames !== undefined) setGroupNames(p.groupNames);
        if (p.tests && p.tests.length) {
            setPinned(p.tests.map(t => t.value));
            const exp: Record<string, string> = {};
            for (const t of p.tests) if (t.expected) exp[t.value] = t.expected;
            setExpected(exp);
        }
    };

    const deleteSaved = (id: string) => {
        const next = removePattern(library, id);
        setLibrary(next);
        saveLibrary(workspacePath, next);
    };

    const doExport = () => void exportLibrary(library);
    const exportOne = (p: SavedPattern) => void exportLibrary([p]);
    const doImport = async () => {
        const imported = await importLibrary();
        if (!imported) return;
        let next = library;
        for (const p of imported) next = upsertPattern(next, { ...p, id: p.id || newPatternId() });
        setLibrary(next);
        saveLibrary(workspacePath, next);
    };

    const renderLibItem = (p: SavedPattern) => (
        <div key={p.id} className="rgx-lib-item" onClick={() => applySaved(p)} title="Apply to editor">
            <div className="nm">
                <span className="label">{p.name}</span>
                <span className="badge">{p.mode}</span>
                <button
                    className="act"
                    title="Export this pattern to .json"
                    onClick={e => {
                        e.stopPropagation();
                        exportOne(p);
                    }}
                >
                    <Upload size={12} />
                </button>
                <button
                    className="act del"
                    title="Delete this pattern"
                    onClick={e => {
                        e.stopPropagation();
                        deleteSaved(p.id);
                    }}
                >
                    <Trash2 size={12} />
                </button>
            </div>
            {p.description && <div className="descr">{p.description}</div>}
            <div className="pat">{p.pattern}</div>
            {p.tests && p.tests.length > 0 && (
                <div className="meta">
                    {p.tests.length} test{p.tests.length > 1 ? 's' : ''}
                </div>
            )}
        </div>
    );

    // ---- AI ----
    interface Labeled {
        value: string;
        expected: string;
    }
    // Pinned tests that carry an explicit expectation — the AI's hard constraints.
    const labeled = (): Labeled[] =>
        pinned
            .filter(v => (expected[v] ?? '').trim())
            .map(v => ({ value: v, expected: (expected[v] ?? '').trim() }));

    // Evaluate a CANDIDATE pattern against the labeled tests; return the misses.
    // This is what closes the loop: the model's draft is checked with real RE2
    // before we accept it.
    const verifyCandidate = (pat: string): { value: string; want: string; got: string }[] => {
        const fails: { value: string; want: string; got: string }[] = [];
        for (const { value, expected: exp } of labeled()) {
            let got = '';
            let ok = false;
            try {
                if (mode === 'match' || mode === 'quality') {
                    const hit = re2matches(pat, value);
                    got = hit ? 'match' : 'no match';
                    const want = boolExpected(exp);
                    ok = want === null ? true : want === hit;
                } else if (mode === 'replace') {
                    got = re2replace(pat, value, replacement);
                    ok = got.trim() === exp.trim();
                } else {
                    got = re2extract(pat, value, groupIndex);
                    ok = got.trim() === exp.trim();
                }
            } catch {
                got = '(invalid)';
                ok = false;
            }
            if (!ok) fails.push({ value, want: exp, got });
        }
        return fails;
    };

    function aiContext(): string {
        const lines: string[] = [];
        lines.push(
            'You write ONE regular expression for DuckDB, which uses the Google RE2 engine. ' +
                'RE2 does NOT support lookahead, lookbehind, or backreferences — never use them. ' +
                'Replacement backreferences use \\1 \\2 (not $1).',
        );
        lines.push(`Task: ${MODE_LABEL[mode]} on column "${column}".`);
        if (title.trim()) {
            lines.push(
                `Intent: this regex represents "${title.trim()}"${descr.trim() ? ` — ${descr.trim()}` : ''}. ` +
                    'Match that real-world format in general.',
            );
        }
        lines.push(
            'IMPORTANT: the example values are ILLUSTRATIVE samples of the format, NOT the only valid values. ' +
                'Do NOT hardcode specific digits or letters from any single example (e.g. never force a literal leading "99"); ' +
                'write the general pattern for the format.',
        );

        const L = labeled();
        if (mode === 'match' || mode === 'quality') {
            const pos = L.filter(x => boolExpected(x.expected) === true).map(x => x.value);
            const neg = L.filter(x => boolExpected(x.expected) === false).map(x => x.value);
            if (pos.length || neg.length) {
                lines.push('HARD REQUIREMENTS — your regex MUST satisfy EVERY example below:');
                if (pos.length) lines.push(`- MUST fully match: ${pos.map(v => JSON.stringify(v)).join(', ')}`);
                if (neg.length) lines.push(`- MUST NOT match: ${neg.map(v => JSON.stringify(v)).join(', ')}`);
                lines.push('Mentally test the regex against each example before answering; if any fails, fix it.');
            }
        } else if (L.length) {
            lines.push('HARD REQUIREMENTS — produce EXACTLY these transformations:');
            for (const x of L) lines.push(`- ${JSON.stringify(x.value)}  ->  ${JSON.stringify(x.expected)}`);
            lines.push('Verify each transformation before answering.');
        }

        const unlabeled = pinned.filter(v => !(expected[v] ?? '').trim());
        if (unlabeled.length) {
            lines.push(
                `Other sample values (no stated expectation): ${unlabeled.slice(0, 10).map(v => JSON.stringify(v)).join(', ')}.`,
            );
        } else if (values.length && L.length === 0) {
            lines.push(`Sample values: ${values.slice(0, 15).map(v => JSON.stringify(v)).join(', ')}.`);
        }
        if (pattern.trim()) {
            lines.push(
                `Current pattern: /${pattern}/${mode === 'replace' && replacement ? ` with replacement ${replacement}` : ''}.`,
            );
        }
        lines.push('Return the regex inside a ```regex fenced block, then one short line explaining it.');
        return lines.join('\n');
    }

    const buildCorrection = (
        draft: string,
        fails: { value: string; want: string; got: string }[],
    ): string => {
        const lines = [`Your pattern /${draft}/ FAILED these required examples:`];
        for (const f of fails) {
            lines.push(`- ${JSON.stringify(f.value)} → your regex gives "${f.got}", but it MUST be "${f.want}".`);
        }
        lines.push(
            'Return a corrected RE2 regex in a ```regex block that satisfies ALL required examples. Do not repeat the failing pattern.',
        );
        return lines.join('\n');
    };

    // Drive the model with a verify-and-retry loop: draft → check the draft
    // against the labeled expectations with real RE2 → if any fail, feed back the
    // exact misses and ask again, up to MAX_AI_ATTEMPTS. Small local models get
    // far more reliable with this closed loop than with a single shot.
    const runAgent = async (seed: string) => {
        if (chatStreaming || !seed.trim()) return;
        setChatError(null);
        const history: ChatMessage[] = chatTurns.map(t => ({ role: t.role, content: t.content }) as ChatMessage);
        history.push({ role: 'user', content: seed });
        setChatTurns(t => [...t, { role: 'user', content: seed }]);
        setChatStreaming(true);
        try {
            for (let attempt = 1; attempt <= MAX_AI_ATTEMPTS; attempt++) {
                setChatTurns(t => [...t, { role: 'assistant', content: '' }]);
                let acc = '';
                await chatSend(
                    history,
                    e => {
                        if (e.kind === 'token') {
                            acc += e.text;
                            setChatTurns(t => {
                                const c = [...t];
                                c[c.length - 1] = { role: 'assistant', content: acc };
                                return c;
                            });
                            chatBodyRef.current?.scrollTo({ top: chatBodyRef.current.scrollHeight });
                        } else if (e.kind === 'error') {
                            setChatError(e.message);
                        }
                    },
                    workspacePath,
                    aiContext(),
                );
                history.push({ role: 'assistant', content: acc });
                const draft = extractPattern(acc);
                const fails = draft ? verifyCandidate(draft) : [];
                if (!draft || labeled().length === 0 || fails.length === 0) break;
                if (attempt >= MAX_AI_ATTEMPTS) {
                    setChatTurns(t => [
                        ...t,
                        {
                            role: 'assistant',
                            auto: true,
                            content: `⚠︎ ${fails.length} expected test${fails.length > 1 ? 's' : ''} still unmet after ${attempt} tries. Refine the pattern or adjust the expectations.`,
                        },
                    ]);
                    break;
                }
                history.push({ role: 'user', content: buildCorrection(draft, fails) });
                setChatTurns(t => [
                    ...t,
                    {
                        role: 'user',
                        auto: true,
                        content: `Auto-check: ${fails.length} test${fails.length > 1 ? 's' : ''} still failing — retrying.`,
                    },
                ]);
            }
        } finally {
            setChatStreaming(false);
        }
    };

    const sendChat = () => {
        const q = chatInput.trim();
        if (!q) return;
        setChatInput('');
        void runAgent(q);
    };

    const runOneShot = async () => {
        if (!pattern.trim() || oneShotStreaming) return;
        setOneShotOpen(true);
        setOneShot('');
        setOneShotError(null);
        setOneShotStreaming(true);
        // A COMPACT token summary (not the full nested tree) — the full breakdown
        // tempted the small model into enumerating example matches endlessly.
        const summary = explanation.map(n => `${n.sym} = ${n.title.toLowerCase()}`).join('; ');
        const parts: string[] = [];
        if (title.trim()) parts.push(`Intent: "${title.trim()}"${descr.trim() ? ` — ${descr.trim()}` : ''}.`);
        parts.push(
            `Pattern (RE2): /${pattern}/${mode === 'replace' && replacement ? `  replacement: ${replacement}` : ''}`,
        );
        if (summary) parts.push(`Tokens: ${summary}.`);
        parts.push('In 2–3 short sentences, describe what this matches. Expand only slightly on the tokens.');
        let acc = '';
        let capped = false;
        const CAP = 600; // hard stop so a runaway model can't flood the panel
        await chatSend(
            [{ role: 'user', content: parts.join('\n') }],
            e => {
                if (capped) return;
                if (e.kind === 'token') {
                    acc += e.text;
                    if (acc.length > CAP) {
                        capped = true;
                        setOneShot(acc.slice(0, CAP).trimEnd() + '…');
                        setOneShotStreaming(false);
                        return;
                    }
                    setOneShot(acc);
                } else if (e.kind === 'error') {
                    setOneShotError(e.message);
                }
            },
            workspacePath,
            'You are a regex tutor for DuckDB RE2 patterns. In 2–3 short sentences, plainly describe what the pattern ' +
                'matches, expanding only slightly on the token list the user gives. Do NOT list example strings, sample ' +
                'values, or enumerate matches. No bullet lists, no code fences, no examples — just a short description.',
        );
        if (!capped) setOneShotStreaming(false);
    };

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
            {/* ---- Library (left) ---- */}
            <aside className="rgx-lib" data-tour="regex-library">
                <div className="rgx-lib-head">
                    <BookMarked size={15} />
                    <h2>Pattern Library</h2>
                </div>
                <div className="rgx-lib-actions">
                    <button onClick={doImport} title="Import a .json library">
                        <Download size={13} /> Import
                    </button>
                    <button onClick={doExport} title="Export the library to .json" disabled={!library.length}>
                        <Upload size={13} /> Export
                    </button>
                </div>
                <div className="rgx-lib-search">
                    <Search size={13} />
                    <input value={libFilter} placeholder="Filter patterns…" onChange={e => setLibFilter(e.target.value)} />
                </div>
                <div className="rgx-lib-list">
                    {library.length === 0 && (
                        <div className="rgx-lib-empty">No saved patterns yet. Build one, then Save.</div>
                    )}
                    {libGlobal.length > 0 && (
                        <>
                            <div className="rgx-lib-sec">Global</div>
                            {libGlobal.map(renderLibItem)}
                        </>
                    )}
                    {libWorkspace.length > 0 && (
                        <>
                            <div className="rgx-lib-sec">This workspace</div>
                            {libWorkspace.map(renderLibItem)}
                        </>
                    )}
                </div>
            </aside>

            {/* ---- Main ---- */}
            <div className="rgx-main">
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
                    {!chatOpen && (
                        <button className="rgx-chat-reopen" onClick={() => setChatOpen(true)} title="Open AI chat">
                            <PanelRightOpen size={15} /> AI
                        </button>
                    )}
                    <button className="rgx-apply" onClick={apply} disabled={!lint.ok || !column} data-tour="regex-apply">
                        <Check size={14} /> Apply to node
                    </button>
                    <button
                        type="button"
                        className="editor-help-btn"
                        onClick={() => startEditorTour('regex')}
                        title="Show the Regex Studio tour"
                        aria-label="Show the Regex Studio tour"
                    >
                        <HelpCircle size={16} />
                    </button>
                </div>

                <div className="rgx-pat" data-tour="regex-pattern">
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
                    <div className="rgx-savebar">
                        <span
                            className={`rgx-valid ${lint.ok ? 'ok' : 'bad'}`}
                            title={lint.ok ? 'RE2 valid — DuckDB compatible' : `Invalid: ${lint.message}`}
                        >
                            {lint.ok ? <CircleCheck size={15} /> : <CircleX size={15} />}
                        </span>
                        {lint.ok ? (
                            <>
                                <input
                                    className="rgx-title"
                                    value={title}
                                    placeholder="Pattern title (e.g. US Federal Tax ID)"
                                    onChange={e => setTitle(e.target.value)}
                                />
                                <input
                                    className="rgx-descr-in"
                                    value={descr}
                                    maxLength={DESCRIPTION_MAX}
                                    placeholder="Short description — also sent to the AI as intent"
                                    onChange={e => setDescr(e.target.value)}
                                />
                                <div className="rgx-scope">
                                    <button
                                        className={scope === 'workspace' ? 'on' : ''}
                                        onClick={() => setScope('workspace')}
                                        title="Save to this workspace only"
                                    >
                                        Local
                                    </button>
                                    <button
                                        className={scope === 'global' ? 'on' : ''}
                                        onClick={() => setScope('global')}
                                        title="Save globally (available in every workspace)"
                                    >
                                        Global
                                    </button>
                                </div>
                                <button
                                    className="rgx-save-icon"
                                    onClick={doSave}
                                    disabled={!title.trim() || !pattern.trim()}
                                    title="Save to the Pattern Library"
                                >
                                    {savedFlash ? <Check size={15} /> : <Save size={15} />}
                                    {savedFlash ? 'Saved' : 'Save'}
                                </button>
                            </>
                        ) : (
                            <span className="rgx-valid-msg">Not valid for DuckDB (RE2): {lint.message}</span>
                        )}
                    </div>
                </div>

                {/* column data | tests */}
                <div className="rgx-split">
                    <div className="rgx-col" data-tour="regex-column">
                        <div className="rgx-panel-head">
                            <span className="ttl">Column data</span>
                            <span className="cnt">
                                {colLoading ? <Loader2 size={12} className="rgx-spin" /> : `${colTotal} rows`}
                            </span>
                        </div>
                        <div className="rgx-filter">
                            <Search size={13} />
                            <input value={filter} placeholder="Contains…" onChange={e => setFilter(e.target.value)} />
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

                    <div className="rgx-tests" data-tour="regex-expected">
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
                                        <button
                                            className="rgx-test-unpin"
                                            onClick={() => togglePin(v)}
                                            title="Remove from tests (unpin)"
                                        >
                                            <Trash2 size={13} />
                                        </button>
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
                                            {(() => {
                                                const verdict = checkExpected(expected[v] ?? '', p);
                                                return (
                                                    <div className="rgx-expected-wrap">
                                                        {verdict && (
                                                            <span className={`rgx-exp-verdict ${verdict}`}>
                                                                {verdict === 'pass' ? '✓ meets' : '✗ differs'}
                                                            </span>
                                                        )}
                                                        <input
                                                            className="rgx-expected"
                                                            placeholder={expectedPlaceholder}
                                                            value={expected[v] ?? ''}
                                                            onChange={e =>
                                                                setExpected(x => ({ ...x, [v]: e.target.value }))
                                                            }
                                                            title="Optional expected outcome. Checked live against the result and sent to the AI as context."
                                                        />
                                                    </div>
                                                );
                                            })()}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </div>

                {/* explanation region (splits for the one-shot AI explanation) */}
                <div className="rgx-explain-region">
                    <div className={`rgx-explain${oneShotOpen ? ' split' : ''}`}>
                        <div className="rgx-explain-head">
                            <span className="ttl">Explanation</span>
                            {desktopAi && (
                                <button
                                    className={`rgx-explain-ai${oneShotOpen ? ' on' : ''}`}
                                    onClick={runOneShot}
                                    disabled={!pattern.trim() || !lint.ok || oneShotStreaming}
                                >
                                    <Sparkles size={12} /> Explain with AI
                                </button>
                            )}
                        </div>
                        <div className="rgx-explain-body">
                            {explanation.length === 0 ? (
                                <div className="rgx-explain-empty">Enter a valid pattern to see its breakdown.</div>
                            ) : (
                                <ExplainCards nodes={explanation} />
                            )}
                        </div>
                    </div>
                    {oneShotOpen && (
                        <div className="rgx-oneshot">
                            <div className="rgx-explain-head">
                                <Sparkles size={13} className="ico" />
                                <span className="ttl">AI explanation</span>
                                <button className="rgx-oneshot-x" onClick={() => setOneShotOpen(false)} title="Close">
                                    <X size={13} />
                                </button>
                            </div>
                            <div className="rgx-oneshot-note">One-shot · not added to the chat conversation</div>
                            <div className="rgx-oneshot-body">
                                {oneShotError ? (
                                    <div className="rgx-col-err">{oneShotError}</div>
                                ) : (
                                    <div className="rgx-oneshot-card">
                                        {oneShot || (oneShotStreaming ? '…' : '')}
                                    </div>
                                )}
                                <div className="rgx-oneshot-actions">
                                    <button onClick={runOneShot} disabled={oneShotStreaming}>
                                        <RotateCw size={12} /> Regenerate
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* ---- Persistent AI chat (right, collapsible) ---- */}
            {chatOpen && (
                <aside className="rgx-chat" data-tour="regex-chat">
                    <div className="rgx-chat-head">
                        <Sparkles size={14} className="ico" />
                        <span className="ttl">AI chat</span>
                        <button className="rgx-chat-collapse" onClick={() => setChatOpen(false)} title="Collapse (keeps the conversation)">
                            <PanelRightClose size={15} />
                        </button>
                    </div>
                    {!desktopAi ? (
                        <div className="rgx-chat-desktop">The AI assistant is only available in the desktop app.</div>
                    ) : (
                        <>
                            <div className="rgx-chat-ctx">
                                Sees: <b>column</b> {column || '—'} + samples · <b>current pattern</b>
                                {pinned.length ? ` · ${pinned.length} pinned test${pinned.length > 1 ? 's' : ''}` : ''}. Constrained to <b>RE2</b>.
                            </div>
                            <div className="rgx-chat-body" ref={chatBodyRef}>
                                {chatTurns.length === 0 && (
                                    <div className="rgx-chat-empty">
                                        Ask for a regex, or describe what you want to match. Your pinned tests and expected outcomes are sent as context.
                                    </div>
                                )}
                                {chatTurns.map((t, i) => {
                                    const draft = t.role === 'assistant' && !t.auto ? extractPattern(t.content) : null;
                                    const total = labeled().length;
                                    const fails = draft && total ? verifyCandidate(draft) : [];
                                    return (
                                        <div key={i} className={`rgx-msg ${t.role}${t.auto ? ' auto' : ''}`}>
                                            <div className="bubble">{t.content || (chatStreaming ? '…' : '')}</div>
                                            {draft && (
                                                <div className="rgx-msg-foot">
                                                    {total > 0 && (
                                                        <span className={`chip ${fails.length === 0 ? 'ok' : 'no'}`}>
                                                            {fails.length === 0
                                                                ? `✓ passes all ${total}`
                                                                : `✗ ${fails.length}/${total} failing`}
                                                        </span>
                                                    )}
                                                    <button className="use" onClick={() => setPattern(draft)}>
                                                        <Check size={12} /> Use this pattern
                                                    </button>
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                                {chatError && <div className="rgx-col-err">{chatError}</div>}
                            </div>
                            {labeled().length > 0 && (
                                <div className="rgx-chat-quick">
                                    <button
                                        onClick={() =>
                                            void runAgent(
                                                `Write a RE2 regex for column "${column}" (${MODE_LABEL[mode]} mode) that satisfies all ${labeled().length} of my expected tests.`,
                                            )
                                        }
                                        disabled={chatStreaming}
                                        title="Draft a pattern, auto-verify it against your expected values, and retry until it passes"
                                    >
                                        <Sparkles size={12} /> Draft to pass my {labeled().length} expected test
                                        {labeled().length > 1 ? 's' : ''}
                                    </button>
                                </div>
                            )}
                            <div className="rgx-chat-foot">
                                <textarea
                                    value={chatInput}
                                    rows={2}
                                    placeholder="Ask, or describe the regex you want…"
                                    onChange={e => setChatInput(e.target.value)}
                                    onKeyDown={e => {
                                        if (e.key === 'Enter' && !e.shiftKey) {
                                            e.preventDefault();
                                            void sendChat();
                                        }
                                    }}
                                />
                                <button onClick={() => void sendChat()} disabled={chatStreaming || !chatInput.trim()}>
                                    {chatStreaming ? <Loader2 size={14} className="rgx-spin" /> : 'Send'}
                                </button>
                            </div>
                        </>
                    )}
                </aside>
            )}
        </div>
    );
}
