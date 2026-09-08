import './rail.css';
import { useState } from 'react';
import type { AppMode, RailModeMeta } from './types';
import { RAIL_MODES } from './types';

interface RailProps {
    mode: AppMode;
    onSelect: (mode: AppMode) => void;
    // Optional per-mode visibility. A mode is shown unless this returns false —
    // used to keep contextual modes (e.g. the API Playground, which is opened
    // from a Canvas node) off the rail until they're actually in use.
    isVisible?: (m: RailModeMeta) => boolean;
    // Right-click → Close on a contextual surface. Not offered for Canvas.
    onClose?: (mode: AppMode) => void;
}

// Persistent left rail for mode switching (RAIL-1..RAIL-5). Renders every mode
// as an icon button; unimplemented modes are shown disabled so the layout does
// not shift as modules land.
export default function Rail({ mode, onSelect, isVisible, onClose }: RailProps) {
    // Which button's context menu is open, and where to anchor it.
    const [menu, setMenu] = useState<{ id: AppMode; y: number } | null>(null);

    return (
        <nav className="rail" aria-label="Application mode">
            {RAIL_MODES.map((m) => {
                if (isVisible && !isVisible(m)) return null;
                const Icon = m.icon;
                const active = m.id === mode;
                const label = m.enabled ? m.label : `${m.label} — coming soon`;
                // Canvas is the home surface; everything else is closable.
                const closable = !!onClose && m.enabled && m.id !== 'canvas';
                return (
                    <button
                        key={m.id}
                        type="button"
                        className={`rail-btn${active ? ' rail-btn--active' : ''}`}
                        aria-current={active ? 'page' : undefined}
                        aria-label={label}
                        title={label}
                        disabled={!m.enabled}
                        onClick={() => onSelect(m.id)}
                        onContextMenu={
                            closable
                                ? e => {
                                      e.preventDefault();
                                      setMenu({ id: m.id, y: e.currentTarget.getBoundingClientRect().top });
                                  }
                                : undefined
                        }
                    >
                        <Icon size={20} strokeWidth={1.75} />
                    </button>
                );
            })}

            {menu && (
                <>
                    {/* click-away overlay */}
                    <div className="rail-menu-scrim" onClick={() => setMenu(null)} onContextMenu={e => { e.preventDefault(); setMenu(null); }} />
                    <div className="rail-menu" style={{ top: menu.y }} role="menu">
                        <button
                            type="button"
                            className="rail-menu-item"
                            role="menuitem"
                            onClick={() => {
                                onClose?.(menu.id);
                                setMenu(null);
                            }}
                        >
                            Close
                        </button>
                    </div>
                </>
            )}
        </nav>
    );
}
