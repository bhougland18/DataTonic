import { useRef, useState } from 'react';
import {
    Sparkles,
    Send,
    Loader2,
    ArrowDownToLine,
    AlertTriangle,
    MessageSquarePlus,
    PanelRightClose,
} from 'lucide-react';
import { chatSend } from '../tauri-bridge';
import type { SqlStudioTable } from './types';
import { joinSql, quoteIdent, type ErdRelationship } from '../erd/model';
import { qualifyTables, stripTerminator } from './qualify';
import { forwardReferences, reorderJoins } from './join-order';
import {
    aliasMap,
    ambiguousColumns,
    columnIndex,
    joinKeyColumns,
    missingTables,
    problemSummary,
    repairPrompt,
    validateColumns,
} from './validate';

interface AiPaneProps {
    tables: SqlStudioTable[];
    relationships: ErdRelationship[];
    // The active editor's SQL, sent as context so "fix/tweak this" works.
    currentSql?: string;
    workspacePath?: string | null;
    // Kept mounted always; `visible` toggles display so collapsing never loses
    // the conversation. `onCollapse` hides it from within the pane.
    visible: boolean;
    onCollapse: () => void;
    // Put generated SQL into the editor.
    onInsert: (sql: string) => void;
    /**
     * Extra context to append to the system prompt, opaque to this pane.
     *
     * Blocks passes the result on screen and the charts it fits. A slot rather
     * than the chart knowledge itself, because this pane is shared with the SQL
     * Editor node, where a chart is not a thing that exists — the same seam as
     * `QueryPane`'s `resultInfo`.
     */
    extraContext?: string;
}

interface Msg {
    role: 'user' | 'assistant';
    content: string;
    /** Written by the checker, not typed by the person. Rendered as a note so
     *  the retry is visible without pretending somebody asked for it. */
    auto?: boolean;
}

/**
 * How many times a draft may be sent back for repair.
 *
 * Three total attempts. Past that the model is not converging — it is usually
 * cycling between two wrong guesses — and more turns cost time to reach the
 * same place. What it produced is shown anyway, with what is wrong with it,
 * because a nearly-right query is a better starting point than a blank editor.
 */
const MAX_ATTEMPTS = 3;

/** Does any table need an address written after FROM, rather than its name? */
export function hasAddresses(tables: SqlStudioTable[]): boolean {
    return tables.some(t => t.from && t.from !== t.name);
}

// Exported for test. The schema block is the whole of what the model knows
// about the workspace, and every rule in it is load-bearing — a silent change
// here shows up as a query that fails only once someone runs it.
export function schemaText(tables: SqlStudioTable[], relationships: ErdRelationship[]): string {
    const lines: string[] = [];
    // Inside a node a table's name IS what you write after FROM, so the compact
    // one-line-per-table form is complete. Blocks queries durable sinks, where
    // the address is `"duckle_src"."Item"` or a parquet path, and the address
    // has to travel with the columns.
    //
    // It travels IN the table's own entry, not in a section of its own. A
    // separate "addresses" list was the first attempt and it failed in the
    // obvious way once a real model saw it: the schema listing reads as the
    // authoritative one, so the model took its names from there, wrote
    // `FROM Item`, and never reconciled the second section at all. Two lists
    // that have to agree are reconciled by ignoring one.
    if (hasAddresses(tables)) {
        lines.push(
            'Schema. Each table below gives the exact expression to write after FROM or',
            'JOIN. Copy it verbatim, INCLUDING the alias — the alias is the name that',
            'every column list and join key below is stated in.',
            '',
        );
        for (const t of tables) {
            const cols = t.columns.map(c => c.name).join(', ');
            lines.push(
                `Table ${t.name}`,
                `  FROM/JOIN: ${t.from ?? t.name} AS ${quoteIdent(t.name)}`,
                `  Columns: ${cols || '(columns unknown)'}`,
            );
        }
    } else {
        lines.push('Schema — each column exists ONLY on the table it is listed under:');
        for (const t of tables) {
            const cols = t.columns.map(c => c.name).join(', ');
            lines.push(`  ${t.name}: ${cols || '(columns unknown)'}`);
        }
    }
    // The same facts, inverted. The block above answers "what is on this
    // table"; a request asks "where does VendorName live", and making the model
    // do that inversion itself is precisely the step it got wrong — it put
    // VendorName on VendorItem because the names look related.
    const index = columnIndex(tables);
    if (index) lines.push('', index);
    if (relationships.length) {
        lines.push('Join keys:');
        for (const r of relationships) {
            lines.push(`  ${joinSql(r)}`);
        }
        // Said explicitly, because the model would otherwise be free to move a
        // qualifier into a WHERE clause — which is equivalent for an inner join
        // and quietly wrong for an outer one, discarding the unmatched rows the
        // outer join exists to keep.
        if (relationships.some(r => r.qualifiers?.length)) {
            lines.push(
                'Some joins carry constant qualifiers. Keep them in the ON clause, not in WHERE.',
            );
        }
        // Which columns are CODES. Nothing else in the schema says so — every
        // column arrives from the API as text, so DuckDB types `Vendor` and
        // `VendorName` identically, and `VendorItem.Vendor = 'Medline'` is a
        // type-correct guess that quietly returns nothing.
        const keys = joinKeyColumns(relationships);
        if (keys.length) {
            lines.push(
                '',
                `These columns hold identifiers, not names: ${keys.join(', ')}.`,
                'Use them to JOIN. To filter by something a person would recognise, filter on a',
                'name or description column instead — never compare a join key to display text.',
            );
        }
    }
    return lines.join('\n');
}

