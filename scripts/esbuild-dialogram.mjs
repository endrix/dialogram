/**
 * Bundling Dialogram's sources with esbuild: what the extension's build, the SVG renderer, the
 * test of README §3's recipe and a product's own build share, so none keeps a copy.
 *
 * Why an alias and not an `onResolve` plugin: esbuild applies a `tsconfig.json` only to a path its
 * own resolver found. A module a plugin resolved was compiled without its package's
 * `experimentalDecorators`, with standard decorators, and inversify's property `@inject` threw when
 * the bundle loaded ("Cannot read properties of undefined (reading 'prototype')"). It showed only
 * once a decorated module was first imported by package name, so a plugin could seem to work.
 *
 * A product imports this from its Dialogram checkout:
 *
 *     const { dialogramAlias, dialogramPackagesOnly, writeLegacyDecoratorBundles } =
 *         await import(pathToFileURL(path.join(dialogramRoot, 'scripts/esbuild-dialogram.mjs')).href);
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * esbuild's `alias` for `@dialogram/<pkg>[/<subpath>]`: each package under `packagesDir` that has a
 * `src` folder, to that folder. A subpath resolves as esbuild resolves any path: `x` to `x.ts` (or
 * `x/index.ts`), `x.css` as written.
 *
 * @param {string} packagesDir the checkout's `packages` folder
 * @returns {Record<string, string>}
 */
export function dialogramAlias(packagesDir) {
    return Object.fromEntries(
        fs.readdirSync(packagesDir)
            .filter(pkg => fs.existsSync(path.join(packagesDir, pkg, 'src')))
            .map(pkg => [`@dialogram/${pkg}`, path.join(packagesDir, pkg, 'src')])
    );
}

/**
 * An esbuild plugin that refuses a `@dialogram/<pkg>` with no sources under `packagesDir`. Unaliased,
 * esbuild would look for it in `node_modules`, which in a product links to whatever Dialogram
 * checkout it was installed from, not necessarily this one: two platform copies in one bundle. A
 * known package passes on to the alias (plugins see an import before the alias does).
 *
 * @param {string} packagesDir the checkout's `packages` folder
 * @returns {import('esbuild').Plugin}
 */
export function dialogramPackagesOnly(packagesDir) {
    const known = new Set(Object.keys(dialogramAlias(packagesDir)));
    return {
        name: 'dialogram-packages-only',
        setup(build) {
            build.onResolve({ filter: /^@dialogram\// }, args => {
                const pkg = args.path.split('/').slice(0, 2).join('/');
                if (known.has(pkg)) {
                    return undefined;
                }
                return { errors: [{ text: `${pkg} has no sources under ${packagesDir} (imported as '${args.path}').` }] };
            });
        }
    };
}

/** esbuild's helper for standard decorators, by its kind names, which survive `--minify`. */
export const STANDARD_DECORATOR_HELPER = /\[\s*"class",\s*"method",\s*"getter",\s*"setter",\s*"accessor",\s*"field"/;

/**
 * The modules of a bundle's text compiled with standard decorators: none, or each by the comment
 * that heads it. A minified bundle has no such comments; it gets one entry saying so.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function standardDecoratorsIn(text) {
    if (!STANDARD_DECORATOR_HELPER.test(text)) {
        return [];
    }
    // Unminified, each module is headed by a comment naming it, and each decorated class calls
    // `__decoratorStart(`.
    const found = new Set();
    let module = '';
    for (const line of text.split('\n')) {
        const origin = /^\s*\/\/ (.+\.[cm]?[jt]sx?)$/.exec(line);
        if (origin) {
            module = origin[1];
        } else if (line.includes('__decoratorStart(')) {
            found.add(module || '(a module before the first module comment)');
        }
    }
    return found.size > 0 ? [...found] : ['a module (build without minifying to see which)'];
}

/**
 * An esbuild plugin for a build with `write: false`: it writes the outputs when every JS output
 * keeps legacy decorators, and otherwise fails the build naming each module and writes nothing, so
 * the bundle on disk (and in a watch's dev host) stays the last good one. A build that failed on
 * its own has nothing to write and says why itself.
 *
 * @param {{ relativeTo?: string }} [options] the folder output paths are named from in a message
 * @returns {import('esbuild').Plugin}
 */
export function writeLegacyDecoratorBundles({ relativeTo = process.cwd() } = {}) {
    return {
        name: 'write-legacy-decorator-bundles',
        setup(build) {
            build.onEnd(async result => {
                if (result.errors.length > 0 || !result.outputFiles) {
                    return undefined;
                }
                const errors = result.outputFiles
                    .filter(file => /\.[cm]?js$/.test(file.path))
                    .flatMap(file => standardDecoratorsIn(file.text).map(module => ({
                        text: `${path.relative(relativeTo, file.path)} not written: ${module} was compiled with standard `
                            + `decorators, without its package's tsconfig (experimentalDecorators). Resolve it through `
                            + '`alias` (dialogramAlias), not an onResolve plugin.'
                    })));
                if (errors.length > 0) {
                    return { errors };
                }
                await Promise.all(result.outputFiles.map(file => writeIfChanged(file.path, file.contents)));
                return undefined;
            });
        }
    };
}

/**
 * Write `contents` to `file` unless it holds them already, as esbuild's own writer does, so a
 * watcher (a dev host, a webview) is not woken by a rebuild that changed nothing. A change is
 * written whole or not at all: to a file beside it, then renamed over it, so a reader never sees
 * half a bundle.
 *
 * @param {string} file
 * @param {Uint8Array} contents
 */
async function writeIfChanged(file, contents) {
    try {
        const stat = await fs.promises.stat(file);
        if (stat.size === contents.byteLength && Buffer.compare(await fs.promises.readFile(file), contents) === 0) {
            return;
        }
    } catch {
        // Not written yet.
    }
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const partial = `${file}.${process.pid}.partial`;
    await fs.promises.writeFile(partial, contents);
    await fs.promises.rename(partial, file);
}
