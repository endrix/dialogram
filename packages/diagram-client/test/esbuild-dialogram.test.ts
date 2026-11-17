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

/** An entry module's text built into `outdir` the way the platform builds. */
function options(
    outdir: string,
    contents: string,
    { plugins = [], tsconfigRaw, inMemory = false, external, packages, onWritten }: {
        plugins?: esbuild.Plugin[]; tsconfigRaw?: esbuild.TsconfigRaw; inMemory?: boolean; external?: string[];
        packages?: 'external'; onWritten?: (result: esbuild.BuildResult) => void;
    } = {}
) {
    return dialogramBuild({
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
        ...(external ? { external } : {}),
        ...(packages ? { packages } : {})
    }, { packagesDir: PACKAGES, relativeTo: outdir, inMemory, onWritten });
}

/** Build it once. */
const build = Object.assign(
    (...args: Parameters<typeof options>) => esbuild.build(options(...args)),
    { options }
);

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

    it('says a build succeeded once its bundle is on disk, and writes again what went missing', async () => {
        const dir = freshDir();
        const out = path.join(dir, 'stdin.js');
        const seen: string[] = [];
        const ctx = await esbuild.context(build.options(dir, 'export const answer = 41;', {
            onWritten: () => seen.push(fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : 'missing')
        }));
        try {
            await ctx.rebuild();
            expect(seen).toHaveLength(1);
            expect(seen[0]).toMatch(/answer = 41/);
            // The writer compares with what it last wrote; a file deleted since is written again,
            // and so is one another build wrote over with the same size.
            fs.rmSync(out);
            await ctx.rebuild();
            expect(seen[1]).toMatch(/answer = 41/);
            const original = fs.readFileSync(out, 'utf8');
            fs.writeFileSync(out, original.replace('answer = 41', 'answer = 99'));
            fs.utimesSync(out, new Date(0), new Date(0));
            await ctx.rebuild();
            expect(seen[2]).toBe(original);
        } finally {
            await ctx.dispose();
        }
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
        // A build with no outdir, whose one output is `<stdout>`, is checked too.
        const unnamed = esbuild.build(dialogramBuild({
            stdin: { contents: decorated, loader: 'ts', resolveDir: __dirname },
            bundle: true,
            target: 'ES2017',
            logLevel: 'silent',
            tsconfigRaw: standard
        }, { packagesDir: PACKAGES, inMemory: true }));
        await expect(unnamed).rejects.toMatchObject({
            errors: [expect.objectContaining({ text: expect.stringMatching(/^The bundle: .* was compiled with standard decorators/) })]
        });
    }, 60_000);

    it("checks again what the build's own onEnd changed, before writing it", async () => {
        const dir = freshDir();
        const decorated = 'const mark = (..._: unknown[]): any => undefined;\n@mark class Marked {}\nexport { Marked };';
        const standard = await esbuild.build({
            stdin: { contents: decorated, loader: 'ts' }, bundle: true, write: false, target: 'ES2017', logLevel: 'silent',
            tsconfigRaw: { compilerOptions: { experimentalDecorators: false } }
        });
        // A post-processor that swaps the bundle for one with a standard decorator.
        const swap: esbuild.Plugin = {
            name: 'swap',
            setup(b) {
                b.onEnd(result => {
                    const file = result.outputFiles![0];
                    result.outputFiles![0] = { ...file, path: file.path, contents: standard.outputFiles[0].contents, text: standard.outputFiles[0].text };
                });
            }
        };
        await expect(build(dir, 'export const answer = 41;', { plugins: [swap] })).rejects.toMatchObject({
            errors: [expect.objectContaining({ text: expect.stringContaining('stdin.js not written') })]
        });
        expect(fs.readdirSync(dir)).toEqual([]);
    }, 60_000);

    it('warns, rather than fails, when onWritten throws after the write', async () => {
        const dir = freshDir();
        const built = await build(dir, 'export const answer = 41;', { onWritten: () => { throw new Error('no dev host'); } });
        expect(built.errors).toEqual([]);
        expect(built.warnings.map(warning => warning.text)).toEqual([expect.stringContaining('no dev host')]);
        expect(fs.readdirSync(dir)).toEqual(['stdin.js']);
    }, 60_000);

    it("writes nothing when the build's own onEnd fails it", async () => {
        const dir = freshDir();
        const budget: esbuild.Plugin = {
            name: 'budget',
            setup(b) {
                b.onEnd(() => ({ errors: [{ text: 'over budget' }] }));
            }
        };
        const said: unknown[] = [];
        await expect(build(dir, 'export const answer = 41;', { plugins: [budget], onWritten: result => said.push(result) })).rejects.toMatchObject({
            errors: [expect.objectContaining({ text: 'over budget' })]
        });
        expect(fs.readdirSync(dir)).toEqual([]);
        expect(said).toEqual([]);
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
        // As does a build that keeps every package it does not alias external.
        const kept = await build(dir, "export * from '@dialogram/runtime-api';", { packages: 'external', inMemory: true });
        expect(kept.outputFiles![0].text).toContain('@dialogram/runtime-api');
        // And one a plugin of the build marks external as it starts.
        const marks: esbuild.Plugin = {
            name: 'marks',
            setup(b) {
                b.initialOptions.external = [...(b.initialOptions.external ?? []), '@dialogram/runtime-*'];
            }
        };
        const marked = await build(dir, "export * from '@dialogram/runtime-api';", { plugins: [marks], inMemory: true });
        expect(marked.outputFiles![0].text).toContain('@dialogram/runtime-api');
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
