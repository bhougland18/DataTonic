// Bundle + run scripts/check-visible-when.ts under plain Node.
//
// Same arrangement as build-catalog.mjs and for the same reason: the
// manifests import the Tauri bridge, which has no meaning outside a Tauri
// window, so it is stubbed and the schemas are read without it.
import esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, 'check-visible-when.ts');
const bundle = resolve(tmpdir(), `duckle-check-visible-when-${process.pid}.mjs`);

const stubTauri = {
    name: 'stub-tauri',
    setup(build) {
        // Anything that needs a live Tauri/browser context becomes a no-op.
        build.onResolve({ filter: /(^|\/)tauri-bridge$/ }, () => ({ path: 'stub', namespace: 'stub' }));
        build.onResolve({ filter: /(^|\/)tauri-dialog$/ }, () => ({ path: 'stub', namespace: 'stub' }));
        build.onResolve({ filter: /^@tauri-apps\// }, () => ({ path: 'stub', namespace: 'stub' }));
        build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
            contents:
                'export const tauriAutodetect = async () => null;' +
                'export const invoke = async () => null;' +
                'export class Channel {}' +
                'export const isTauri = () => false;' +
                'export default {};',
            loader: 'js',
        }));
    },
};

await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: bundle,
    plugins: [stubTauri],
    logLevel: 'warning',
});

await import('file://' + bundle.replace(/\\/g, '/'));
rmSync(bundle, { force: true });
