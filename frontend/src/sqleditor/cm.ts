// Shared CodeMirror config for the SQL Studio panes (theme, highlight, and the
// extension set). Kept here so the main editor and the AI-draft editor build
// identical editors, each with a Mod-Enter bound to its own run.
import { sql, SQLDialect, type SQLNamespace } from '@codemirror/lang-sql';
import { EditorView, keymap } from '@codemirror/view';
import { Prec, type Extension } from '@codemirror/state';
import { acceptCompletion } from '@codemirror/autocomplete';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import type { MutableRefObject } from 'react';
import type { SqlStudioTable } from './types';

// Theme with the app's own tokens so it tracks Duckle's light/dark mode and the
// editor background matches the results grid.
export const duckleEditorTheme = EditorView.theme({
    '&': { backgroundColor: 'var(--bg-0)', color: 'var(--text-1)' },
    '.cm-content': {
        caretColor: 'var(--accent)',
        fontFamily: 'var(--mono, ui-monospace, "Cascadia Code", Menlo, monospace)',
    },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
        backgroundColor: 'var(--accent-soft)',
    },
    '.cm-gutters': { backgroundColor: 'var(--bg-0)', color: 'var(--text-4)', border: 'none' },
    '.cm-activeLine': { backgroundColor: 'var(--bg-1)' },
    '.cm-activeLineGutter': { backgroundColor: 'var(--bg-1)', color: 'var(--text-2)' },
    '.cm-tooltip': {
        backgroundColor: 'var(--bg-3)',
        border: '1px solid var(--border)',
        color: 'var(--text-1)',
    },
    '.cm-tooltip-autocomplete ul li[aria-selected]': {
        backgroundColor: 'var(--accent-soft)',
        color: 'var(--accent)',
    },
});

export const duckleHighlight = HighlightStyle.define([
    { tag: [t.keyword, t.operatorKeyword, t.modifier], color: 'var(--accent)', fontWeight: '600' },
    { tag: [t.string, t.special(t.string)], color: 'var(--ok, #3a9c5a)' },
    { tag: [t.number, t.bool, t.null], color: 'var(--accent-warn, #d9880a)' },
    { tag: [t.lineComment, t.blockComment], color: 'var(--text-3)', fontStyle: 'italic' },
    {
        tag: [t.function(t.variableName), t.function(t.propertyName), t.typeName, t.className],
        color: 'var(--accent-cyan, #1f8fce)',
    },
    { tag: [t.propertyName, t.variableName], color: 'var(--text-1)' },
]);

// DuckDB folds unquoted identifiers case-insensitively, so mixed-case names like
// `Item` don't need quoting — tell the completion engine that so it inserts
// `Item`, not `"Item"`.
const DuckDBDialect = SQLDialect.define({ caseInsensitiveIdentifiers: true });

// Build the extension set for one editor. `runRef` lets Mod-Enter run the pane
// that owns this editor.
export function sqlExtensions(
    tables: SqlStudioTable[],
    runRef: MutableRefObject<() => void>,
): Extension[] {
    const schema: SQLNamespace = {};
    for (const tbl of tables) {
        (schema as Record<string, string[]>)[tbl.name] = tbl.columns.map(c => c.name);
    }
    const defaultTable = tables.find(tb => tb.kind === 'input')?.name;
    return [
        sql({ dialect: DuckDBDialect, schema, defaultTable, upperCaseKeywords: false }),
        duckleEditorTheme,
        syntaxHighlighting(duckleHighlight),
        Prec.highest(
            keymap.of([
                { key: 'Tab', run: acceptCompletion },
                {
                    key: 'Mod-Enter',
                    run: () => {
                        runRef.current();
                        return true;
                    },
                },
            ]),
        ),
    ];
}
