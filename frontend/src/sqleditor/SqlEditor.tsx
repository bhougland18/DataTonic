import { useCallback, useEffect, useRef, useState } from 'react';
import { normalizeBuilder } from '../blocks/builder-ops';
import {
    Database,
    Lock,
    ArrowUpToLine,
    Sparkles,
    Check,
    X,
    AlignLeft,
    HelpCircle,
} from 'lucide-react';
import { format as formatSqlText } from 'sql-formatter';
import './sqleditor.css';
// The builder panel's styles. Imported here rather than relied on through
// Blocks being mounted elsewhere — this surface uses `.blk-*` classes now, so
// it owns that dependency. Bundlers dedupe a CSS import seen twice.
import '../blocks/blocks.css';
import type { SqlEditorRequest, SqlEditorResult, SqlRunResult, SqlStudioTable } from './types';
import type { ErdRelationship } from '../erd/model';
import QueryPane from './QueryPane';
import AiPane from './AiPane';
import { maybeStartEditorTour, startEditorTour } from '../GuidedTour';
// The builder, mounted exactly as the Blocks SQL step mounts it. The only
// differences are the two the seam was cut for: where the tables come from
// (this node's upstream, not the workspace catalog) and where the state is kept
// (a node property, not a saved query).
import { useQueryBuilder } from '../blocks/useQueryBuilder';
import BuilderPanel from '../blocks/BuilderPanel';
import FiltersPanel from '../blocks/FiltersPanel';
import SelectedColumns from '../blocks/SelectedColumns';
import SortList from '../blocks/SortList';
import TransformsPanel from '../blocks/TransformsPanel';
import { addressOf } from '../blocks/join-insert';
import { distinctValues, type ValueOption } from '../blocks/distinct-values';
import { countRules, emptyBuilder, type BuilderState } from '../blocks/builder-types';
import { tableReason } from '../blocks/builder-ops';

interface SqlEditorProps {
    workspacePath?: string | null;
    openRequest: SqlEditorRequest | null;
    onApplyToNode?: (nodeId: string, result: SqlEditorResult) => void;
    onRun?: (nodeId: string, sqlText: string) => Promise<SqlRunResult>;
}

