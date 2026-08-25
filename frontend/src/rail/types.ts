import type { ComponentType } from 'react';
import { Waypoints, Plug, FileText, LayoutDashboard } from 'lucide-react';

// The rail-selectable modes. Canvas is the existing pipeline designer; the
// other three are the new DataTonic modules, added incrementally. Keeping the
// full set listed (even before each ships) is deliberate — see RAIL-5.
export type AppMode = 'canvas' | 'playground' | 'reports' | 'dashboards';

// Version-agnostic icon shape: lucide-react icons are components taking a
// `size`/`strokeWidth`. Typed structurally so we don't depend on a specific
// lucide type-export name across versions.
type IconComponent = ComponentType<{ size?: number | string; strokeWidth?: number }>;

export interface RailModeMeta {
    id: AppMode;
    label: string;
    icon: IconComponent;
    // Present-but-disabled until the module ships, so the rail's layout stays
    // stable across incremental releases (RAIL-5).
    enabled: boolean;
}

export const RAIL_MODES: RailModeMeta[] = [
    { id: 'canvas', label: 'Canvas', icon: Waypoints, enabled: true },
    { id: 'playground', label: 'API Playground', icon: Plug, enabled: false },
    { id: 'reports', label: 'Typst Reports', icon: FileText, enabled: false },
    { id: 'dashboards', label: 'HTML/JS Dashboards', icon: LayoutDashboard, enabled: false },
];
