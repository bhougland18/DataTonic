// The provider model (Phase A of the Infor provider plan). A "provider" lets the
// Playground target a specific platform's discovery + auth, not just raw spec
// import. `generic` is the fallback (today's file/URL import); `infor` is the
// first real provider, built out across tasks 1i (auth), 1g/1h (discovery), and
// the _generic query builder. The richer PlaygroundProvider contract (auth /
// discovery / queryBuilder hooks) lands incrementally as each phase needs it —
// this file stays intentionally small so the scaffold adds no speculative
// surface. See docs/plans/infor-provider-playground.md.

export type ProviderId = 'generic' | 'infor';

export interface ProviderMeta {
    id: ProviderId;
    label: string;
    // False would render present-but-disabled (RAIL-5 style). Infor is enabled
    // so its scaffold panel is reachable while its steps are still being built.
    enabled: boolean;
}

export const PROVIDERS: ProviderMeta[] = [
    { id: 'generic', label: 'Generic', enabled: true },
    { id: 'infor', label: 'Infor', enabled: true },
];
