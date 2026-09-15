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
import { filterNodeSql } from './filter-sql';
import {
    aggregatesFor,
    isNumericType,
    isTemporalType,
    type Aggregate,
    type CaseBranch,
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
    /**
     * Why these arguments cannot become SQL yet, or null when they can.
     *
     * `params` says which boxes must be non-empty; this says whether what is IN
     * them makes sense. `1.10` is not a date and `Q1` is not a number, and both
     * would reach DuckDB as a syntax error — in a query built entirely from
     * controls, which is the thing the builder exists to make impossible.
     *
     * The message is shown in the dialog, so it is written for the person
     * filling the box in.
     */
    validate?: (args: Record<string, TransformArg>) => string | null;
}

/**
 * `Table.Column` as ONE value, since a column name alone is ambiguous.
 *
 * Encoded, not joined with a separator. Every separator can turn up in a real
 * name: this workspace holds a table called `item_norm.parquet`, so splitting
 * `item_norm.parquet.Item` at the first dot addresses a table called
 * `item_norm` and a column called `parquet.Item`, neither of which exists. It
 * would not error — it would resolve to nothing, or to the wrong column.
 *
 * Lives here rather than in the dialog because the GENERATOR has to read what
 * the dialog wrote, and one encoding with two owners drifts.
 */
export function addrOf(table: string, column: string): string {
    return JSON.stringify([table, column]);
}

export function unaddr(v: string): [string, string] {
    try {
        const [table, column] = JSON.parse(v) as [string, string];
        return [table ?? '', column ?? ''];
    } catch {
        // Typed by hand, or saved before this was encoded. Split at the LAST
        // dot: a table may contain one, a column name far less often.
        const i = v.lastIndexOf('.');
        return i < 0 ? ['', v] : [v.slice(0, i), v.slice(i + 1)];
    }
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

// ---------------------------------------------------------------------------
// Literal — a fixed value on every row
// ---------------------------------------------------------------------------
//
// The only operation that reads no column. Cheap, and genuinely useful: a
// hard-coded label is how results from several queries get stacked into one
// report and stay tellable apart.

const LITERAL_TYPES = ['text', 'number', 'date'];

/**
 * A typed constant.
 *
 * The TYPE is asked for rather than guessed from the text. `2026` is a
 * perfectly good label for a column of years, and sniffing would quietly turn
 * it into a number; `1.10` is a version, and a number would make it `1.1`.
 */
function literalSql(value: string, type: string): string {
    if (type === 'number') return value.trim();
    if (type === 'date') return `DATE ${sqlString(value.trim())}`;
    return sqlString(value);
}

const literal: TransformOp = {
    id: 'literal',
    kind: 'literal',
    label: 'Fixed value',
    accepts: () => true,
    params: [
        {
            name: 'type',
            label: 'Type',
            type: 'choice',
            options: LITERAL_TYPES,
            default: 'text',
        },
        { name: 'value', label: 'Value', type: 'text', hint: 'The same on every row.' },
    ],
    sql: (_col, args) => literalSql(argText(args, 'value'), argText(args, 'type')),
    resultType: () => undefined,
    // A number that is not one, or a date DuckDB will not read, is a syntax
    // error rather than a wrong answer — and it would be a syntax error in a
    // query somebody built entirely from controls, which is the thing the
    // builder exists to make impossible.
    validate: args => {
        const value = argText(args, 'value').trim();
        const type = argText(args, 'type') || 'text';
        if (type === 'number' && !/^-?\d+(\.\d+)?$/.test(value)) {
            return 'That is not a number.';
        }
        if (type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
            return 'Dates are YYYY-MM-DD.';
        }
        return null;
    },
};

// ---------------------------------------------------------------------------
// Case — different values under different conditions
// ---------------------------------------------------------------------------

/**
 * A THEN or an ELSE: a column reference, or a quoted literal.
 *
 * The flag is not a convenience. Without it the generator cannot tell
 * `'Vendor'` the word from `Vendor` the column, and getting that wrong is
 * silent — you get the word, on every row, and nothing errors.
 */
function valueSql(text: string, isColumn?: boolean): string {
    if (!isColumn) return sqlString(text);
    const [table, column] = unaddr(text.trim());
    return table ? `${quoteIdent(table)}.${quoteIdent(column)}` : quoteIdent(column);
}

const caseOp: TransformOp = {
    id: 'case',
    kind: 'case',
    label: 'When / then',
    accepts: () => true,
    // Only the branches. A CASE gets a bespoke editor, and that editor owns the
    // ELSE too — it belongs with the WHENs it completes, not in a field below
    // them under a different name.
    params: [{ name: 'branches', label: 'Conditions', type: 'branches' }],
    sql: (_col, args) => {
        const branches = Array.isArray(args.branches) ? (args.branches as CaseBranch[]) : [];
        const whens = branches
            .map(b => {
                const when = filterNodeSql(b.when);
                return when === null
                    ? null
                    : `WHEN ${when} THEN ${valueSql(b.then, b.thenIsColumn)}`;
            })
            .filter((s): s is string => s !== null);
        const otherwise = argText(args, 'else').trim();
        // No ELSE is legal and returns NULL — measured. So an empty box means
        // "leave the rest alone" rather than an unfinished expression.
        const tail =
            otherwise === ''
                ? []
                : [`ELSE ${valueSql(otherwise, argText(args, 'elseIsColumn') === 'yes')}`];
        // One branch per LINE. A case with four conditions on one line is a
        // horizontal scroll bar in the editor, and the whole point of
        // generating readable SQL is that somebody can check it. Indented four
        // from the CASE, which `builder-sql` then shifts under whichever clause
        // it lands in.
        return ['CASE', ...whens.map(w => `    ${w}`), ...tail.map(e => `    ${e}`), 'END'].join(
            '\n',
        );
    },
    // Every branch's own condition has to be finished. An incomplete one is
    // dropped by `filterNodeSql`, and a CASE that silently lost a branch gives
    // wrong answers rather than failing.
    validate: args => {
        const branches = Array.isArray(args.branches) ? (args.branches as CaseBranch[]) : [];
        if (branches.length === 0) return 'Add at least one condition.';
        if (branches.some(b => filterNodeSql(b.when) === null)) {
            return 'Every condition needs filling in.';
        }
        if (branches.some(b => b.then.trim() === '')) return 'Every condition needs a value.';
        return null;
    },
};

export const TRANSFORM_OPS: TransformOp[] = [
    dateTrunc,
    literal,
    caseOp,
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
    return transformProblem(t) === null;
}

/**
 * What stops this transformation becoming SQL, said in words.
 *
 * One function rather than a boolean and a separate message, so the dialog
 * cannot disable the button for one reason while explaining another.
 */
export function transformProblem(t: ColumnTransform): string | null {
    const op = opById(t.op);
    if (!op) return t.op ? `"${t.op}" is no longer available.` : 'Pick an operation.';
    if (!t.alias.trim()) return 'Give the column a name.';
    // Three kinds need no column of their own: `count` alone is `count(*)`, a
    // ROW count; a literal reads nothing at all; and a CASE names its columns
    // inside its branches, where this record cannot see them.
    const needsColumn =
        !(t.kind === 'aggregate' && t.op === 'count') &&
        t.kind !== 'literal' &&
        t.kind !== 'case';
    if (needsColumn && !(t.table && t.column)) return 'Pick a column.';
    const missing = op.params.find(
        p => !p.optional && p.type !== 'branches' && argText(t.args, p.name).trim() === '',
    );
    if (missing) return `${missing.label} is empty.`;
    return op.validate?.(t.args) ?? null;
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
