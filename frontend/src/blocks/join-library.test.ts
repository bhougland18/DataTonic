import { describe, expect, it } from 'vitest';
import {
    applicableJoins,
    joinId,
    parseJoinLibrary,
    removeJoin,
    toSavedJoin,
    upsertJoin,
    type SavedJoin,
} from './join-library';
import { mergeRelationships } from './model-io';
import { joinSql, qualifierSql, type ErdRelationship, type ErdTable } from '../erd/model';

function saved(over: Partial<SavedJoin> = {}): SavedJoin {
    const base = {
        fromTable: 'POLINE',
        fromColumn: 'PO',
        toTable: 'MMDIST',
        toColumn: 'PO',
        ...over,
    };
    return { id: joinId(base), scope: 'workspace', updatedAt: 1, ...base, ...over } as SavedJoin;
}

const tables: ErdTable[] = [
    { name: 'POLINE', columns: [{ name: 'PO' }, { name: 'Line' }] },
    { name: 'MMDIST', columns: [{ name: 'PO' }, { name: 'source' }] },
];

describe('applicableJoins', () => {
    it('applies a join whose tables and columns are all present', () => {
        expect(applicableJoins([saved()], tables)).toEqual([
            {
                id: 'POLINE.PO->MMDIST.PO',
                fromTable: 'POLINE',
                fromColumn: 'PO',
                toTable: 'MMDIST',
                toColumn: 'PO',
                inferred: false,
            },
        ]);
    });

    it('skips a join whose table is not on the canvas', () => {
        expect(applicableJoins([saved({ toTable: 'GONE' })], tables)).toEqual([]);
    });

    // A stale entry pointing at a dropped column would otherwise fail at Run,
    // with an error blaming the query rather than the library that caused it.
    it('skips a join whose column no longer exists', () => {
        expect(applicableJoins([saved({ fromColumn: 'dropped' })], tables)).toEqual([]);
    });

    it('does not emit the same join twice when both scopes hold it', () => {
        const both = [saved({ scope: 'global' }), saved({ scope: 'workspace' })];
        expect(applicableJoins(both, tables)).toHaveLength(1);
    });

    // loadJoinLibrary lists global first, so the workspace entry must override.
    // The narrower scope knows something the general case does not — usually a
    // qualifier — and first-wins would silently drop that refinement.
    it('lets a workspace entry override the global one of the same shape', () => {
        const both = [
            saved({ scope: 'global' }),
            saved({
                scope: 'workspace',
                qualifiers: [{ table: 'MMDIST', column: 'source', op: '=', value: 'RQ' }],
            }),
        ];
        const [out] = applicableJoins(both, tables);
        expect(out.qualifiers).toEqual([
            { table: 'MMDIST', column: 'source', op: '=', value: 'RQ' },
        ]);
    });

    it('carries qualifiers onto the applied relationship', () => {
        const j = saved({ qualifiers: [{ table: 'MMDIST', column: 'source', op: '=', value: 'RQ' }] });
        expect(applicableJoins([j], tables)[0].qualifiers).toHaveLength(1);
    });
});

describe('qualifierSql', () => {
    it('quotes a string value', () => {
        expect(qualifierSql({ table: 'MMDIST', column: 'source', op: '=', value: 'RQ' })).toBe(
            "MMDIST.source = 'RQ'",
        );
    });

    it('escapes an embedded quote rather than breaking the literal', () => {
        expect(qualifierSql({ table: 'T', column: 'c', op: '=', value: "O'Brien" })).toBe(
            "T.c = 'O''Brien'",
        );
    });

    it('emits an unquoted literal only when asked', () => {
        expect(qualifierSql({ table: 'T', column: 'c', op: '=', value: '42', numeric: true })).toBe(
            'T.c = 42',
        );
    });

    // An ERP code that looks numeric usually is not: unquoting `00123` would
    // silently match 123 instead.
    it('quotes a numeric-looking value by default', () => {
        expect(qualifierSql({ table: 'T', column: 'c', op: '=', value: '00123' })).toBe(
            "T.c = '00123'",
        );
    });

    it('falls back to quoting when numeric is asked for but the value is not', () => {
        expect(qualifierSql({ table: 'T', column: 'c', op: '=', value: 'abc', numeric: true })).toBe(
            "T.c = 'abc'",
        );
    });
});

