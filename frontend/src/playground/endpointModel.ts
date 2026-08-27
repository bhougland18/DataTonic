// Turning the flat endpoint list into a navigable tree (PL-4). Grouped by tag,
// with an "Untagged" bucket for operations that declare none — spec order is
// preserved within a group so the tree mirrors the document.

import type { EndpointOperation } from './types';

export interface EndpointGroup {
    key: string;
    label: string;
    endpoints: EndpointOperation[];
}

const UNTAGGED = '__untagged__';

// Group by the operation's first tag (the conventional primary tag). Operations
// with no tag collect under a single "Untagged" group shown last.
export function groupByTag(endpoints: EndpointOperation[]): EndpointGroup[] {
    const groups = new Map<string, EndpointOperation[]>();
    for (const ep of endpoints) {
        const tag = ep.tags[0] ?? UNTAGGED;
        const bucket = groups.get(tag);
        if (bucket) bucket.push(ep);
        else groups.set(tag, [ep]);
    }
    const named = [...groups.entries()]
        .filter(([key]) => key !== UNTAGGED)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, eps]) => ({ key, label: key, endpoints: eps }));
    const untagged = groups.get(UNTAGGED);
    if (untagged) named.push({ key: UNTAGGED, label: 'Untagged', endpoints: untagged });
    return named;
}
