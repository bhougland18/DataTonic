import { useRef, useState } from 'react';
import {
    Sparkles,
    Send,
    Loader2,
    ArrowDownToLine,
    AlertTriangle,
    PanelRightClose,
} from 'lucide-react';
import { chatSend } from '../tauri-bridge';
import type { SqlStudioTable } from './types';
import { joinSql, type ErdRelationship } from '../erd/model';

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
}

interface Msg {
    role: 'user' | 'assistant';
    content: string;
}

function schemaText(tables: SqlStudioTable[], relationships: ErdRelationship[]): string {
    const lines: string[] = [
        'Schema — each column exists ONLY on the table it is listed under:',
    ];
    for (const t of tables) {
        const cols = t.columns.map(c => c.name).join(', ');
        lines.push(`  ${t.name}: ${cols || '(columns unknown)'}`);
    }
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
    }
    return lines.join('\n');
}

function systemPrompt(
    tables: SqlStudioTable[],
    relationships: ErdRelationship[],
    currentSql?: string,
): string {
    const current = currentSql?.trim()
        ? `\n\nThe user's current query in the editor is:\n\`\`\`sql\n${currentSql.trim()}\n\`\`\``
        : '';
    return (
        'You are a SQL assistant embedded in a read-only DuckDB SQL editor. ' +
        "Write ONE DuckDB SQL SELECT that answers the user's request using the schema below.\n" +
        'RULES:\n' +
        '- A column may be referenced on a table ONLY if that table lists it below. ' +
        'If a needed column lives on a different table, JOIN to that table using the join keys. ' +
        '(For example, a column is NOT available on a table just because the names look related.)\n' +
        '- Use only the exact table and column names from the schema; never invent or guess names.\n' +
        '- Read-only: never write INSERT/UPDATE/DELETE/DDL.\n' +
        '- Return ONLY the SQL inside a ```sql fenced block, no prose.\n\n' +
        schemaText(tables, relationships) +
        current
    );
}

// Pull the SQL out of an assistant reply: a ```sql (or plain ```) fence, else the
// whole text when it already looks like a query.
function extractSql(text: string): string | null {
    const fence = text.match(/```sql\s*([\s\S]*?)```/i) ?? text.match(/```\s*([\s\S]*?)```/);
    if (fence) return fence[1].trim();
    const t = text.trim();
    return /^(select|with)\b/i.test(t) ? t : null;
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
}: AiPaneProps) {
    const [input, setInput] = useState('');
    const [messages, setMessages] = useState<Msg[]>([]);
    const [streaming, setStreaming] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const bodyRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);

    // Grow the input with the request, up to a cap, then scroll.
    const autosize = (el: HTMLTextAreaElement) => {
        el.style.height = 'auto';
        el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
    };

    const send = async () => {
        const q = input.trim();
        if (!q || streaming) return;
        setInput('');
        if (inputRef.current) inputRef.current.style.height = 'auto';
        setError(null);
        // Send the whole conversation (prior turns + this one) so the model can
        // act on its own earlier drafts and the user's corrections — not just the
        // latest message.
        const priorTurns = messages
            .filter(m => m.content.trim().length > 0)
            .map(m => ({ role: m.role, content: m.content }));
        const history = [...priorTurns, { role: 'user' as const, content: q }];
        setMessages(m => [...m, { role: 'user', content: q }, { role: 'assistant', content: '' }]);
        setStreaming(true);
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
            systemPrompt(tables, relationships, currentSql),
        );
        setStreaming(false);
    };

    return (
        <aside className={`sqlstudio-ai${visible ? '' : ' sqlstudio-ai--hidden'}`}>
            <div className="sqlstudio-ai-head">
                <Sparkles size={14} />
                <b>Ask AI</b>
                <span className="sqlstudio-ai-prov">text-to-SQL</span>
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
                        {tables.length === 1 ? '' : 's'} in this working DB
                        {relationships.length ? ' and their relationships' : ''} are sent as
                        context.
                    </div>
                ) : (
                    messages.map((m, i) => {
                        const sql = m.role === 'assistant' ? extractSql(m.content) : null;
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
