// Bringing a spec into the Playground (PL-1): by file upload or by URL. This
// only fetches raw text and describes its origin; parsing is specParser's job.

import type { SpecSource } from './types';

// Guess the serialization from filename/content-type/body so persistence keeps
// the right extension and a re-parse is faithful. YAML is the default only when
// the text clearly is not JSON.
function detectFormat(hint: string, body: string): 'json' | 'yaml' {
    const h = hint.toLowerCase();
    if (h.endsWith('.json') || h.includes('json')) return 'json';
    if (h.endsWith('.yaml') || h.endsWith('.yml') || h.includes('yaml')) return 'yaml';
    const t = body.trimStart();
    return t.startsWith('{') || t.startsWith('[') ? 'json' : 'yaml';
}

export interface ImportedText {
    text: string;
    source: SpecSource;
}

// Read a user-picked File (drag-drop or file input) as text (PL-1).
export async function importFromFile(file: File): Promise<ImportedText> {
    const text = await file.text();
    return {
        text,
        source: {
            kind: 'file',
            ref: file.name,
            format: detectFormat(file.name, text),
            importedAt: new Date().toISOString(),
        },
    };
}

// Fetch a spec by URL (PL-1). A plain browser fetch is used deliberately: this
// retrieves the *spec document*, not a call against the target API, so it does
// not need the proxy-aware send path that S1 flagged for PL-11. Cross-origin
// spec hosts that block CORS will fail here — the caller surfaces that honestly
// and the file-upload path remains the fallback.
export async function importFromUrl(url: string): Promise<ImportedText> {
    let res: Response;
    try {
        res = await fetch(url, { headers: { Accept: 'application/json, application/yaml, text/yaml, */*' } });
    } catch (err) {
        throw new Error(
            `Could not fetch the spec from ${url}. If the host blocks cross-origin requests, download the file and import it directly. (${(err as Error).message})`,
        );
    }
    if (!res.ok) {
        throw new Error(`Fetching ${url} returned HTTP ${res.status} ${res.statusText}.`);
    }
    const text = await res.text();
    return {
        text,
        source: {
            kind: 'url',
            ref: url,
            format: detectFormat(res.headers.get('content-type') ?? url, text),
            importedAt: new Date().toISOString(),
        },
    };
}