/**
 * What to say when the question is about charts rather than about SQL.
 *
 * Added because the pane got "what do I need to add to use a line chart" and
 * answered with matplotlib and Python's datetime module — a real library, sound
 * advice, and about a tool that is not in this product. A model with no frame
 * reaches for the most common one in its training data, and for charting that
 * is Python.
 *
 * Naming the encoding channels and the four types matters as much as naming
 * Vega-Lite: it is what turns "you need a date column" into "x needs a temporal
 * field, and none of your columns are temporal".
 */
const CHART_RULES =
    '\n\nCHARTING. Every chart in this product is VEGA-LITE, and nothing else. ' +
    'Never mention matplotlib, seaborn, plotly, ggplot, Python, Excel, or any other ' +
    'charting tool — they are not available here and naming one is a wrong answer.\n' +
    '- Talk in Vega-Lite terms: marks (bar, line, area, point, arc, rect, boxplot) and ' +
    'encoding channels (x, y, color, theta, size), each taking a field with a type of ' +
    'nominal, ordinal, quantitative or temporal.\n' +
    '- A chart is possible when every required channel has a column of a type it accepts. ' +
    'When one is missing, say WHICH channel and what type it needs.\n' +
    '- The user fixes a missing chart by changing the SQL — adding a column, an aggregate, ' +
    'or a date — so answer with the column to add, not with a different library.\n' +
    '- When the question is about charts, answer in prose. The SQL-only rule above applies ' +
    'to requests for a query.';

function systemPrompt(
    tables: SqlStudioTable[],
    relationships: ErdRelationship[],
    currentSql?: string,
    /** Opaque context from the caller — in Blocks, the result and its charts. */
    extraContext?: string,
): string {
    const current = currentSql?.trim()
        ? `\n\nThe user's current query in the editor is:\n\`\`\`sql\n${currentSql.trim()}\n\`\`\``
        : '';
    // Stated as a rule as well as in the schema block, and it names the exact
    // failure: asked for a join, the model reached for `FROM Item AS T1` — its
    // own aliases over the ones it was given. A rule that only said "use the
    // FROM expression" left renaming open, and renaming is what breaks it,
    // because the join keys are stated in the original names.
    const addressRule = hasAddresses(tables)
        ? '- NEVER write a bare table name after FROM or JOIN. Write the exact FROM/JOIN ' +
          'expression the schema gives for that table, including its alias, and do not ' +
          'substitute aliases of your own (T1, T2, …) — the join keys below are stated ' +
          'in the given aliases and stop matching if you rename them.\n'
        : '';
    // A worked example, because a small model imitates a shape far more
    // reliably than it follows a paragraph — and every rule above is one it has
    // already broken in practice. Built from the real tables so it cannot
    // demonstrate a schema that does not exist; skipped when there are too few
    // to show a join, where an example would be more noise than pattern.
    const shape = tables.filter(t => t.from && t.from !== t.name).slice(0, 2);
    const example =
        shape.length === 2
            ? '\n\nShape to follow (illustrative — use the real columns for the question asked):\n' +
              '```sql\n' +
              `SELECT ${shape[0].name}.*\n` +
              `FROM ${shape[0].from} AS ${quoteIdent(shape[0].name)}\n` +
              `LEFT JOIN ${shape[1].from} AS ${quoteIdent(shape[1].name)}\n` +
              `  ON ${quoteIdent(shape[0].name)}.<key> = ${quoteIdent(shape[1].name)}.<key>\n` +
              '```'
            : '';
    return (
        'You are a SQL assistant embedded in a read-only DuckDB SQL editor. ' +
        "Write ONE DuckDB SQL SELECT that answers the user's request using the schema below.\n" +
        'RULES:\n' +
        addressRule +
        '- A column may be referenced on a table ONLY if that table lists it below. ' +
        'If a needed column lives on a different table, JOIN to that table using the join keys. ' +
        '(For example, a column is NOT available on a table just because the names look related.)\n' +
        '- Use only the exact table and column names from the schema; never invent or guess names.\n' +
        // The half that gets forgotten once the column is placed correctly:
        // knowing VendorName is on Vendor is not the same as putting Vendor in
        // the query.
        '- Every table you reference must also appear in the FROM/JOIN chain. Reaching a ' +
        "column on another table means ADDING that table's JOIN, not just naming it.\n" +
        '- Read-only: never write INSERT/UPDATE/DELETE/DDL.\n' +
        // The engine runs the query inside `( … )`, so a terminator is a syntax
        // error rather than a harmless habit. Repaired on the way out too — this
        // just saves the round trip.
        '- ONE statement, and do NOT end it with a semicolon.\n' +
        // Scoped to "asked for a query", because the pane is also asked about
        // charts now and a flat no-prose rule makes that unanswerable.
        '- When asked FOR A QUERY, return ONLY the SQL inside a ```sql fenced block, no prose.\n\n' +
        schemaText(tables, relationships) +
        example +
        current +
        (extraContext?.trim() ? `\n\n${extraContext.trim()}` : '') +
        CHART_RULES
    );
}