describe('joinSql', () => {
    it('renders the key alone when there are no qualifiers', () => {
        expect(joinSql({ id: 'x', fromTable: 'A', fromColumn: 'k', toTable: 'B', toColumn: 'k' })).toBe(
            'A.k = B.k',
        );
    });

    // The Infor case: POLINE.PO = MMDIST.PO AND MMDIST.source = 'RQ'.
    it('ANDs qualifiers onto the key', () => {
        expect(
            joinSql({
                id: 'x',
                fromTable: 'POLINE',
                fromColumn: 'PO',
                toTable: 'MMDIST',
                toColumn: 'PO',
                qualifiers: [{ table: 'MMDIST', column: 'source', op: '=', value: 'RQ' }],
            }),
        ).toBe("POLINE.PO = MMDIST.PO AND MMDIST.source = 'RQ'");
    });
});

describe('mergeRelationships precedence', () => {
    const lib: ErdRelationship[] = [
        {
            id: 'POLINE.PO->MMDIST.PO',
            fromTable: 'POLINE',
            fromColumn: 'PO',
            toTable: 'MMDIST',
            toColumn: 'PO',
            inferred: false,
        },
    ];
    const guess: ErdRelationship[] = [
        { ...lib[0], inferred: true },
        {
            id: 'POLINE.Line->MMDIST.source',
            fromTable: 'POLINE',
            fromColumn: 'Line',
            toTable: 'MMDIST',
            toColumn: 'source',
            inferred: true,
        },
    ];

    it('prefers what the workspace saved over both library and inference', () => {
        const mine: ErdRelationship[] = [
            {
                id: 'mine',
                fromTable: 'POLINE',
                fromColumn: 'Line',
                toTable: 'MMDIST',
                toColumn: 'PO',
            },
        ];
        expect(mergeRelationships(mine, guess, tables, lib).map(r => r.id)).toEqual(['mine']);
    });

    // The point of curating a join is that a name-matching guess between the
    // same two columns must not displace it.
    it('prefers the library over an inferred join of the same shape', () => {
        const out = mergeRelationships([], guess, tables, lib);
        expect(out.find(r => r.id === 'POLINE.PO->MMDIST.PO')?.inferred).toBe(false);
    });

    it('still contributes inferred joins the library does not cover', () => {
        expect(mergeRelationships([], guess, tables, lib).map(r => r.id)).toContain(
            'POLINE.Line->MMDIST.source',
        );
    });

    it('falls back to inference when the library is empty', () => {
        expect(mergeRelationships([], guess, tables, [])).toEqual(guess);
    });
});

describe('list operations', () => {
    it('upsert replaces an entry of the same id and scope', () => {
        const a = saved({ notes: 'first' });
        const b = saved({ notes: 'second' });
        expect(upsertJoin([a], b)).toEqual([b]);
    });

    // Same join, two scopes, is two entries: one is the engagement's, one is
    // the consultant's own, and deleting from one must not touch the other.
    it('upsert keeps the same join in a different scope separate', () => {
        const ws = saved({ scope: 'workspace' });
        const gl = saved({ scope: 'global' });
        expect(upsertJoin([ws], gl)).toHaveLength(2);
    });

    it('remove deletes only the matching scope', () => {
        const ws = saved({ scope: 'workspace' });
        const gl = saved({ scope: 'global' });
        expect(removeJoin([ws, gl], ws.id, 'workspace')).toEqual([gl]);
    });
});

describe('parseJoinLibrary', () => {
    it('reads the versioned file shape', () => {
        const text = JSON.stringify({
            kind: 'duckle.erd-library',
            version: 1,
            joins: [saved()],
        });
        expect(parseJoinLibrary(text)).toHaveLength(1);
    });

    it('reads a bare array too', () => {
        expect(parseJoinLibrary(JSON.stringify([saved()]))).toHaveLength(1);
    });

    // Importing is taking on someone else's library; silently promoting it to
    // global would spread it into every workspace opened afterwards.
    it('defaults an unscoped import to workspace, not global', () => {
        const text = JSON.stringify([{ fromTable: 'A', fromColumn: 'x', toTable: 'B', toColumn: 'x' }]);
        expect(parseJoinLibrary(text)[0].scope).toBe('workspace');
    });

    it('drops entries that are not joins', () => {
        const text = JSON.stringify([{ nope: true }, saved()]);
        expect(parseJoinLibrary(text)).toHaveLength(1);
    });
});

describe('toSavedJoin', () => {
    it('keys the entry on its endpoints so saving twice is one entry', () => {
        const r: ErdRelationship = {
            id: 'whatever',
            fromTable: 'POLINE',
            fromColumn: 'PO',
            toTable: 'MMDIST',
            toColumn: 'PO',
        };
        expect(toSavedJoin(r, 'global').id).toBe('POLINE.PO->MMDIST.PO');
    });
});
