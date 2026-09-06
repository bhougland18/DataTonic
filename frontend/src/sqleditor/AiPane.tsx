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
import type { ErdRelationship } from '../erd/model';

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
    const lines: string[] = ['Tables:'];
    for (const t of tables) {
        const cols = t.columns.map(c => (c.type ? `${c.name}:${c.type}` : c.name)).join(', ');
        lines.push(`- ${t.name}(${cols})`);
    }
    if (relationships.length) {
        lines.push('Relationships (join keys):');
        for (const r of relationships) {
            lines.push(`- ${r.fromTable}.${r.fromColumn} = ${r.toTable}.${r.toColumn}`);
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
        ? `\n\nThe user's current query in the editor is:\n\`\`\`sql\n${currentSql.trim()}\n\`\`\`\n` +
          'When they ask to fix, change, or extend it, modify THIS query and return the full updated SQL.'
        : '';
    return (
        'You are a SQL assistant embedded in a read-only DuckDB SQL editor. ' +
        "Write ONE DuckDB SQL SELECT that answers the user's request. " +
        'Use ONLY the tables, columns, and join keys listed below — do not invent names. ' +
        'Never write INSERT/UPDATE/DELETE/DDL. Return ONLY the SQL inside a ```sql fenced block.\n\n' +
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

    const send = async () => {
        const q = input.trim();
        if (!q || streaming) return;
        setInput('');
        setError(null);
        setMessages(m => [...m, { role: 'user', content: q }, { role: 'assistant', content: '' }]);
        setStreaming(true);
        let acc = '';
        await chatSend(
            [{ role: 'user', content: q }],
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
                    className="sqlstudio-ai-input"
                    value={input}
                    placeholder="e.g. total amount by region for shipped orders"
                    onChange={e => setInput(e.target.value)}
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
