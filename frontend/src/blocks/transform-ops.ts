// What a column transformation can BE — one table, one entry per operation.
//
// The split against `builder-sql.ts` is deliberate and worth keeping: that file
// owns STRUCTURE (which clause gets which text, how the SELECT list is built,
// what GROUP BY has to match) and is the correctness surface for the query as a
// whole. This file owns the text of ONE operation. Without the split, adding
// the sixtieth function would mean editing the generator, and the generator is
// the thing that must stay reviewable.
//
// Seeded with aggregates only. The shape wants to settle against a family that
// already exists before the list grows (`column-transformations.md` §6, §10.3).
//
// **Vocabulary is shared with the engine on purpose.** `builders.rs` already
// ships `xf.agg`/`xf.groupby` (whose props are `groupKeys` plus
// `aggregations: [{ column, func, output }]`), `xf.num.*`, `xf.text.*`,
// `xf.dt.*`, `xf.regex.*`, `xf.case`, `xf.cast`, `xf.coalesce`. Where an
// operation exists both as a node and as a transformation, the parameter NAMES
// should match — two vocabularies for one idea drift silently, and the drift
// only shows up when somebody moves a query between the graph and the builder.

import { quoteIdent } from '../erd/model';
import {
    aggregatesFor,
    isNumericType,
    isTemporalType,
    type Aggregate,
    type ColumnTransform,
    type TransformArg,
    type TransformKind,
} from './builder-types';

/**
 * What a parameter needs from the person filling it in.
 *
 * `columns` (plural) and `branches` exist for windows and cases respectively.
 * They are declared now, unused by the aggregate family, so the modal can be
 * written against the full set rather than grown a field type at a time.
 */
export type ParamType = 'text' | 'number' | 'choice' | 'column' | 'columns' | 'branches';

export interface TransformParam {
    name: string;
    label: string;
    type: ParamType;
    /** For `choice`. */
    options?: string[];
    /** Pre-filled in the modal. A default is not the same as optional — a
     *  required param with a default still has to survive being cleared. */
    default?: string;
    /** A param that may be left empty and still produce valid SQL. */
    optional?: boolean;
    /** Shown under the field. The place to put the thing people get wrong. */
    hint?: string;
}

export interface TransformOp {
    id: string;
    kind: TransformKind;
    /** What the person picks it by. */
    label: string;
    /**
     * Whether this operation can run against a column of this type.
     *
     * Reuses `isNumericType` / `isTemporalType` from `builder-types` rather
     * than testing types again here, so there stays ONE answer per family to
     * the question "is this a number?". Two would drift into an operation that
     * is offered and cannot run.
     */
    accepts: (type?: string) => boolean;
    params: TransformParam[];
    /** The SQL fragment, given the already-quoted column reference. */
    sql: (col: string, args: Record<string, TransformArg>) => string;
    /**
     * The DuckDB type of the result, when it can be known from the input.
     *
     * Worth declaring rather than inferring downstream: `date_trunc` over a
     * DATE returns TIMESTAMP, which is measured and surprising, and the chart
     * matcher reads the result type to decide whether a column is `temporal`.
     * `undefined` means "same as the input, or not worth claiming".
     */
    resultType?: (inputType?: string) => string | undefined;
}

/** A scalar arg as a string; array args are not scalars and read as empty. */
export function argText(args: Record<string, TransformArg>, name: string): string {
    const v = args[name];
    return typeof v === 'string' ? v : '';
}

// ---------------------------------------------------------------------------
// Group by — the aggregate family
// ---------------------------------------------------------------------------
//
// `count` is the one that does not behave like the others: with no column it is
// `count(*)`, a row count, and that is a different question from counting a
// column's non-null values. The engine hit exactly this and left a note about
// it (`build_aggregate`): an empty column string is PRESENT, so `unwrap_or`
// never fired and it emitted `COUNT("")`, failing the run on a quoted empty
// identifier. Here the column is optional for `count` alone, and absent means
// `count(*)`.

const AGGREGATE_SQL: Record<Aggregate, (col: string) => string> = {
    none: col => col,
    count: col => `count(${col})`,
    'count distinct': col => `count(DISTINCT ${col})`,
    sum: col => `sum(${col})`,
    avg: col => `avg(${col})`,
    min: col => `min(${col})`,
    max: col => `max(${col})`,
};

/** Aggregates that always return a number, whatever the column held. */
const COUNTING: Aggregate[] = ['count', 'count distinct'];

