// Fork-owned unit tests for Infor field-type detection (DataTonic).
//
// The FieldSpec -> DataType mapping is the correctness core of this feature:
// Landmark declares every value as a JSON string, so this map is the ONLY thing
// standing between the pipeline and mistyped columns. The case that matters most
// is `Item` staying `string` — item codes, GL accounts and cost centres are
// digit-y text, and typing them numeric strips leading zeros irreversibly.
import { describe, it, expect } from 'vitest';
import { fieldSpecToFieldType, parseBundle, INFOR_DATE_FORMAT } from './fieldTypes';

describe('fieldSpecToFieldType', () => {
    it('keeps a StringField as string even though the value looks numeric', () => {
        // Live-verified shape for `Item` against a real FSM tenant.
        const e = fieldSpecToFieldType({ string: true, alphaType: true, className: 'StringField' });
        expect(e.type).toBe('string');
        expect(e.source).toBe('api');
    });

    it('maps a BigDecimalField to float64, not the decimal DataType', () => {
        // `decimal` would map to a bare DuckDB DECIMAL (= DECIMAL(18,3)) and
        // TRUNCATE a decimalSize-7 field like UOMConversion.
        const e = fieldSpecToFieldType({
            number: true,
            decimal: true,
            className: 'BigDecimalField',
            decimalSize: 7,
        });
        expect(e.type).toBe('float64');
    });

    it('maps a non-decimal number to int64', () => {
        expect(fieldSpecToFieldType({ number: true, className: 'IntegerField' }).type).toBe('int64');
    });

    it('maps a DateYMD field to date AND carries the YYYYMMDD format', () => {
        // Without the format, TRY_CAST('20260826' AS DATE) is NULL — every
        // Infor date column would silently empty.
        const e = fieldSpecToFieldType({
            date: true,
            dateOnly: true,
            className: 'DateYMDField',
            size: 8,
        });
        expect(e.type).toBe('date');
        expect(e.format).toBe(INFOR_DATE_FORMAT);
    });

    it('maps booleans and timestamps', () => {
        expect(fieldSpecToFieldType({ boolean: true }).type).toBe('bool');
        expect(fieldSpecToFieldType({ timeStamp: true }).type).toBe('timestamp');
    });

    it('prefers the more specific flag when a spec carries several', () => {
        // A date field may also report string-ish flags; date must win or the
        // column loses its type.
        const e = fieldSpecToFieldType({ string: true, date: true, className: 'DateYMDField' });
        expect(e.type).toBe('date');
    });

    it('falls back to string for an unrecognised spec', () => {
        // The safe direction: a wrongly-stringed number is inconvenient, a
        // wrongly-numbered code is data loss.
        expect(fieldSpecToFieldType({}).type).toBe('string');
        expect(fieldSpecToFieldType({ someUnknownFlag: true }).type).toBe('string');
    });

    it('accepts string "true" as well as boolean true', () => {
        expect(fieldSpecToFieldType({ number: 'true', decimal: 'true' }).type).toBe('float64');
    });
});

describe('parseBundle', () => {
    const good = {
        kind: 'duckle.infor.fieldTypes',
        schemaVersion: 1,
        tenant: 'T1',
        dataArea: 'FSM',
        exportedAt: '2026-09-13T00:00:00.000Z',
        count: 1,
        entries: { 'Item/UOMConversion': { type: 'float64', source: 'api' } },
    };

    it('round-trips a well-formed bundle', () => {
        const b = parseBundle(JSON.stringify(good));
        expect(b?.tenant).toBe('T1');
        expect(b?.dataArea).toBe('FSM');
        expect(b?.entries['Item/UOMConversion'].type).toBe('float64');
    });

    it('recounts entries rather than trusting the declared count', () => {
        const b = parseBundle(JSON.stringify({ ...good, count: 999 }));
        expect(b?.count).toBe(1);
    });

    it('rejects anything without the kind marker', () => {
        // Guards against importing a saved-query file, which is the other
        // JSON the same panel offers.
        expect(parseBundle(JSON.stringify({ ...good, kind: 'something.else' }))).toBeNull();
        expect(parseBundle('{"entries":{}}')).toBeNull();
        expect(parseBundle('not json')).toBeNull();
    });

    it('rejects a bundle with no entries object', () => {
        expect(parseBundle(JSON.stringify({ kind: 'duckle.infor.fieldTypes' }))).toBeNull();
    });

    it('defaults an unknown data area to FSM', () => {
        const b = parseBundle(JSON.stringify({ ...good, dataArea: 'NOPE' }));
        expect(b?.dataArea).toBe('FSM');
    });
});
