// Persisting an Infor sign-in as a saved workspace Connection, so it survives
// reloads and can be shared by future Canvas nodes (task 1r). Reuses the
// existing `rest` connection kind — no new ConnectionKind, no Rust change — and
// stores the whole `.ionapi` config under `extra.secret`, which duckle-secrets
// encrypts at rest (the "secret" key is in SENSITIVE_KEYS and the encryptor
// walks nested objects). Non-secret bits (tenant, app, provider tag) stay plain
// for listing/filtering.

import type { ConnectionPayload } from '../../../repo-types';
import type { PlaygroundConnection } from '../../connectionBridge';
import type { IonApiConfig } from './ionapi';

export const INFOR_PROVIDER_TAG = 'infor';

export function toInforConnectionPayload(config: IonApiConfig): ConnectionPayload {
    return {
        kind: 'rest',
        url: config.ionApiBase,
        notes: `Infor ION API · ${config.tenant}`,
        extra: {
            provider: INFOR_PROVIDER_TAG,
            tenant: config.tenant,
            app: config.appName ?? '',
            // Whole .ionapi as one blob; the `secret` key is encrypted at rest.
            secret: JSON.stringify(config),
        },
    };
}

// Recover the IonApiConfig from a saved connection (decrypted in memory by the
// time it reaches the UI). Returns null if this isn't an Infor connection.
export function parseInforConfig(payload: ConnectionPayload | undefined): IonApiConfig | null {
    const blob = payload?.extra?.secret;
    if (!blob) return null;
    try {
        const cfg = JSON.parse(blob) as Partial<IonApiConfig>;
        return cfg && cfg.clientId && cfg.tokenUrl && cfg.ionApiBase ? (cfg as IonApiConfig) : null;
    } catch {
        return null;
    }
}

export function isInforConnection(conn: PlaygroundConnection): boolean {
    return conn.payload?.extra?.provider === INFOR_PROVIDER_TAG || parseInforConfig(conn.payload) !== null;
}