// Pull the SQL out of an assistant reply: a ```sql (or plain ```) fence, else the
// whole text when it already looks like a query.
//
// What comes out is then REPAIRED rather than trusted. The prompt asks for
// qualified names and no terminator, and a small local model mostly complies —
// but "mostly" here means an error with no rows, so the two failures we can fix
// without a model are fixed on the way out. See `qualify.ts`.
function extractSql(text: string, tables: SqlStudioTable[]): string | null {
    const fence = text.match(/```sql\s*([\s\S]*?)```/i) ?? text.match(/```\s*([\s\S]*?)```/);
    const raw = fence ? fence[1].trim() : text.trim();
    if (!fence && !/^(select|with)\b/i.test(raw)) return null;
    // Terminator, addresses, then join order. Order matters: `reorderJoins`
    // reads the FROM chain, so it wants the addresses already in place.
    return reorderJoins(qualifyTables(stripTerminator(raw), tables)).sql;
}

// SQL Studio AI pane (Phase 4d). Text-to-SQL over Duckle's own local AI (the
// `chat_send` bridge — local Qwen, or a configured OpenAI-compatible endpoint),
// with the inherited ERD (tables + columns + join keys) as context. Desktop-only
// (the local model), so a friendly message shows in the web edition.
export default function AiPane({
    tables,
    relationships,
    currentSql,
    workspacePath,
    visible,
    onCollapse,
    onInsert,
    extraContext,
}: AiPaneProps) {
    const [input, setInput] = useState('');
    const [messages, setMessages] = useState<Msg[]>([]);
    const [streaming, setStreaming] = useState(false);
    const [error, setError] = useState<string | null>(null);
    /** Set when the draft still references columns that do not exist. */
    const [blocked, setBlocked] = useState<string | null>(null);
    /**
     * A column that exists on more than one table, waiting on a person.
     *
     * The model cannot settle this and neither can we. Asked to filter on
     * `VendorName` where both `Vendor` and `item_norm.parquet` have one, any
     * answer we pick is a guess about which number the report should show —
     * and a wrong one is invisible, because the query runs.
     */
    const [choice, setChoice] = useState<{ column: string; options: string[] } | null>(null);
    const choiceResolver = useRef<((table: string | null) => void) | null>(null);
    /** Choices already made, so the same column is asked about once. */
    const resolvedRef = useRef(new Map<string, string>());

    const askWhichTable = (column: string, options: string[]) =>
        new Promise<string | null>(resolve => {
            choiceResolver.current = resolve;
            setChoice({ column, options });
        });

    /**
     * Clear everything the next answer would be shaped by.
     *
     * Including the table choices, which is the part that is easy to forget:
     * "asked once" is right within a line of enquiry and wrong across two, and
     * a choice made for a question you are no longer asking is the kind of
     * stale state nobody thinks to look for.
     */
    const newChat = () => {
        setMessages([]);
        setError(null);
        setBlocked(null);
        setInput('');
        answerChoice(null);
        resolvedRef.current = new Map();
    };

    const answerChoice = (table: string | null) => {
        setChoice(null);
        choiceResolver.current?.(table);
        choiceResolver.current = null;
    };
    const bodyRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);

    // Grow the input with the request, up to a cap, then scroll. The FLOOR
    // matters as much as the cap: autosizing to content would collapse the box
    // back to one line the moment it is empty, undoing the height that makes it
    // usable for a real question.
    const autosize = (el: HTMLTextAreaElement) => {
        el.style.height = 'auto';
        el.style.height = `${Math.min(Math.max(el.scrollHeight, 84), 220)}px`;
    };

    /** One model turn, streamed into a fresh assistant bubble. */
    const runTurn = async (history: { role: 'user' | 'assistant'; content: string }[]) => {
        setMessages(m => [...m, { role: 'assistant', content: '' }]);
        let acc = '';
        await chatSend(
            history,
            e => {
                if (e.kind === 'token') {
                    acc += e.text;
                    setMessages(m => {
                        const c = [...m];
                        c[c.length - 1] = { role: 'assistant', content: acc };
                        return c;
                    });
                    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
                } else if (e.kind === 'error') {
                    setError(e.message);
                }
            },
            workspacePath,
            systemPrompt(tables, relationships, currentSql, extraContext),
        );
        return acc;
    };

    const send = async () => {
        const q = input.trim();
        if (!q || streaming) return;
        setInput('');
        if (inputRef.current) inputRef.current.style.height = 'auto';
        setError(null);
        setBlocked(null);
        // Send the whole conversation (prior turns + this one) so the model can
        // act on its own earlier drafts and the user's corrections — not just the
        // latest message.
        const priorTurns = messages
            .filter(m => m.content.trim().length > 0)
            .map(m => ({ role: m.role, content: m.content }));
        let history = [...priorTurns, { role: 'user' as const, content: q }];
        setMessages(m => [...m, { role: 'user', content: q }]);
        setStreaming(true);

        // Draft, check, correct. The check is against the schema we already
        // hold, so a wrong column costs one more turn rather than a failed run
        // the person has to read a binder error out of.
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
            const text = await runTurn(history);
            const draft = extractSql(text, tables);
            if (!draft) break;
            const raw = validateColumns(draft, tables);
            const missing = missingTables(draft, tables);
            // Anything still referenced before it is introduced could not be
            // reordered, which means it is not in the query at all — a real
            // problem rather than a formatting one.
            const stranded = forwardReferences(draft);
            if (raw.length === 0 && missing.length === 0 && stranded.length === 0) break;

            // Settle any ambiguity BEFORE spending a retry. A column on two
            // tables is not a mistake the model can reason its way out of —
            // both answers are defensible — so asking is the only honest move,
            // and asking once beats three attempts that alternate between them.
            const undecided = ambiguousColumns(raw).find(
                p => !resolvedRef.current.has(p.column.toLowerCase()),
            );
            if (undecided) {
                const picked = await askWhichTable(undecided.column, undecided.foundOn);
                if (picked) {
                    resolvedRef.current.set(undecided.column.toLowerCase(), picked);
                    setMessages(m => [
                        ...m,
                        { role: 'user', content: `Use ${picked}.${undecided.column}.`, auto: true },
                    ]);
                    // Not an attempt: nothing was asked of the model.
                    attempt -= 1;
                    continue;
                }
            }

            // Narrow each ambiguous column to the table that was chosen, so the
            // repair names one table rather than offering a choice again.
            const problems = raw.map(p => {
                const pick = resolvedRef.current.get(p.column.toLowerCase());
                return pick && p.foundOn.includes(pick) ? { ...p, foundOn: [pick] } : p;
            });

            if (attempt === MAX_ATTEMPTS) {
                setBlocked(problemSummary(problems, [...missing, ...stranded]));
                break;
            }
            const present = [...aliasMap(draft, tables).values()].map(t => t.name);
            const fix = repairPrompt(problems, [...missing, ...stranded], tables, relationships, present);
            history = [...history, { role: 'assistant', content: text }, { role: 'user', content: fix }];
            setMessages(m => [
                ...m,
                { role: 'user', content: problemSummary(problems, [...missing, ...stranded]), auto: true },
            ]);
        }
        setStreaming(false);
    };

    return (
        <aside className={`sqlstudio-ai${visible ? '' : ' sqlstudio-ai--hidden'}`}>
            <div className="sqlstudio-ai-head">
                <Sparkles size={14} />
                <b>Ask AI</b>
                <span className="sqlstudio-ai-prov">text-to-SQL</span>
                {/* Every turn is sent as history, so a conversation that has
                    gone wrong keeps its wrong turns in front of the model and
                    they go on shaping the next answer. Starting over is the
                    only reliable way out of that, and it has to be one click
                    away from where the going-wrong is visible. */}
                <button
                    className="sqlstudio-ai-collapse"
                    onClick={newChat}
                    disabled={streaming || messages.length === 0}
                    title="Start a new chat — clears the conversation and any table choices made"
                    aria-label="New chat"
                >
                    <MessageSquarePlus size={15} />
                </button>
                <button
                    className="sqlstudio-ai-collapse"
                    onClick={onCollapse}
                    title="Collapse (keeps the conversation)"
                    aria-label="Collapse AI panel"
                >
                    <PanelRightClose size={15} />
                </button>
            </div>
            <div className="sqlstudio-ai-body" ref={bodyRef}>
                {messages.length === 0 ? (
                    <div className="sqlstudio-ai-empty">
                        Describe the query you want. The {tables.length} table
                        {tables.length === 1 ? '' : 's'} in scope
                        {relationships.length ? ' and their relationships' : ''} are sent as
                        context.
                    </div>
                ) : (
                    messages.map((m, i) => {
                        const sql = m.role === 'assistant' ? extractSql(m.content, tables) : null;
                        // A checker note, not a turn somebody took. Shown rather
                        // than hidden: a silent retry looks like the model
                        // answering slowly, and the reason it was sent back is
                        // the most useful thing on screen.
                        if (m.auto) {
                            return (
                                <div key={i} className="sqlstudio-ai-note">
                                    Checked against the schema — {m.content} Asking again.
                                </div>
                            );
                        }
                        return (
                            <div key={i} className={`sqlstudio-ai-msg ${m.role}`}>
                                <span className="from">{m.role === 'user' ? 'You' : 'AI'}</span>
                                <div className="bubble">
                                    {m.content || (streaming ? '…' : '')}
                                </div>
                                {sql && (
                                    <button
                                        className="sqlstudio-ai-insert"
                                        onClick={() => onInsert(sql)}
                                    >
                                        <ArrowDownToLine size={12} /> Insert into editor
                                    </button>
                                )}
                            </div>
                        );
                    })
                )}
                {/* The one question we cannot answer for them. Shown in the
                    conversation rather than as a modal: it is a turn in the
                    exchange, and the draft above it is the context for choosing. */}
                {choice && (
                    <div className="sqlstudio-ai-choice">
                        <b>
                            {choice.column} is on {choice.options.length} tables. Which one do you
                            mean?
                        </b>
                        <div className="sqlstudio-ai-choice-opts">
                            {choice.options.map(o => (
                                <button
                                    key={o}
                                    type="button"
                                    className="sqlstudio-btn"
                                    onClick={() => answerChoice(o)}
                                >
                                    {o}
                                </button>
                            ))}
                            <button
                                type="button"
                                className="sqlstudio-btn"
                                onClick={() => answerChoice(null)}
                                title="Carry on without deciding — the AI will pick one"
                            >
                                Let the AI choose
                            </button>
                        </div>
                    </div>
                )}

                {/* Said plainly rather than left for the run to discover. The
                    draft is still offered — a nearly-right query beats a blank
                    editor — but it is not presented as working. */}
                {blocked && (
                    <div className="sqlstudio-ai-err">
                        <AlertTriangle size={13} /> This will not run as written: {blocked} Fix it
                        in the editor, or ask again more specifically.
                    </div>
                )}
                {error && (
                    <div className="sqlstudio-ai-err">
                        <AlertTriangle size={13} /> {error}
                    </div>
                )}
            </div>
            <div className="sqlstudio-ai-foot">
                <textarea
                    ref={inputRef}
                    className="sqlstudio-ai-input"
                    value={input}
                    rows={1}
                    placeholder="e.g. total amount by region for shipped orders"
                    onChange={e => {
                        setInput(e.target.value);
                        autosize(e.currentTarget);
                    }}
                    onKeyDown={e => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            void send();
                        }
                    }}
                />
                <button
                    className="sqlstudio-ai-send"
                    onClick={() => void send()}
                    disabled={streaming || !input.trim()}
                    aria-label="Send"
                >
                    {streaming ? (
                        <Loader2 size={14} className="sqlstudio-spin" />
                    ) : (
                        <Send size={14} />
                    )}
                </button>
            </div>
        </aside>
    );
}
