import type { ComponentType } from 'react';
import { Waypoints, Plug, Database, Network, ChartNoAxesCombined, Blocks, Regex } from 'lucide-react';

// The rail-selectable modes. Canvas is the existing pipeline designer; the
// others are the new DataTonic modules, added incrementally. Keeping the
// full set listed (even before each ships) is deliberate — see RAIL-5.
// `sql` is the SQL Studio surface (code.sqlstudio); `erd` is the ER-model
// authoring surface (code.workingdb).
//
// `blocks` and `reporting` are the two surfaces above the graph, and the only
// ones that are NOT node-launched: they read durable sinks, so they are always
// available. They are separate entries on purpose — Analysis Blocks AUTHORS
// reusable pieces and Reporting ASSEMBLES them, and folding assembly into the
// authoring surface would re-couple what the three-layer split exists to keep
// apart (Canvas = ETL → Blocks = pieces → Reporting = deliverables).
export type AppMode =
    | 'canvas'
    | 'playground'
    | 'sql'
    | 'erd'
    | 'regex'
    | 'blocks'
    | 'reporting';

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
    { id: 'playground', label: 'API Playground', icon: Plug, enabled: true },
    { id: 'sql', label: 'SQL Studio', icon: Database, enabled: true },
    { id: 'erd', label: 'ER Model', icon: Network, enabled: true },
    { id: 'regex', label: 'Regex Studio', icon: Regex, enabled: true },
    // These two replace the disabled placeholders this rail carried for the
    // superseded plans ('Typst Reports' — Typst was dropped; 'HTML/JS
    // Dashboards' — dashboards are no longer a separate surface). Icons are
    // deliberately neither LayoutDashboard (the pipeline-monitor top-bar
    // button) nor FileText (the old Typst slot).
    { id: 'blocks', label: 'Blocks', icon: Blocks, enabled: true },
    { id: 'reporting', label: 'Reporting', icon: ChartNoAxesCombined, enabled: true },
];