// SQL Studio surface. Authors a code.sqlstudio node's SQL: working-DB catalog
// (left), a query pane (editor + results), and a collapsible AI pane. When the
// AI drafts, a second pane opens side-by-side — run/edit it, then "Use this"
// copies it into the main editor and collapses the split. Only the main query
// is ever applied to the node.
export default function SqlEditor({
    workspacePath,
    openRequest,
    onApplyToNode,
    onRun,
}: SqlEditorProps) {
    const [nodeId, setNodeId] = useState<string | null>(null);
    const [nodeName, setNodeName] = useState<string | undefined>(undefined);
    const [tables, setTables] = useState<SqlStudioTable[]>([]);
    const [relationships, setRelationships] = useState<ErdRelationship[]>([]);
    const [showAi, setShowAi] = useState(false);
    const [mainSql, setMainSql] = useState('');
    /**
     * Whether the builder owns the query.
     *
     * Seeded from whether the node HAS builder state: a node authored by hand
     * opens in SQL, one authored with the builder opens in the builder. There is
     * no third answer, because `sql` alone cannot tell you which it was.
     */
    const [builderMode, setBuilderMode] = useState(false);
    // The AI's editable draft; non-null opens the split.
    const [aiDraft, setAiDraft] = useState<string | null>(null);
    const lastNonce = useRef<number>(-1);

    // The builder. `tables` is this node's upstream rather than a workspace
    // catalog, which is the whole of what differs from the Blocks step.
    const qb = useQueryBuilder({ tables, relationships });

    useEffect(() => {
        if (!openRequest) return;
        if (openRequest.nonce === lastNonce.current) return;
        lastNonce.current = openRequest.nonce;
        setNodeId(openRequest.nodeId);
        setNodeName(openRequest.nodeName);
        setTables(openRequest.tables ?? []);
        setRelationships(openRequest.relationships ?? []);
        setMainSql(openRequest.sql ?? '');
        setAiDraft(null);
        // Restore the builder if the node was authored with one. Seeded here
        // rather than in an effect on `builder`, so opening a DIFFERENT node
        // re-seeds — this editor stays mounted while you switch between them.
        const saved = openRequest.builder as BuilderState | undefined;
        qb.setState(saved ? normalizeBuilder(saved) : emptyBuilder());
        setBuilderMode(!!saved);
        // First time this editor is opened, walk the SQL Studio tour once.
        maybeStartEditorTour('sql');
    }, [openRequest]);

    const runQuery = useCallback(
        (sqlText: string): Promise<SqlRunResult> => {
            if (nodeId == null || !onRun) {
                return Promise.resolve({
                    columns: [],
                    rows: [],
                    error: 'Run is unavailable in this edition.',
                });
            }
            return onRun(nodeId, sqlText);
        },
        [nodeId, onRun],
    );

    const editorSql = builderMode ? qb.sql : mainSql;

    const apply = useCallback(() => {
        if (nodeId == null || !onApplyToNode) return;
        onApplyToNode(nodeId, {
            sql: editorSql,
            // `null` CLEARS it when the query was taken over by hand. Leaving a
            // stale builder behind would mean switching it back on silently
            // replaced the node's SQL with an older query.
            builder: builderMode ? qb.state : null,
        });
    }, [nodeId, onApplyToNode, editorSql, builderMode, qb.state]);

    /**
     * Hand the query over, or take it back. Same bargain as the Blocks step.
     *
     * Switching OFF is lossless — the generated SQL becomes the editable text.
     * Switching ON discards whatever was typed since, which is worth asking
     * about because the builder cannot read arbitrary SQL back in.
     */
    const toggleBuilder = useCallback(() => {
        if (builderMode) {
            setMainSql(qb.sql);
            setBuilderMode(false);
            return;
        }
        const hasEdits = mainSql.trim() !== qb.sql.trim();
        if (hasEdits && !window.confirm('Go back to the builder? Your SQL edits will be lost.')) {
            return;
        }
        setBuilderMode(true);
    }, [builderMode, qb.sql, mainSql]);

    /**
     * The values in one column, for a filter's dropdown.
     *
     * Runs through the NODE's own path, not the workspace one: these tables live
     * in the run's working database, built from this node's upstream, and
     * nothing outside a run can see them. Scoped by node id so two nodes with a
     * same-named table do not share one answer.
     */
    const fetchValues = useCallback(
        (table: string, column: string): Promise<ValueOption[]> => {
            if (nodeId == null || !onRun) return Promise.resolve([]);
            return distinctValues({
                from: addressOf(table, tables),
                column,
                scope: nodeId,
                run: sql => onRun(nodeId, sql),
            });
        },
        [nodeId, onRun, tables],
    );

    const acceptAiDraft = useCallback(() => {
        if (aiDraft != null) setMainSql(aiDraft);
        setAiDraft(null);
    }, [aiDraft]);

    // Pretty-print the main query (DuckDB ≈ PostgreSQL). Leaves it unchanged if
    // it can't be parsed, so a half-written query is never mangled.
    const formatMain = useCallback(() => {
        setMainSql(s => {
            if (!s.trim()) return s;
            try {
                return formatSqlText(s, { language: 'postgresql' });
            } catch {
                return s;
            }
        });
    }, []);

    if (nodeId == null) {
        return (
            <div className="sqlstudio">
                <div className="sqlstudio-empty">
                    Open a SQL Studio node from the canvas to author its query here.
                </div>
            </div>
        );
    }

    const split = aiDraft != null;

    return (
        <div className="sqlstudio">
            {/* The same panel the Blocks SQL step mounts. One group, because a
                node queries one working database and has no database to choose
                between — the thing Blocks puts a switcher there for. */}
            <div data-tour="sqlstudio-catalog" className="sqlstudio-builder-side">
                <BuilderPanel
                    groups={[
                        {
                            id: 'workingdb',
                            alwaysShow: true,
                            tables,
                            header: (
                                <div className="blk-catalog-db" title="This node's upstream tables">
                                    <Database size={13} strokeWidth={1.75} />
                                    <span className="blk-catalog-db-name">Working DB</span>
                                </div>
                            ),
                        },
                    ]}
                    emptyHint="No upstream tables detected. Wire a source (or a Working DB) into this node."
                    relationships={relationships}
                    sql={editorSql}
                    onChangeSql={setMainSql}
                    selectionFor={builderMode ? qb.selectionFor : undefined}
                    activeJoins={builderMode ? qb.activeJoins : undefined}
                    onSetJoinMode={builderMode ? qb.setJoinMode : undefined}
                    onAddJoinTable={builderMode ? qb.addJoinTable : undefined}
                    reasonFor={builderMode ? t => tableReason(qb.state, t) : undefined}
                    excludedJoins={qb.excludedJoinIds}
                    onExcludeJoin={builderMode ? qb.excludeJoin : undefined}
                    onRestoreJoin={builderMode ? qb.restoreJoin : undefined}
                    canExcludeJoin={builderMode ? qb.canExcludeJoin : undefined}
                    transformCount={(qb.state.transforms ?? []).length || undefined}
                    transforms={
                        builderMode ? (
                            <TransformsPanel
                                transforms={qb.state.transforms ?? []}
                                tables={tables}
                                onUpsert={qb.upsertTransform}
                                onRemove={qb.removeTransform}
                                onToggle={qb.setTransformEnabled}
                            />
                        ) : undefined
                    }
                    selectedCount={qb.state.columns.length}
                    filterCount={countRules(qb.state.filters)}
                    havingCount={countRules(qb.state.having)}
                    sortCount={qb.state.sort.length}
                    sort={
                        builderMode ? (
                            <SortList
                                sort={qb.state.sort}
                                columns={qb.state.columns}
                                onAdd={qb.addSort}
                                onRemove={qb.removeSortAt}
                                onChange={qb.setSortAt}
                                onMove={qb.moveSort}
                            />
                        ) : undefined
                    }
                    selected={
                        builderMode && qb.state.columns.length > 0 ? (
                            <SelectedColumns
                                columns={qb.state.columns}
                                onMove={qb.moveColumn}
                                onRemove={qb.removeColumn}
                            />
                        ) : undefined
                    }
                    filters={
                        builderMode ? (
                            <FiltersPanel
                                root={qb.state.filters}
                                options={qb.filterOptions}
                                onUpdate={qb.updateFilter}
                                onAdd={qb.addFilter}
                                onRemove={qb.removeFilter}
                                fetchValues={fetchValues}
                            />
                        ) : undefined
                    }
                    having={
                        builderMode && qb.havingOptions.length > 0 ? (
                            <FiltersPanel
                                root={qb.state.having}
                                options={qb.havingOptions}
                                onUpdate={qb.updateHaving}
                                onAdd={qb.addHaving}
                                onRemove={qb.removeHaving}
                            />
                        ) : undefined
                    }
                />
            </div>

            {/* Main */}
            <div className="sqlstudio-main">
                <div className="sqlstudio-top">
                    {/* No reopen button here: `BuilderPanel` collapses to a rail
                        that carries its own, so the control stays with the thing
                        it controls rather than migrating to the toolbar. */}
                    <div className="sqlstudio-ctx">
                        <span className="sqlstudio-glyph">
                            <Database size={15} strokeWidth={1.8} />
                        </span>
                        <span className="sqlstudio-titles">
                            <b>SQL Studio</b>
                            <small>{nodeName ? `node · ${nodeName}` : 'node'}</small>
                        </span>
                    </div>
                    <span className="sqlstudio-ro">
                        <Lock size={12} strokeWidth={2} /> Read-only
                    </span>
                    <span className="sqlstudio-spacer" />
                    <button
                        type="button"
                        className="editor-help-btn"
                        onClick={() => startEditorTour('sql')}
                        title="Show the SQL Studio tour"
                        aria-label="Show the SQL Studio tour"
                    >
                        <HelpCircle size={16} />
                    </button>
                    <button
                        type="button"
                        className="sqlstudio-btn"
                        onClick={formatMain}
                        title="Auto-format the query"
                    >
                        <AlignLeft size={14} strokeWidth={2} /> Format
                    </button>
                    <button
                        type="button"
                        className={`sqlstudio-btn${showAi ? ' sqlstudio-btn--on' : ''}`}
                        onClick={() => setShowAi(v => !v)}
                        title="Ask AI to write SQL (text-to-SQL)"
                        data-tour="sqlstudio-askai"
                    >
                        <Sparkles size={14} strokeWidth={2} /> Ask AI
                    </button>
                    <button
                        type="button"
                        className="sqlstudio-btn sqlstudio-btn--primary"
                        onClick={apply}
                        disabled={onApplyToNode == null}
                        title="Write the main query back to the node"
                        data-tour="sqlstudio-apply"
                    >
                        <ArrowUpToLine size={14} strokeWidth={2} /> Apply to node
                    </button>
                </div>

                <div className="sqlstudio-panes" data-tour="sqlstudio-editor">
                    <QueryPane
                        label={
                            // The handover lives with the thing it hands over,
                            // not in the toolbar: it is a statement about THIS
                            // editor's contents.
                            <span className="blk-mode">
                                <button
                                    type="button"
                                    className={`blk-mode-toggle${
                                        builderMode ? ' blk-mode-toggle--on' : ''
                                    }`}
                                    onClick={toggleBuilder}
                                    role="switch"
                                    aria-checked={builderMode}
                                    title={
                                        builderMode
                                            ? 'Switch the builder off and edit this SQL by hand'
                                            : 'Build this query from the tables on the left'
                                    }
                                >
                                    <span className="blk-mode-knob" />
                                </button>
                                Query · {builderMode ? 'built' : 'hand-written'}
                            </span>
                        }
                        sql={editorSql}
                        onChange={setMainSql}
                        run={runQuery}
                        tables={tables}
                        // In builder mode the SQL is a projection of the builder
                        // state, so editing it here would be edits with nowhere
                        // to live.
                        readOnly={builderMode}
                        className={split ? 'sqlstudio-pane--split' : undefined}
                    />
                    {split && (
                        <QueryPane
                            label={
                                <span className="sqlstudio-pane-ai">
                                    <Sparkles size={13} /> AI draft
                                </span>
                            }
                            sql={aiDraft ?? ''}
                            onChange={v => setAiDraft(v)}
                            run={runQuery}
                            tables={tables}
                            className="sqlstudio-pane--split"
                            actions={
                                <>
                                    <button
                                        type="button"
                                        className="sqlstudio-btn sqlstudio-btn--primary"
                                        onClick={acceptAiDraft}
                                        title="Copy this into the main query and close the split"
                                    >
                                        <Check size={14} strokeWidth={2} /> Use this
                                    </button>
                                    <button
                                        type="button"
                                        className="sqlstudio-btn"
                                        onClick={() => setAiDraft(null)}
                                        title="Discard the AI draft"
                                    >
                                        <X size={14} strokeWidth={2} /> Dismiss
                                    </button>
                                </>
                            }
                        />
                    )}
                </div>
            </div>

            {/* Always mounted so collapsing the pane keeps its conversation. */}
            <AiPane
                visible={showAi}
                onCollapse={() => setShowAi(false)}
                tables={tables}
                relationships={relationships}
                currentSql={mainSql}
                workspacePath={workspacePath}
                onInsert={setAiDraft}
            />
        </div>
    );
}
