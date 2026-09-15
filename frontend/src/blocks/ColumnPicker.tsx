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

import { useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Aggregate } from './builder-types';
import { useAnchoredPopup, useClickAway } from './popup';

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
    /**
     * Set when the option is a COMPUTED column rather than a source one.
     *
     * It shows and searches by the name the person gave it, because that is
     * the only name it has — `Total Qty`, not `sum(Line.Quantity)`. The rule
     * carries this id through, and the generator turns it into the alias.
     */
    transformId?: string;
    /** Overrides the derived label. Set for computed columns. */
    label?: string;
}

export interface ColumnPickerProps {
    value: ColumnOption;
    options: ColumnOption[];
    onChange: (option: ColumnOption) => void;
    className?: string;
}

/** What the field shows and what typing is matched against. */
const label = (o: ColumnOption) =>
    o.label ??
    (o.aggregate && o.aggregate !== 'none'
        ? `${o.aggregate}(${o.table}.${o.column})`
        : `${o.table}.${o.column}`);

export default function ColumnPicker({ value, options, onChange, className }: ColumnPickerProps) {
    const [typed, setTyped] = useState<string | null>(null);
    const [open, setOpen] = useState(false);
    const box = useRef<HTMLDivElement>(null);
    // Portalled to `body` and positioned in viewport coordinates — see
    // `popup.ts` for why a dropdown inside a scrolling section cannot simply be
    // absolutely positioned.
    const at = useAnchoredPopup(open, box);

    // Clicking anywhere else commits what is there and closes.
    const close = useCallback(() => {
        setOpen(false);
        setTyped(null);
    }, []);
    useClickAway(open, box, 'blk-colpick-list', close);

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
