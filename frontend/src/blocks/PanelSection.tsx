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
    /** Take the leftover height, rather than only what the content needs. */
    grow?: boolean;
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
    grow,
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
                open && grow ? ' blk-sec--grow' : ''
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