function aggregateOp(agg: Exclude<Aggregate, 'none'>): TransformOp {
    return {
        id: agg,
        kind: 'aggregate',
        label: agg,
        // Asks the question `aggregatesFor` already answers, rather than
        // re-deriving it: `sum` over a VARCHAR does not return something odd,
        // it does not run at all.
        accepts: type => aggregatesFor(type).includes(agg),
        params: [],
        sql: col => AGGREGATE_SQL[agg](col),
        resultType: inputType => {
            if (COUNTING.includes(agg)) return 'BIGINT';
            if (agg === 'sum' || agg === 'avg') return isNumericType(inputType) ? 'DOUBLE' : undefined;
            // `min`/`max` return the column's own type - including a date, which
            // is why they must NOT be claimed as numeric.
            return inputType;
        },
    };
}

// ---------------------------------------------------------------------------
// Function — dates first, which is what reporting asks for
// ---------------------------------------------------------------------------

/** Units `date_trunc` takes, coarsest last. */
const TRUNC_UNITS = ['day', 'week', 'month', 'quarter', 'year'];

const sqlString = (s: string) => `'${s.replace(/'/g, "''")}'`;

const dateTrunc: TransformOp = {
    id: 'date_trunc',
    kind: 'function',
    label: 'Round date to…',
    // `date_trunc('month', <varchar>)` is `No function matches the given name
    // and argument types` — measured. The same dead end `sum` over a VARCHAR
    // is, so the operation is absent rather than present and broken.
    accepts: isTemporalType,
    params: [
        {
            name: 'unit',
            label: 'Round to',
            type: 'choice',
            options: TRUNC_UNITS,
            default: 'month',
            hint: 'A raw timestamp per row is noise on a line chart; bucketed, it is a trend.',
        },
    ],
    sql: (col, args) => `date_trunc(${sqlString(argText(args, 'unit'))}, ${col})`,
    // TIMESTAMP even for a DATE input — measured, and surprising. Declared
    // because the chart matcher reads this to call the column `temporal`.
    resultType: () => 'TIMESTAMP',
};

export const TRANSFORM_OPS: TransformOp[] = [
    dateTrunc,
    aggregateOp('sum'),
    aggregateOp('avg'),
    aggregateOp('count'),
    aggregateOp('count distinct'),
    aggregateOp('min'),
    aggregateOp('max'),
];

export function opById(id: string): TransformOp | undefined {
    return TRANSFORM_OPS.find(o => o.id === id);
}

/**
 * The operations offerable for one kind against one column type.
 *
 * An operation the column cannot take is ABSENT, not disabled — the rule
 * `aggregatesFor` and `bucketsFor` already follow. A disabled control invites
 * somebody to work out why; an absent one says the column is not that sort of
 * thing.
 */
export function opsFor(kind: TransformKind, type?: string): TransformOp[] {
    return TRANSFORM_OPS.filter(o => o.kind === kind && o.accepts(type));
}

/**
 * The SQL fragment a transformation contributes, without its output name.
 *
 * Returns null when the operation is unknown — a query saved against an
 * operation that has since been renamed should not silently emit something
 * else. The caller drops it and the panel can say so.
 */
export function transformExpression(t: ColumnTransform): string | null {
    const op = opById(t.op);
    if (!op) return null;
    const col = t.table && t.column ? `${quoteIdent(t.table)}.${quoteIdent(t.column)}` : '*';
    return op.sql(col, t.args);
}

/**
 * Whether a transformation has everything it needs to become SQL.
 *
 * The modal enforces this before letting anybody out, so a `false` here means
 * a transformation built before an operation gained a parameter, or one whose
 * column has since been dropped — not something half-typed.
 */
export function transformIsComplete(t: ColumnTransform): boolean {
    const op = opById(t.op);
    if (!op) return false;
    if (!t.alias.trim()) return false;
    // `count` alone may stand without a column: that is `count(*)`.
    const needsColumn = !(t.kind === 'aggregate' && t.op === 'count');
    if (needsColumn && !(t.table && t.column)) return false;
    return op.params.every(p => p.optional || argText(t.args, p.name).trim() !== '');
}

/**
 * The output name an operation suggests before anybody edits it.
 *
 * `sum Line.Quantity`, matching the shape `builder-sql`'s `transformAlias`
 * already produces for a summarised column, so the two surfaces do not name the
 * same thing two ways while both exist.
 */
export function suggestedAlias(t: ColumnTransform): string {
    const where = t.table && t.column ? ` ${t.table}.${t.column}` : '';
    return `${t.op}${where}`.trim();
}
