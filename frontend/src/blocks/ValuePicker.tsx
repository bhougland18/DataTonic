// A filter value box that can show you what is in the column.
//
// Still a TEXT INPUT first and a list second, which is the whole design. Fifty
// values is a cap, not a claim — a column with ten thousand distinct values
// gives fifty of them, and `contains` is not picking from a list at all. So
// typing always works and the list is an offer, never a gate.
//
// Probes LAZILY, on first focus. Every interactive query here spawns the DuckDB
// CLI at a measured ~115 ms floor, so probing every filter when the panel
// renders would stall the panel to fill in dropdowns nobody had opened.

import { useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2 } from 'lucide-react';
import { useAnchoredPopup, useClickAway } from './popup';
import { VALUE_LIMIT, type ValueOption } from './distinct-values';

export interface ValuePickerProps {
    value: string;
    onChange: (next: string) => void;
    /**
     * Fetch the column's values. Absent — an unpicked column, or the grouping
     * filter, where the values are aggregates and no list exists — leaves this
     * an ordinary text box.
     */
    fetch?: () => Promise<ValueOption[]>;
    /**
     * What clicking an option does. Defaults to replacing the text.
     *
     * `in` overrides it to APPEND, because that operator holds a list and
     * picking a second value should add to it rather than discard the first.
     */
    onPick?: (picked: string) => void;
    placeholder?: string;
    inputMode?: 'decimal';
    ariaLabel?: string;
}

export default function ValuePicker({
    value,
    onChange,
    fetch,
    onPick,
    placeholder,
    inputMode,
    ariaLabel,
}: ValuePickerProps) {
    const [open, setOpen] = useState(false);
    const [options, setOptions] = useState<ValueOption[] | null>(null);
    const [loading, setLoading] = useState(false);
    const box = useRef<HTMLDivElement>(null);
    const at = useAnchoredPopup(open, box);

    const close = useCallback(() => setOpen(false), []);
    useClickAway(open, box, 'blk-valpick-list', close);

    const load = useCallback(() => {
        if (!fetch || options !== null || loading) return;
        setLoading(true);
        void fetch()
            .then(setOptions)
            .finally(() => setLoading(false));
    }, [fetch, options, loading]);

    const show = () => {
        if (!fetch) return;
        setOpen(true);
        load();
    };

    // Filtered by what has been TYPED, so the list narrows as you go — but only
    // against the current text, never against a value already committed, which
    // is the trap `ColumnPicker` documents for `<datalist>`.
    const q = value.trim().toLowerCase();
    const shown = (options ?? []).filter(o => !q || o.value.toLowerCase().includes(q));

    const choose = (v: string) => {
        (onPick ?? onChange)(v);
        setOpen(false);
    };

    return (
        <div className="blk-valpick" ref={box}>
            <input
                className="blk-filter-val"
                value={value}
                placeholder={placeholder}
                inputMode={inputMode}
                aria-label={ariaLabel}
                onFocus={show}
                onChange={e => {
                    onChange(e.target.value);
                    show();
                }}
                onKeyDown={e => {
                    if (e.key === 'Escape') setOpen(false);
                    // Enter takes the top match, the same as the column picker.
                    if (e.key === 'Enter' && open && shown.length > 0) {
                        e.preventDefault();
                        choose(shown[0].value);
                    }
                }}
            />
            {open && at
                ? createPortal(
                      <ul
                          className="blk-valpick-list"
                          style={{ left: at.left, top: at.top, width: Math.max(at.width, 180) }}
                      >
                          {loading ? (
                              <li className="blk-valpick-note">
                                  <Loader2 size={12} className="sqlstudio-spin" /> Reading values…
                              </li>
                          ) : null}
                          {!loading &&
                              shown.map(o => (
                                  <li key={o.value}>
                                      <button
                                          type="button"
                                          // mousedown, not click: the input's blur
                                          // would close the list first otherwise.
                                          onMouseDown={e => {
                                              e.preventDefault();
                                              choose(o.value);
                                          }}
                                      >
                                          <span className="blk-valpick-v">{o.value}</span>
                                          <span className="blk-valpick-n">{o.count}</span>
                                      </button>
                                  </li>
                              ))}
                          {!loading && options !== null && options.length === 0 ? (
                              <li className="blk-valpick-note">
                                  No values — type one instead.
                              </li>
                          ) : null}
                          {!loading && options !== null && options.length > 0 && shown.length === 0 ? (
                              <li className="blk-valpick-note">Nothing matches what you typed.</li>
                          ) : null}
                          {/* Said only when the cap was actually hit, so it
                              reads as information rather than as a disclaimer
                              on every column. */}
                          {!loading && options !== null && options.length >= VALUE_LIMIT ? (
                              <li className="blk-valpick-note blk-valpick-cap">
                                  Most common {VALUE_LIMIT}. Type to filter, or enter any value.
                              </li>
                          ) : null}
                      </ul>,
                      document.body,
                  )
                : null}
        </div>
    );
}
