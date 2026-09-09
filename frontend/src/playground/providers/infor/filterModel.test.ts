// Fork-owned unit tests for the Infor visual-filter -> LPL compiler (DataTonic).
// Pure in/out. Pins the LPL grammar, value escaping, and the hydrate round-trip
// that keeps persisted filters stable.
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
    FILTER_OPS,
    newGroup,
    newRule,
    emptyFilter,
    isEmptyFilter,
    filterToLpl,
    hydrateFilter,
    filterFromSimple,
    type FilterNode,
    type FilterOp,
} from './filterModel';

// Small typed rule builder (newRule sets a fresh id + defaults).
function rule(field: string, op: FilterOp, value: string) {
    return { ...newRule(field), op, value };
}

describe('filterToLpl', () => {
    it('is empty when there are no complete rules', () => {
        expect(filterToLpl(emptyFilter())).toBe('');
        expect(filterToLpl(newGroup('and', [newRule('Item')]))).toBe(''); // no value
    });

    it('emits a single rule without wrapping parens', () => {
        expect(filterToLpl(newGroup('and', [rule('Item', 'beginsWith', '100')]))).toBe(
            'Item like "100*"',
        );
    });

    it('joins multiple rules with the group conjunction inside parens', () => {
        const g = newGroup('or', [
            rule('Item', 'beginsWith', '100'),
            rule('ItemGroup', 'beginsWith', '200'),
        ]);
        expect(filterToLpl(g)).toBe('(Item like "100*" or ItemGroup like "200*")');
    });

    it('nests groups', () => {
        const g = newGroup('and', [
            rule('A', 'equal', '1'),
            newGroup('or', [rule('B', 'equal', '2'), rule('C', 'equal', '3')]),
        ]);
        expect(filterToLpl(g)).toBe('(A = "1" and (B = "2" or C = "3"))');
    });

    it('renders every operator', () => {
        const one = (op: FilterOp) => filterToLpl(newGroup('and', [rule('F', op, 'x')]));
        expect(one('beginsWith')).toBe('F like "x*"');
        expect(one('contains')).toBe('F like "*x*"');
        expect(one('equal')).toBe('F = "x"');
        expect(one('notEqual')).toBe('F != "x"');
        expect(one('greaterThan')).toBe('F > "x"');
        expect(one('lessThan')).toBe('F < "x"');
    });

    it('escapes quotes and backslashes in values', () => {
        // value is the 5 chars: a " b \ c  ->  esc doubles the backslash and
        // escapes the quote, giving:  F = "a\"b\\c"
        expect(filterToLpl(newGroup('and', [rule('F', 'equal', 'a"b\\c')]))).toBe(
            'F = "a\\"b\\\\c"',
        );
    });
});

describe('isEmptyFilter', () => {
    it('is true until a rule has both field and value', () => {
        expect(isEmptyFilter(emptyFilter())).toBe(true);
        expect(isEmptyFilter(newGroup('and', [newRule('Item')]))).toBe(true);
        expect(isEmptyFilter(newGroup('and', [rule('Item', 'equal', '1')]))).toBe(false);
    });
});

describe('filterFromSimple', () => {
    it('upgrades a legacy field::value|... string to AND-joined begins-with rules', () => {
        expect(filterToLpl(filterFromSimple('Item::100|Group::200'))).toBe(
            '(Item like "100*" and Group like "200*")',
        );
    });
    it('handles a single pair and ignores malformed segments', () => {
        expect(filterToLpl(filterFromSimple('Item::100'))).toBe('Item like "100*"');
        expect(filterToLpl(filterFromSimple('garbage'))).toBe('');
        expect(filterToLpl(filterFromSimple(undefined))).toBe('');
    });
});

describe('hydrateFilter', () => {
    it('maps an unknown operator to beginsWith and drops malformed nodes', () => {
        const h = hydrateFilter({
            kind: 'group',
            conj: 'or',
            children: [
                { kind: 'rule', field: 'A', op: 'nonsense', value: '1' },
                { kind: 'rule', field: 'B', op: 'equal', value: '2' },
                { kind: 'junk' },
                42,
            ],
        });
        expect(h.conj).toBe('or');
        expect(filterToLpl(h)).toBe('(A like "1*" or B = "2")');
    });
});

describe('properties (fast-check)', () => {
    const opArb = fc.constantFrom(...FILTER_OPS.map((o) => o.id));
    const fieldArb = fc.constantFrom('Item', 'Group', 'Qty', '');
    const valueArb = fc.string({ maxLength: 5 }); // includes quotes/backslashes
    const ruleArb = fc
        .record({ field: fieldArb, op: opArb, value: valueArb })
        .map(({ field, op, value }) => rule(field, op, value));
    const conjArb = fc.constantFrom('and', 'or');
    const subgroupArb = fc
        .record({ conj: conjArb, children: fc.array(ruleArb, { maxLength: 3 }) })
        .map(({ conj, children }) => newGroup(conj as 'and' | 'or', children));
    const childArb = fc.oneof(ruleArb, subgroupArb) as fc.Arbitrary<FilterNode>;
    const rootArb = fc
        .record({ conj: conjArb, children: fc.array(childArb, { maxLength: 4 }) })
        .map(({ conj, children }) => newGroup(conj as 'and' | 'or', children));

    it('hydrate(serialize(tree)) preserves the compiled LPL', () => {
        fc.assert(
            fc.property(rootArb, (g) => {
                const clone = JSON.parse(JSON.stringify(g));
                return filterToLpl(hydrateFilter(clone)) === filterToLpl(g);
            }),
        );
    });
});
