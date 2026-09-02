import './rail.css';
import type { AppMode, RailModeMeta } from './types';
import { RAIL_MODES } from './types';

interface RailProps {
    mode: AppMode;
    onSelect: (mode: AppMode) => void;
    // Optional per-mode visibility. A mode is shown unless this returns false —
    // used to keep contextual modes (e.g. the API Playground, which is opened
    // from a Canvas node) off the rail until they're actually in use.
    isVisible?: (m: RailModeMeta) => boolean;
}

// Persistent left rail for mode switching (RAIL-1..RAIL-5). Renders every mode
// as an icon button; unimplemented modes are shown disabled so the layout does
// not shift as modules land.
export default function Rail({ mode, onSelect, isVisible }: RailProps) {
    return (
        <nav className="rail" aria-label="Application mode">
            {RAIL_MODES.map((m) => {
                if (isVisible && !isVisible(m)) return null;
                const Icon = m.icon;
                const active = m.id === mode;
                const label = m.enabled ? m.label : `${m.label} — coming soon`;
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
                    >
                        <Icon size={20} strokeWidth={1.75} />
                    </button>
                );
            })}
        </nav>
    );
}
