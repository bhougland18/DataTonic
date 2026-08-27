import { useRef, useState } from 'react';
import { Upload, Link2, Loader2, AlertTriangle } from 'lucide-react';
import { importFromFile, importFromUrl } from './specSource';
import type { SpecParseIssue } from './types';

interface ImportBarProps {
    busy: boolean;
    errors: SpecParseIssue[];
    onImport: (input: Awaited<ReturnType<typeof importFromFile>>) => void;
    onError: (issues: SpecParseIssue[]) => void;
}

// Import controls (PL-1): a file picker and a URL field. Errors — whether from
// fetching or from parsing — render here, each naming its specific location so
// no failure is generic (PL-5).
export default function ImportBar({ busy, errors, onImport, onError }: ImportBarProps) {
    const fileRef = useRef<HTMLInputElement>(null);
    const [url, setUrl] = useState('');

    const handleFile = async (file: File | null) => {
        if (!file) return;
        try {
            onImport(await importFromFile(file));
        } catch (err) {
            onError([{ message: (err as Error).message }]);
        }
    };

    const handleUrl = async () => {
        const trimmed = url.trim();
        if (!trimmed) return;
        try {
            onImport(await importFromUrl(trimmed));
        } catch (err) {
            onError([{ message: (err as Error).message }]);
        }
    };

    return (
        <div className="pg-import">
            <div className="pg-import-row">
                <button
                    type="button"
                    className="pg-btn"
                    disabled={busy}
                    onClick={() => fileRef.current?.click()}
                >
                    <Upload size={15} strokeWidth={1.75} />
                    Import file
                </button>
                <input
                    ref={fileRef}
                    type="file"
                    accept=".json,.yaml,.yml,application/json,application/yaml,text/yaml"
                    hidden
                    onChange={(e) => {
                        void handleFile(e.target.files?.[0] ?? null);
                        e.target.value = '';
                    }}
                />
            </div>
            <div className="pg-import-row">
                <div className="pg-url">
                    <Link2 size={14} strokeWidth={1.75} />
                    <input
                        type="url"
                        placeholder="https://api.example.com/openapi.json"
                        value={url}
                        disabled={busy}
                        onChange={(e) => setUrl(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') void handleUrl();
                        }}
                    />
                </div>
                <button type="button" className="pg-btn" disabled={busy || !url.trim()} onClick={() => void handleUrl()}>
                    Import URL
                </button>
            </div>

            {busy && (
                <div className="pg-note pg-note--busy">
                    <Loader2 size={14} className="pg-spin" /> Parsing spec…
                </div>
            )}

            {errors.length > 0 && (
                <div className="pg-errors" role="alert">
                    <div className="pg-errors-head">
                        <AlertTriangle size={14} strokeWidth={2} />
                        Could not import this spec
                    </div>
                    <ul>
                        {errors.map((e, i) => (
                            <li key={i}>
                                {e.location && <code>{e.location}</code>}
                                <span>{e.message}</span>
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </div>
    );
}
