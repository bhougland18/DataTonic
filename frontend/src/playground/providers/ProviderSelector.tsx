import { PROVIDERS, type ProviderId } from './types';

interface ProviderSelectorProps {
    value: ProviderId;
    onChange: (id: ProviderId) => void;
}

// Segmented provider switcher at the top of the Playground sidebar (approved
// mockup). Switching provider swaps the sidebar's source panel; it does not
// touch an already-parsed spec's request/response state.
export default function ProviderSelector({ value, onChange }: ProviderSelectorProps) {
    return (
        <div className="pg-provider">
            <span className="pg-provider-lbl">Provider</span>
            <div className="pg-provider-seg" role="tablist" aria-label="API provider">
                {PROVIDERS.map((p) => (
                    <button
                        key={p.id}
                        type="button"
                        role="tab"
                        aria-selected={p.id === value}
                        className={`pg-provider-btn${p.id === value ? ' pg-provider-btn--on' : ''}`}
                        disabled={!p.enabled}
                        onClick={() => onChange(p.id)}
                    >
                        {p.id === 'infor' && <span className="pg-provider-infor" aria-hidden="true" />}
                        {p.label}
                    </button>
                ))}
            </div>
        </div>
    );
}
