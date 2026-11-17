/**
 * The platform's build helpers (scripts/esbuild-dialogram.mjs), which the extension's build, the
 * SVG renderer and a product's build share: what they write, what they refuse.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { describe, expect, it } from 'vitest';
import { dialogramAlias, dialogramPackagesOnly, writeLegacyDecoratorBundles } from '../../../scripts/esbuild-dialogram.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGES = path.resolve(__dirname, '../..');

/** Build an entry module's text into `outdir` through the helpers' plugins. */
function build(outdir: string, contents: string, plugins: esbuild.Plugin[], tsconfigRaw?: esbuild.TsconfigRaw) {
    return esbuild.build({
        stdin: { contents, resolveDir: __dirname, loader: 'ts', sourcefile: 'entry.ts' },
        bundle: true,
        outdir,
        write: false,
        format: 'iife',
        platform: 'browser',
        target: 'ES2017',
        logLevel: 'silent',
        alias: dialogramAlias(PACKAGES),
        plugins,
        ...(tsconfigRaw ? { tsconfigRaw } : {})
    });
}

const freshDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dialogram-build-'));

describe('the platform build helpers', () => {
    it('leave an unchanged bundle alone, and replace a changed one whole', async () => {
        const dir = freshDir();
        const writer = writeLegacyDecoratorBundles({ relativeTo: dir });
        await build(dir, 'export const answer = 1;', [writer]);
        const out = path.join(dir, 'stdin.js');
        expect(fs.readFileSync(out, 'utf8')).toContain('answer');

        // An unchanged rebuild does not touch the file (a watcher is not woken for nothing).
        const longAgo = new Date(0);
        fs.utimesSync(out, longAgo, longAgo);
        await build(dir, 'export const answer = 1;', [writer]);
        expect(fs.statSync(out).mtimeMs).toBe(0);

        // A changed one is written, through a file beside it that is renamed over it.
        await build(dir, 'export const answer = 2;', [writer]);
        expect(fs.statSync(out).mtimeMs).toBeGreaterThan(0);
        expect(fs.readFileSync(out, 'utf8')).toContain('2');
        expect(fs.readdirSync(dir).filter(name => name.endsWith('.partial'))).toEqual([]);
    }, 60_000);

    it('fail a bundle with a standard decorator, and write nothing', async () => {
        const dir = freshDir();
        const decorated = 'const mark = (..._: unknown[]): any => undefined;\n@mark class Marked {}\nexport { Marked };';
        const built = build(dir, decorated, [writeLegacyDecoratorBundles({ relativeTo: dir })], {
            compilerOptions: { experimentalDecorators: false }
        });
        await expect(built).rejects.toMatchObject({
            errors: [expect.objectContaining({ text: expect.stringContaining('was compiled with standard decorators') })]
        });
        expect(fs.readdirSync(dir)).toEqual([]);
    }, 60_000);

    it('refuse a @dialogram package with no sources, and pass a known one to the alias', async () => {
        const dir = freshDir();
        const only = dialogramPackagesOnly(PACKAGES);
        await expect(build(dir, "import '@dialogram/nonesuch/thing';", [only])).rejects.toMatchObject({
            errors: [expect.objectContaining({ text: expect.stringContaining('@dialogram/nonesuch has no sources') })]
        });
        const known = await build(dir, "export { WorkflowDiagramTypes } from '@dialogram/shared';", [only]);
        expect(known.errors).toEqual([]);
        expect(known.outputFiles[0].text).toContain('node:boundary:input');
    }, 60_000);
});
