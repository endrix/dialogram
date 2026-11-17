/**
 * The stock start-up as a product's bundle uses it, built for real.
 *
 * esbuild writes CSS in the order it meets it, and `stock-starter.ts` brings
 * GLSP's own stylesheets through its JS imports. So an entry that imports the
 * stylesheets BEFORE the starter puts GLSP's sprotty and palette rules after
 * the stock ones, and GLSP wins the cascade. These builds pin the order for the
 * stock entry and for a product's entry written as README §4 says, and prove
 * the path import `@dialogram/diagram-client/stock-starter` resolves through
 * the alias README §3 describes.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { describe, expect, it } from 'vitest';
import { CUSTOM_DEMO_NODE_TYPE } from './fixtures/custom-view-consumer/custom-node';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const PACKAGES = path.resolve(REPO_ROOT, 'packages');

/** README §3's alias: `@dialogram/<pkg>[/<subpath>]` to the package sources. */
const dialogramAlias = Object.fromEntries(
    fs.readdirSync(PACKAGES)
        .filter(pkg => fs.existsSync(path.join(PACKAGES, pkg, 'src')))
        .map(pkg => [`@dialogram/${pkg}`, path.join(PACKAGES, pkg, 'src')])
);

/** esbuild's helper for standard decorators: its kind names, which survive minifying. */
const STANDARD_DECORATOR_HELPER = /\[\s*"class",\s*"method",\s*"getter",\s*"setter",\s*"accessor",\s*"field"/;

/** Bundle an entry file, or an entry module's own text (`{ contents }`). */
async function build(entry: string | { contents: string }): Promise<{ js: string; css: string }> {
    const result = await esbuild.build({
        ...(typeof entry === 'string'
            ? { entryPoints: [entry] }
            : { stdin: { contents: entry.contents, resolveDir: __dirname, loader: 'ts' as const, sourcefile: 'entry.ts' } }),
        absWorkingDir: REPO_ROOT,
        bundle: true,
        write: false,
        outdir: 'stock-starter-build-out',
        format: 'iife',
        platform: 'browser',
        target: 'ES2017',
        jsxFactory: 'svg',
        logLevel: 'silent',
        alias: dialogramAlias,
        loader: {
            '.css': 'css',
            '.ttf': 'dataurl',
            '.woff': 'dataurl',
            '.woff2': 'dataurl',
            '.eot': 'dataurl',
            '.svg': 'dataurl'
        },
        define: {
            'process.env.NODE_ENV': '"production"',
            global: 'window'
        }
    });
    expect(result.errors).toEqual([]);
    const js = result.outputFiles.find(f => f.path.endsWith('.js'))!.text;
    const css = result.outputFiles.find(f => f.path.endsWith('.css'))?.text ?? '';
    return { js, css };
}

/** Offset of a stylesheet's own block in the bundled CSS (esbuild heads each with its path). */
function at(css: string, file: string): number {
    const i = css.indexOf(`${file} */`);
    expect(i, `${file} is in the bundled stylesheet`).toBeGreaterThanOrEqual(0);
    return i;
}

describe('the stock start-up, bundled', () => {
    it('puts the stock rules after GLSP’s own in the stock bundle', async () => {
        const { css } = await build(path.resolve(PACKAGES, 'diagram-client/src/diagram-client.ts'));
        expect(at(css, 'css/glsp-sprotty.css')).toBeLessThan(at(css, 'src/diagram-client.css'));
        expect(at(css, 'css/tool-palette.css')).toBeLessThan(at(css, 'src/diagram-client.css'));
    }, 120_000);

    it('builds a product’s bundle through the path import, its rules after the stock ones', async () => {
        const { js, css } = await build(path.resolve(__dirname, 'fixtures/stock-starter-consumer/entry.ts'));
        expect(js).toContain(CUSTOM_DEMO_NODE_TYPE);
        expect(at(css, 'css/glsp-sprotty.css')).toBeLessThan(at(css, 'src/diagram-client.css'));
        expect(at(css, 'src/diagram-client.css')).toBeLessThan(at(css, 'stock-starter-consumer/consumer.css'));
    }, 120_000);

    // A module a plugin resolves gets no tsconfig, so it was compiled with standard decorators,
    // and inversify's property `@inject` threw at load; it showed only once a decorated module
    // was first imported by package name, as here. The alias keeps the package's tsconfig.
    it('keeps the legacy decorators of a module imported by package name', async () => {
        const { js } = await build({ contents: "export { ViewerMouseListener } from '@dialogram/diagram-client/viewer-mouse-listener';" });
        expect(js).toContain('ViewerMouseListener');
        expect(js).toContain('__decorateClass(');
        expect(js).not.toMatch(STANDARD_DECORATOR_HELPER);
    }, 120_000);
});
