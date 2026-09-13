// A searchable column picker.
//
// NOT a `<datalist>`, which is the obvious choice and the wrong one: the
// browser filters a datalist by the field's current VALUE, so once a column is
// chosen the dropdown offers only that column and the field can no longer be
// changed. That bug is already recorded against the ERD's column inputs
// (blocks-erd handoff §4), along with the note that clearing on focus does not
// fix it — Chromium computes the list on click and a programmatic value change
// does not reliably re-filter it.
//
// So: a text input that tracks TYPING separately from the COMMITTED value, and
// filters only while typing. Same shape as the fix that worked there.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Aggregate } from './builder-types';

export interface ColumnOption {
    table: string;
    column: string;
    /**
     * Set for the grouping filter: the option is the SUMMARISED column.
     *
     * It shows and searches as `count(Item.Item)`, because that is what a HAVING
     * rule compares. Offering the bare `Item.Item` there invited a comparison
     * against a value the grouped query does not have.
     */
    aggregate?: Aggregate;
}

export interface ColumnPickerProps {
    value: ColumnOption;
    options: ColumnOption[];
    onChange: (option: ColumnOption) => void;
    className?: string;
}

/** What the field shows and what typing is matched against. */
const label = (o: ColumnOption) =>
    o.aggregate && o.aggregate !== 'none'
        ? `${o.aggregate}(${o.table}.${o.column})`
        : `${o.table}.${o.column}`;

export default function ColumnPicker({ value, options, onChange, className }: ColumnPickerProps) {
    const [typed, setTyped] = useState<string | null>(null);
    const [open, setOpen] = useState(false);
    const box = useRef<HTMLDivElement>(null);
    /**
     * Where to draw the list, in viewport coordinates.
     *
     * The list is PORTALLED to the body and positioned fixed, because the
     * accordion section it lives in scrolls — and a scroll container clips
     * anything absolutely positioned inside it, however high the z-index. The
     * dropdown was being cut off at the section's edge.
     */
    const [at, setAt] = useState<{ left: number; top: number; width: number } | null>(null);

    useLayoutEffect(() => {
        if (!open) return;
        const place = () => {
            const r = box.current?.getBoundingClientRect();
            if (!r) return;
            // Flip above when there is more room there — near the bottom of a
            // laptop screen the list would otherwise open off-screen.
            const below = window.innerHeight - r.bottom;
            const height = Math.min(220, below > 160 ? below - 8 : r.top - 8);
            setAt({
                left: r.left,
                top: below > 160 ? r.bottom + 2 : r.top - height - 2,
                width: r.width,
            });
        };
        place();
        // Capture phase: the section scrolls, not the window, so the event does
        // not bubble to us.
        window.addEventListener('scroll', place, true);
        window.addEventListener('resize', place);
        return () => {
            window.removeEventListener('scroll', place, true);
            window.removeEventListener('resize', place);
        };
    }, [open]);

    // Clicking anywhere else commits what is there and closes.
    useEffect(() => {
        if (!open) return;
        const away = (e: MouseEvent) => {
            const t = e.target as Node;
            const inList = (t as HTMLElement).closest?.('.blk-colpick-list');
            if (box.current && !box.current.contains(t) && !inList) {
                setOpen(false);
                setTyped(null);
            }
        };
        document.addEventListener('mousedown', away);
        return () => document.removeEventListener('mousedown', away);
    }, [open]);

    const q = (typed ?? '').trim().toLowerCase();
    // Filter only while TYPING. With a committed value the list stays whole, so
    // the next choice is one click away rather than needing the field cleared.
    const shown = q
        ? options.filter(o => label(o).toLowerCase().includes(q))
        : options;

    const commit = (o: ColumnOption) => {
        onChange(o);
        setTyped(null);
        setOpen(false);
    };

    return (
        <div className={`blk-colpick${className ? ` ${className}` : ''}`} ref={box}>
            <input
                value={typed ?? label(value)}
                placeholder="Column"
                onChange={e => {
                    setTyped(e.target.value);
                    setOpen(true);
                }}
                onFocus={() => setOpen(true)}
                onKeyDown={e => {
                    if (e.key === 'Escape') {
                        setTyped(null);
                        setOpen(false);
                    }
                    if (e.key === 'Enter' && shown.length > 0) {
                        e.preventDefault();
                        commit(shown[0]);
                    }
                }}
                aria-label="Column to filter on"
            />
            {open && at
                ? createPortal(
                      <ul
                          className="blk-colpick-list"
                          style={{ left: at.left, top: at.top, width: at.width }}
                      >
                          {shown.slice(0, 60).map(o => (
                              <li key={label(o)}>
                                  <button
                                      type="button"
                                      className={
                                          label(o) === label(value)
                                              ? 'blk-colpick-on'
                                              : undefined
                                      }
                                      // mousedown, not click: the input's blur
                                      // would otherwise close the list before
                                      // the click lands.
                                      onMouseDown={e => {
                                          e.preventDefault();
                                          commit(o);
                                      }}
                                  >
                                      {o.aggregate && o.aggregate !== 'none' ? (
                                          <>
                                              {o.aggregate}(<i>{o.table}.</i>
                                              {o.column})
                                          </>
                                      ) : (
                                          <>
                                              <i>{o.table}.</i>
                                              {o.column}
                                          </>
                                      )}
                                  </button>
                              </li>
                          ))}
                          {shown.length === 0 ? (
                              <li className="blk-colpick-none">No column matches</li>
                          ) : null}
                      </ul>,
                      document.body,
                  )
                : null}
        </div>
    );
}
