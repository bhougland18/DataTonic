import { useMemo, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { groupByTag } from './endpointModel';
import type { EndpointOperation } from './types';

interface EndpointTreeProps {
    endpoints: EndpointOperation[];
    selectedId: string | null;
    onSelect: (id: string) => void;
}

// Navigable endpoint tree (PL-4): operations grouped by tag, each row showing
// method, path, and summary. Groups collapse; all start open so the whole
// surface of the API is visible on import.
export default function EndpointTree({ endpoints, selectedId, onSelect }: EndpointTreeProps) {
    const groups = useMemo(() => groupByTag(endpoints), [endpoints]);
    const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

    const toggle = (key: string) =>
        setCollapsed((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });

    if (endpoints.length === 0) {
        return <div className="pg-note">This spec declares no operations.</div>;
    }

    return (
        <div className="pg-tree" role="tree">
            {groups.map((group) => {
                const isCollapsed = collapsed.has(group.key);
                return (
                    <div className="pg-group" key={group.key}>
                        <button
                            type="button"
                            className="pg-group-head"
                            aria-expanded={!isCollapsed}
                            onClick={() => toggle(group.key)}
                        >
                            <ChevronRight
                                size={14}
                                className={`pg-caret${isCollapsed ? '' : ' pg-caret--open'}`}
                            />
                            <span className="pg-group-label">{group.label}</span>
                            <span className="pg-group-count">{group.endpoints.length}</span>
                        </button>
                        {!isCollapsed && (
                            <ul className="pg-group-body" role="group">
                                {group.endpoints.map((ep) => (
                                    <li key={ep.id}>
                                        <button
                                            type="button"
                                            role="treeitem"
                                            aria-selected={ep.id === selectedId}
                                            className={`pg-endpoint${ep.id === selectedId ? ' pg-endpoint--active' : ''}${ep.deprecated ? ' pg-endpoint--deprecated' : ''}`}
                                            onClick={() => onSelect(ep.id)}
                                            title={ep.summary ?? ep.path}
                                        >
                                            <span className={`pg-method pg-method--${ep.method}`}>
                                                {ep.method.toUpperCase()}
                                            </span>
                                            <span className="pg-endpoint-path">{ep.path}</span>
                                            {ep.summary && (
                                                <span className="pg-endpoint-summary">{ep.summary}</span>
                                            )}
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                );
            })}
        </div>
    );
}
