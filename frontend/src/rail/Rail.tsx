import './rail.css';
import type { AppMode } from './types';
import { RAIL_MODES } from './types';

interface RailProps {
    mode: AppMode;
    onSelect: (mode: AppMode) => void;
}

// Persistent left rail for mode switching (RAIL-1..RAIL-5). Renders every mode
// as an icon button; unimplemented modes are shown disabled so the layout does
// not shift as modules land.
export default function Rail({ mode, onSelect }: RailProps) {
    return (
        <nav className="rail" aria-label="Application mode">
            {RAIL_MODES.map((m) => {
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
