// A visual filter for Infor _generic queries (task 1u). Users build a tree of
// conditions with plain operators + AND/OR + nested groups; we compile it to
// LPL (_lplFilter) so nobody has to write LPL by hand. Example output:
//   ((Item like "100*") or (ItemGroup like "200*"))

export type FilterOp =
    | 'beginsWith'
    | 'equal'
    | 'notEqual'
    | 'contains'
    | 'greaterThan'
    | 'lessThan';

export const FILTER_OPS: { id: FilterOp; label: string }[] = [
    { id: 'beginsWith', label: 'Begins with' },
    { id: 'equal', label: 'Equal to' },
    { id: 'notEqual', label: 'Not equal to' },
    { id: 'contains', label: 'Contains' },
    { id: 'greaterThan', label: 'Greater than' },
    { id: 'lessThan', label: 'Less than' },
];

export interface FilterRule {
    id: string;
    kind: 'rule';
    field: string;
    op: FilterOp;
    value: string;
}
export interface FilterGroup {
    id: string;
    kind: 'group';
    conj: 'and' | 'or';
    children: FilterNode[];
}
export type FilterNode = FilterRule | FilterGroup;

let idCounter = 0;
function nid(): string {
    try {
        return crypto.randomUUID();
    } catch {
        idCounter += 1;
        return `f${idCounter}`;
    }
}

export function newRule(field = ''): FilterRule {
    return { id: nid(), kind: 'rule', field, op: 'beginsWith', value: '' };
}
export function newGroup(conj: 'and' | 'or' = 'and', children: FilterNode[] = []): FilterGroup {
    return { id: nid(), kind: 'group', conj, children };
}
export function emptyFilter(): FilterGroup {
    return newGroup('and', []);
}

// A rule counts only when both field and value are filled; a filter with zero
// complete rules is "no filter".
function countRules(n: FilterNode): number {
    if (n.kind === 'rule') return n.field.trim() && n.value.trim() ? 1 : 0;
    return n.children.reduce((s, c) => s + countRules(c), 0);
}
export function isEmptyFilter(g: FilterGroup): boolean {
    return countRules(g) === 0;
}

// ---- LPL generation ----

function esc(s: string): string {
    return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
// Infor treats these fields as strings, so every value is quoted — matching
// what Infor's own filter builder emits (e.g. Item = "111", Item like "100*").
function operand(value: string): string {
    return `"${esc(value.trim())}"`;
}

function ruleToLpl(r: FilterRule): string | null {
    const f = r.field.trim();
    const v = r.value.trim();
    if (!f || !v) return null;
    switch (r.op) {
        case 'beginsWith':
            return `${f} like "${esc(v)}*"`;
        case 'contains':
            return `${f} like "*${esc(v)}*"`;
        case 'equal':
            return `${f} = ${operand(v)}`;
        case 'notEqual':
            return `${f} != ${operand(v)}`;
        case 'greaterThan':
            return `${f} > ${operand(v)}`;
        case 'lessThan':
            return `${f} < ${operand(v)}`;
        default:
            return null;
    }
}

function nodeToLpl(n: FilterNode): string | null {
    if (n.kind === 'rule') return ruleToLpl(n);
    const parts = n.children.map(nodeToLpl).filter((s): s is string => s !== null);
    if (parts.length === 0) return null;
    if (parts.length === 1) return parts[0];
    return `(${parts.join(` ${n.conj} `)})`;
}

// Compile the tree to an LPL string ('' when there are no complete rules).
export function filterToLpl(root: FilterGroup): string {
    return nodeToLpl(root) ?? '';
}

// ---- (de)serialization ----

// Rebuild a valid tree from stored/imported JSON, assigning fresh ids and
// dropping anything malformed. Falls back to an empty filter.
export function hydrateFilter(x: unknown): FilterGroup {
    const g = emptyFilter();
    if (x && typeof x === 'object' && (x as { kind?: unknown }).kind === 'group') {
        const o = x as { conj?: unknown; children?: unknown };
        g.conj = o.conj === 'or' ? 'or' : 'and';
        if (Array.isArray(o.children)) {
            g.children = o.children
                .map(hydrateNode)
                .filter((n): n is FilterNode => n !== null);
        }
    }
    return g;
}
function hydrateNode(x: unknown): FilterNode | null {
    if (!x || typeof x !== 'object') return null;
    const o = x as { kind?: unknown; field?: unknown; op?: unknown; value?: unknown };
    if (o.kind === 'group') return hydrateFilter(x);
    if (o.kind === 'rule') {
        const op = FILTER_OPS.some((k) => k.id === o.op) ? (o.op as FilterOp) : 'beginsWith';
        return {
            id: nid(),
            kind: 'rule',
            field: typeof o.field === 'string' ? o.field : '',
            op,
            value: typeof o.value === 'string' ? o.value : '',
        };
    }
    return null;
}

// Upgrade an old simple `field::value|field2::value2` filter into a tree of
// AND-joined "begins with" rules, so pre-existing nodes keep working.
export function filterFromSimple(filter: string | undefined): FilterGroup {
    const g = emptyFilter();
    if (!filter) return g;
    for (const part of filter.split('|')) {
        const i = part.indexOf('::');
        if (i < 0) continue;
        const field = part.slice(0, i).trim();
        const value = part.slice(i + 2).trim();
        if (field) g.children.push({ id: nid(), kind: 'rule', field, op: 'beginsWith', value });
    }
    return g;
}
