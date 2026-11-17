/**
 * The platform's build helpers (scripts/esbuild-dialogram.mjs), which the extension's build, the
 * SVG renderer and a product's build share: what `dialogramBuild` writes, and what it refuses.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { afterEach, describe, expect, it } from 'vitest';
import { dialogramBuild } from '../../../scripts/esbuild-dialogram.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGES = path.resolve(__dirname, '../..');

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
const freshDir = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dialogram-build-'));
    dirs.push(dir);
    return dir;
};

/** Build an entry module's text into `outdir` the way the platform builds. */
function build(
    outdir: string,
    contents: string,
    { plugins = [], tsconfigRaw, inMemory = false, external }: {
        plugins?: esbuild.Plugin[]; tsconfigRaw?: esbuild.TsconfigRaw; inMemory?: boolean; external?: string[];
    } = {}
) {
    return esbuild.build(dialogramBuild({
        stdin: { contents, resolveDir: __dirname, loader: 'ts', sourcefile: 'entry.ts' },
        bundle: true,
        outdir,
        format: 'iife',
        platform: 'browser',
        target: 'ES2017',
        logLevel: 'silent',
        metafile: true,
        plugins,
        ...(tsconfigRaw ? { tsconfigRaw } : {}),
        ...(external ? { external } : {})
    }, { packagesDir: PACKAGES, relativeTo: outdir, inMemory }));
}

describe('the platform build', () => {
    it('leaves an unchanged bundle alone, and writes a changed one in place', async () => {
        const dir = freshDir();
        await build(dir, 'export const answer = 41;');
        const out = path.join(dir, 'stdin.js');
        expect(fs.readFileSync(out, 'utf8')).toMatch(/answer = 41/);
        const { ino } = fs.statSync(out);

        // An unchanged rebuild does not touch the file (a watcher is not woken for nothing).
        const longAgo = new Date(0);
        fs.utimesSync(out, longAgo, longAgo);
        await build(dir, 'export const answer = 41;');
        expect(fs.statSync(out).mtimeMs).toBe(0);

        // A changed one is written into the same file: a link to it, or a watcher of it, keeps it.
        await build(dir, 'export const answer = 42;');
        expect(fs.readFileSync(out, 'utf8')).toMatch(/answer = 42/);
        expect(fs.statSync(out).ino).toBe(ino);
        expect(fs.readdirSync(dir)).toEqual(['stdin.js']);
    }, 60_000);

    it('fails a bundle with a standard decorator, written or in memory, and writes nothing', async () => {
        const dir = freshDir();
        const decorated = 'const mark = (..._: unknown[]): any => undefined;\n@mark class Marked {}\nexport { Marked };';
        const standard = { compilerOptions: { experimentalDecorators: false } };
        for (const inMemory of [false, true]) {
            await expect(build(dir, decorated, { tsconfigRaw: standard, inMemory })).rejects.toMatchObject({
                errors: [expect.objectContaining({ text: expect.stringContaining('was compiled with standard decorators') })]
            });
        }
        expect(fs.readdirSync(dir)).toEqual([]);
    }, 60_000);

    it("writes nothing when the build's own onEnd fails it", async () => {
        const dir = freshDir();
        const budget: esbuild.Plugin = {
            name: 'budget',
            setup(b) {
                b.onEnd(() => ({ errors: [{ text: 'over budget' }] }));
            }
        };
        await expect(build(dir, 'export const answer = 41;', { plugins: [budget] })).rejects.toMatchObject({
            errors: [expect.objectContaining({ text: 'over budget' })]
        });
        expect(fs.readdirSync(dir)).toEqual([]);
    }, 60_000);

    it('refuses a `write` of its own rather than ignore it', () => {
        expect(() => dialogramBuild({ write: true }, { packagesDir: PACKAGES })).toThrow(/leave `write` out/);
    });

    it('builds a platform package from its sources, and refuses one the checkout lacks', async () => {
        const dir = freshDir();
        await expect(build(dir, "import '@dialogram/nonesuch/thing';", { inMemory: true })).rejects.toMatchObject({
            errors: [expect.objectContaining({ text: expect.stringContaining("'@dialogram/nonesuch/thing' is none of the platform's packages") })]
        });
        const known = await build(dir, "export * from '@dialogram/shared';", { inMemory: true });
        expect(known.errors).toEqual([]);
        expect(Object.keys(known.metafile!.inputs).some(input => input.includes('shared/src/'))).toBe(true);
        // In memory: nothing on disk.
        expect(fs.readdirSync(dir)).toEqual([]);
    }, 60_000);

    it('maps packages by their names: the extension, published as `dialogram`, is none', async () => {
        const alias = dialogramBuild({}, { packagesDir: PACKAGES }).alias;
        expect(Object.keys(alias)).toContain('@dialogram/extension-core');
        expect(Object.keys(alias)).not.toContain('@dialogram/extension');
    });

    it('leaves a @dialogram path the build marks external alone', async () => {
        const dir = freshDir();
        const built = await build(dir, "export * from '@dialogram/runtime-api';", { external: ['@dialogram/runtime-*'], inMemory: true });
        expect(built.errors).toEqual([]);
        expect(built.outputFiles![0].text).toContain('@dialogram/runtime-api');
    }, 60_000);

    it('lets a plugin of the build serve a @dialogram path of its own', async () => {
        const dir = freshDir();
        const virtual: esbuild.Plugin = {
            name: 'virtual',
            setup(b) {
                b.onResolve({ filter: /^@dialogram\/generated$/ }, args => ({ path: args.path, namespace: 'virtual' }));
                b.onLoad({ filter: /.*/, namespace: 'virtual' }, () => ({ contents: 'export const made = "here";', loader: 'ts' }));
            }
        };
        const built = await build(dir, "export { made } from '@dialogram/generated';", { plugins: [virtual], inMemory: true });
        expect(built.errors).toEqual([]);
        expect(built.outputFiles![0].text).toContain('"here"');
    }, 60_000);
});
