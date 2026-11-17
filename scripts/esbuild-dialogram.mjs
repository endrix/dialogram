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
 * A product imports this from its Dialogram checkout and wraps each build's options:
 *
 *     const { dialogramBuild } =
 *         await import(pathToFileURL(path.join(dialogramRoot, 'scripts/esbuild-dialogram.mjs')).href);
 *     await esbuild.build(dialogramBuild(options, { packagesDir: path.join(dialogramRoot, 'packages') }));
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
 * esbuild options for a build of Dialogram's sources, the way the platform builds them:
 *
 * - `alias` maps `@dialogram/<pkg>` to the checkout's sources (the build's own entries win);
 * - an import of a `@dialogram/` path the alias lacks is refused, after the build's own plugins
 *   (one may serve such a path itself);
 * - unless `inMemory`, the bundle is written by {@link writeLegacyDecoratorBundles}, first among the
 *   plugins, so a later `onEnd` (a "build succeeded" line) sees its refusal.
 *
 * `inMemory` leaves the outputs in the result's `outputFiles` (a test reads them).
 *
 * @param {import('esbuild').BuildOptions} options
 * @param {{ packagesDir: string, relativeTo?: string, inMemory?: boolean }} platform
 * @returns {import('esbuild').BuildOptions}
 */
export function dialogramBuild(options, { packagesDir, relativeTo, inMemory = false }) {
    const alias = { ...dialogramAlias(packagesDir), ...(options.alias ?? {}) };
    return {
        ...options,
        alias,
        write: false,
        plugins: [
            ...(inMemory ? [] : [writeLegacyDecoratorBundles({ relativeTo })]),
            ...(options.plugins ?? []),
            dialogramPackagesOnly(alias)
        ]
    };
}

/**
 * An esbuild plugin that refuses an import of a `@dialogram/` path `alias` does not map. Unaliased,
 * esbuild would look for it in `node_modules`, which in a product links to whatever Dialogram
 * checkout it was installed from, not necessarily this one: two platform copies in one bundle. A
 * mapped path passes on to the alias (plugins see an import before the alias does).
 *
 * @param {Record<string, string>} alias the build's alias
 * @returns {import('esbuild').Plugin}
 */
export function dialogramPackagesOnly(alias) {
    const known = Object.keys(alias).filter(key => key.startsWith('@dialogram/'));
    return {
        name: 'dialogram-packages-only',
        setup(build) {
            build.onResolve({ filter: /^@dialogram\// }, args => {
                if (known.some(key => args.path === key || args.path.startsWith(`${key}/`))) {
                    return undefined;
                }
                return {
                    errors: [{
                        text: `'${args.path}' is none of the platform's packages (${known.join(', ')}): `
                            + 'not taken from node_modules, which may be another Dialogram checkout.'
                    }]
                };
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
 * watcher (a dev host, a webview) is not woken by a rebuild that changed nothing. Written in place,
 * as esbuild writes too: a linked output stays linked, a watcher of the file keeps its file, and a
 * file a reader holds open (Windows) is not swapped from under it.
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
    await fs.promises.writeFile(file, contents);
}
