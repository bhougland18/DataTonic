// A collapsible section of the left panel.
//
// The panel holds three questions — which columns, in what order, joined how —
// and they are not all live at once: once the columns are picked, that section
// is a tall list of things already decided, sitting on top of the one being
// worked on. Collapsing is how the panel stays usable past three tables.
//
// Collapsed state persists, because "I am done with this section" is a
// statement about the work rather than about this minute, and having to
// re-collapse on every visit would make the control not worth using.

import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

export interface PanelSectionProps {
    title: string;
    /** Right-aligned in the header — a count, or anything short. */
    badge?: ReactNode;
    /** Where the collapsed state is remembered. */
    storageKey: string;
    /**
     * The section that gives up height when the panel runs out of it.
     *
     * Not "take the leftover space" — that is what this used to do, and with a
     * short table list it left a screen of nothing between the last table and
     * the next section's header, which read as the end of the panel. The
     * sections now stack from the top at their natural height; this one is
     * simply the one that shrinks and scrolls when they no longer fit.
     */
    shrink?: boolean;
    defaultOpen?: boolean;
    children: ReactNode;
}

/**
 * Read a remembered open/closed state.
 *
 * Exported because the panel that HOLDS these sections collapses too, and the
 * two should behave the same way — same storage convention, same shrug when a
 * browser refuses storage.
 */
export function readPanelOpen(key: string, fallback: boolean): boolean {
    try {
        const v = localStorage.getItem(key);
        return v === null ? fallback : v === 'open';
    } catch {
        // A browser refusing storage is not a reason to fail to render.
        return fallback;
    }
}

export function writePanelOpen(key: string, open: boolean): void {
    try {
        localStorage.setItem(key, open ? 'open' : 'closed');
    } catch {
        /* not worth failing the click over */
    }
}

export default function PanelSection({
    title,
    badge,
    storageKey,
    shrink,
    defaultOpen = true,
    children,
}: PanelSectionProps) {
    const [open, setOpen] = useState(() => readPanelOpen(storageKey, defaultOpen));

    const toggle = () => {
        setOpen(o => {
            writePanelOpen(storageKey, !o);
            return !o;
        });
    };

    return (
        <section
            className={`blk-sec${open ? ' blk-sec--open' : ''}${
                open && shrink ? ' blk-sec--shrink' : ''
            }`}
        >
            <button
                type="button"
                className="blk-sec-head"
                onClick={toggle}
                aria-expanded={open}
                title={open ? `Collapse ${title}` : `Expand ${title}`}
            >
                {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                <span className="blk-sec-title">{title}</span>
                {badge != null ? <span className="blk-sec-badge">{badge}</span> : null}
            </button>
            {open ? <div className="blk-sec-body">{children}</div> : null}
        </section>
    );
}
