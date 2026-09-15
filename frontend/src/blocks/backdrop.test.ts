import { describe, expect, it } from 'vitest';
import { backdropGesture } from './backdrop';

const BACKDROP = { id: 'backdrop' };
const INPUT = { id: 'input' };

const on = (target: unknown) => ({ target, currentTarget: BACKDROP });

describe('backdropGesture', () => {
    it('dismisses when the whole gesture happened on the backdrop', () => {
        let closed = 0;
        const g = backdropGesture(() => (closed += 1));
        g.onMouseDown(on(BACKDROP));
        g.onClick(on(BACKDROP));
        expect(closed).toBe(1);
    });

    // The reported bug: drag-select inside the name field and release past the
    // edge of the dialog. `click` fires on the nearest common ancestor of press
    // and release — the backdrop — so the old `target === currentTarget` check
    // passed and the half-typed name was thrown away.
    it('does NOT dismiss when the drag started inside the dialog', () => {
        let closed = 0;
        const g = backdropGesture(() => (closed += 1));
        g.onMouseDown(on(INPUT));
        g.onClick(on(BACKDROP));
        expect(closed).toBe(0);
    });

    it('does not dismiss on a click that lands inside the dialog', () => {
        let closed = 0;
        const g = backdropGesture(() => (closed += 1));
        g.onMouseDown(on(BACKDROP));
        g.onClick(on(INPUT));
        expect(closed).toBe(0);
    });

    // A press on the backdrop released elsewhere must not leave the next click
    // armed, or the dialog closes on an unrelated later click.
    it('does not arm the following click', () => {
        let closed = 0;
        const g = backdropGesture(() => (closed += 1));
        g.onMouseDown(on(BACKDROP));
        g.onClick(on(INPUT));
        g.onClick(on(BACKDROP));
        expect(closed).toBe(0);
    });

    it('still dismisses on a later, genuine click-away', () => {
        let closed = 0;
        const g = backdropGesture(() => (closed += 1));
        g.onMouseDown(on(INPUT));
        g.onClick(on(BACKDROP));
        g.onMouseDown(on(BACKDROP));
        g.onClick(on(BACKDROP));
        expect(closed).toBe(1);
    });
});
