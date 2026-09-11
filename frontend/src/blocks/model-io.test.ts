import { describe, expect, it } from 'vitest';
import { mergeRelationships } from './model-io';
import type { ErdRelationship, ErdTable } from '../erd/model';

function rel(over: Partial<ErdRelationship> & { id: string }): ErdRelationship {
    return {
        fromTable: 'Item',
        fromColumn: 'Item',
        toTable: 'ItemLocation',
        toColumn: 'Item',
        ...over,
    };
}

const tables: ErdTable[] = [
    { name: 'Item', columns: [{ name: 'Item' }] },
    { name: 'ItemLocation', columns: [{ name: 'Item' }] },
];

describe('mergeRelationships', () => {
    it('falls back to inference when nothing has been authored', () => {
        const inferred = [rel({ id: 'a', inferred: true })];
        expect(mergeRelationships([], inferred, tables)).toEqual(inferred);
    });

    // The rule that matters. Inference would still guess a join the user
    // deliberately removed, so re-offering it on every load would make deletion
    // impossible — the edit would silently undo itself.
    it('does not resurrect a relationship the user deleted', () => {
        const saved = [rel({ id: 'kept' })];
        const inferred = [rel({ id: 'kept' }), rel({ id: 'deleted', inferred: true })];
        expect(mergeRelationships(saved, inferred, tables).map(r => r.id)).toEqual(['kept']);
    });

    // A pipeline that stops writing a table leaves relationships pointing at
    // nothing; drawing them would put edges on a diagram with no such box.
    it('drops relationships whose tables have left the catalog', () => {
        const saved = [rel({ id: 'live' }), rel({ id: 'stale', toTable: 'Gone' })];
        expect(mergeRelationships(saved, [], tables).map(r => r.id)).toEqual(['live']);
    });

    // If every saved relationship has gone stale we are back to knowing
    // nothing, so inference is the right starting point again.
    it('re-offers inference when every saved relationship went stale', () => {
        const saved = [rel({ id: 'stale', fromTable: 'Gone', toTable: 'AlsoGone' })];
        const inferred = [rel({ id: 'fresh', inferred: true })];
        expect(mergeRelationships(saved, inferred, tables).map(r => r.id)).toEqual(['fresh']);
    });

    it('keeps an authored relationship inference would never have guessed', () => {
        const saved = [rel({ id: 'manual', fromColumn: 'Item', toColumn: 'Item', inferred: false })];
        expect(mergeRelationships(saved, [], tables)).toEqual(saved);
    });
});
