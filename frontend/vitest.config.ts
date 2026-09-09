import { defineConfig } from 'vitest/config';

// Fork-owned test config (DataTonic). Kept separate from vite.config.ts so the
// production build is untouched. First slice covers pure, deterministic helpers
// (no DOM, no Tauri invoke) — hence the `node` environment. When component tests
// arrive, add `environment: 'jsdom'` + the `@tauri-apps/api/core` mock alias.
export default defineConfig({
    test: {
        include: ['src/**/*.test.ts'],
        environment: 'node',
        coverage: {
            provider: 'v8',
            include: [
                'src/regexstudio/**',
                'src/playground/providers/infor/**',
                'src/erd/**',
            ],
        },
    },
});
