// Reporting — domain types (DataTonic).
//
// This layer ASSEMBLES analysis blocks (`blocks/`) into a deliverable. It does
// not author queries or charts; that is the Blocks studio's job, and keeping
// the two apart is what lets one block feed a dashboard, a report and a deck
// without being rewritten for each.
//
// The ready/planned split below is borrowed deliberately from
// `workflow-ui/HomeLauncher.tsx`, which states the rule plainly: "is it built"
// is encoded in the TYPE, not in a boolean somebody remembers to set. A ready
// assembler carries the function that opens it; a planned one structurally
// cannot. There is no third state where a tile looks live and does nothing.
//
// This file is intentionally free of upstream imports.

import type { ComponentType } from 'react';

type IconComponent = ComponentType<{ size?: number | string; strokeWidth?: number }>;

/** The three deliverables the reporting layer can assemble. */
export type ReportingOutput = 'dashboard' | 'report' | 'deck';

/** One capability an assembler needs before it can ship. Drives an honest
 *  readiness meter rather than a decorative one. */
export interface AssemblerPart {
    name: string;
    /** Tracker ref, so the tile doubles as the roadmap. */
    ref: string;
    done: boolean;
}

interface AssemblerBase {
    id: ReportingOutput;
    label: string;
    blurb: string;
    icon: IconComponent;
    parts: AssemblerPart[];
}

/** Shipped, and `open` is what opens it. Non-optional on purpose. */
export type ReadyAssembler = AssemblerBase & {
    status: 'ready';
    open: () => void;
};

/** On the roadmap. `open` is forbidden, so the tile cannot be clicked. */
export type PlannedAssembler = AssemblerBase & {
    status: 'planned';
    open?: never;
};

export type Assembler = ReadyAssembler | PlannedAssembler;

/** A saved deliverable: an assembled arrangement of block references. */
export interface ReportingArtifact {
    schemaVersion: 1;
    id: string;
    title: string;
    output: ReportingOutput;
    /** Ids of the blocks this deliverable arranges — never inlined copies, so
     *  editing a block updates every deliverable that uses it. */
    blockIds: string[];
}
