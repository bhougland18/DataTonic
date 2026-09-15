import { beforeEach, describe, expect, it } from 'vitest';
import {
    clampPanelWidth,
    DEFAULT_PANEL_WIDTH,
    getPanelWidth,
    MAX_PANEL_WIDTH,
    MIN_PANEL_WIDTH,
    setPanelWidth,
} from './panel-width';

// This suite runs without a DOM, and `panel-width` touches two browser things:
// `localStorage` through `persistence`, and `document` in `applyPanelWidth`.
// Both are stubbed rather than avoided, so the tests drive the real load/save
// path — including the `duckle:v1:` key prefix, which is the sort of detail a
// hand-rolled fake would get wrong and never notice.
const store = new Map<string, string>();
const PREFIX = 'duckle:v1:';

globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
        return store.size;
    },
} as Storage;

globalThis.document = {
    documentElement: { style: { setProperty: () => {} } },
} as unknown as Document;

describe('clampPanelWidth', () => {
    it('keeps a width that is already sensible', () => {
        expect(clampPanelWidth(340)).toBe(340);
    });

    // Dragging past either end is the normal case, not the exceptional one:
    // the pointer keeps going after the panel has stopped.
    it('holds at the floor and the ceiling', () => {
        expect(clampPanelWidth(-500)).toBe(MIN_PANEL_WIDTH);
        expect(clampPanelWidth(9999)).toBe(MAX_PANEL_WIDTH);
    });

    it('rounds to whole pixels', () => {
        expect(clampPanelWidth(300.6)).toBe(301);
    });
});

describe('getPanelWidth', () => {
    beforeEach(() => store.clear());

    it('starts at the default', () => {
        expect(getPanelWidth()).toBe(DEFAULT_PANEL_WIDTH);
    });

    it('remembers what was set', () => {
        setPanelWidth(420);
        expect(getPanelWidth()).toBe(420);
    });

    // A stored value outside the bounds means the bounds moved under a width
    // somebody saved months ago. Falling back beats restoring a panel that no
    // longer fits, which is a layout nobody can recover from by dragging.
    it('falls back when the stored width is out of bounds', () => {
        store.set(`${PREFIX}builderPanelWidth`, JSON.stringify(9999));
        expect(getPanelWidth()).toBe(DEFAULT_PANEL_WIDTH);
    });

    it('falls back when the stored value is not a number', () => {
        store.set(`${PREFIX}builderPanelWidth`, JSON.stringify('wide'));
        expect(getPanelWidth()).toBe(DEFAULT_PANEL_WIDTH);
    });

    it('never stores a width it would refuse to read back', () => {
        setPanelWidth(9999);
        expect(getPanelWidth()).toBe(MAX_PANEL_WIDTH);
    });
});
