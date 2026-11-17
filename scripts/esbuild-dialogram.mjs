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
 * esbuild's `alias` for `@dialogram/<pkg>[/<subpath>]`: each package under `packagesDir` named
 * `@dialogram/<pkg>` in its `package.json` and with a `src` folder, to that folder. By the package's
 * name, not its folder's: the extension's folder is `packages/extension`, but no package is called
 * `@dialogram/extension`. A subpath resolves as esbuild resolves any path: `x` to `x.ts` (or
 * `x/index.ts`), `x.css` as written.
 *
 * @param {string} packagesDir the checkout's `packages` folder
 * @returns {Record<string, string>}
 */
export function dialogramAlias(packagesDir) {
    return Object.fromEntries(
        fs.readdirSync(packagesDir).flatMap(folder => {
            const src = path.join(packagesDir, folder, 'src');
            const manifest = path.join(packagesDir, folder, 'package.json');
            if (!fs.existsSync(src) || !fs.existsSync(manifest)) {
                return [];
            }
            const name = JSON.parse(fs.readFileSync(manifest, 'utf8')).name;
            return typeof name === 'string' && name.startsWith('@dialogram/') ? [[name, src]] : [];
        })
    );
}

/** {@link dialogramAlias} once per checkout: a build of several bundles reads the folder once. */
const aliasByPackagesDir = new Map();

/**
 * esbuild options for a build of Dialogram's sources, the way the platform builds them:
 *
 * - `alias` maps `@dialogram/<pkg>` to the checkout's sources (the build's own entries win);
 * - an import of a `@dialogram/` path the alias lacks, and the build does not mark `external`, is
 *   refused, after the build's own plugins (one may serve such a path itself);
 * - a bundle with a module compiled with standard decorators fails the build
 *   ({@link legacyDecoratorsOnly}, first, so the build's own `onEnd` sees the failure);
 * - the bundle is written last ({@link writeBundles}), and only when no `onEnd` failed the build:
 *   a failed build leaves the last good bundle on disk.
 *
 * `inMemory` leaves the outputs in the result's `outputFiles` (a test reads them), checked all the
 * same. The build writes the bundle itself: `options.write` is refused, rather than ignored.
 *
 * @param {import('esbuild').BuildOptions} options
 * @param {{ packagesDir: string, relativeTo?: string, inMemory?: boolean }} platform
 * @returns {import('esbuild').BuildOptions & { write: false, alias: Record<string, string>, plugins: import('esbuild').Plugin[] }}
 */
export function dialogramBuild(options, { packagesDir, relativeTo, inMemory = false }) {
    if (options.write !== undefined) {
        throw new Error('dialogramBuild writes the bundle itself: leave `write` out, or pass `inMemory: true` to keep it in memory.');
    }
    if (!aliasByPackagesDir.has(packagesDir)) {
        aliasByPackagesDir.set(packagesDir, dialogramAlias(packagesDir));
    }
    const alias = { ...aliasByPackagesDir.get(packagesDir), ...(options.alias ?? {}) };
    return {
        ...options,
        alias,
        write: false,
        plugins: [
            legacyDecoratorsOnly({ relativeTo }),
            ...(options.plugins ?? []),
            dialogramPackagesOnly(alias, { external: options.external }),
            ...(inMemory ? [] : [writeBundles()])
        ]
    };
}

/**
 * An esbuild plugin that refuses an import of a `@dialogram/` path `alias` does not map. Unaliased,
 * esbuild would look for it in `node_modules`, which in a product links to whatever Dialogram
 * checkout it was installed from, not necessarily this one: two platform copies in one bundle. A
 * mapped path passes on to the alias (plugins see an import before the alias does), and a path the
 * build marks `external` stays external (plugins see it before esbuild checks `external`).
 *
 * @param {Record<string, string>} alias the build's alias
 * @param {{ external?: string[] }} [options] the build's `external`
 * @returns {import('esbuild').Plugin}
 */
export function dialogramPackagesOnly(alias, { external = [] } = {}) {
    const known = Object.keys(alias).filter(key => key.startsWith('@dialogram/'));
    // As esbuild reads `external`: a name covers its subpaths, and `*` matches anything.
    const externals = external.map(pattern => new RegExp(
        `^${pattern.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}(/.*)?$`
    ));
    return {
        name: 'dialogram-packages-only',
        setup(build) {
            build.onResolve({ filter: /^@dialogram\// }, args => {
                if (known.some(key => args.path === key || args.path.startsWith(`${key}/`))) {
                    return undefined;
                }
                if (externals.some(pattern => pattern.test(args.path))) {
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
 * An esbuild plugin that fails a build whose JS output has a module compiled with standard
 * decorators, naming each. It writes nothing: in {@link dialogramBuild} the bundle is written last,
 * so a failed build leaves the last good one on disk (and in a watch's dev host).
 *
 * @param {{ relativeTo?: string }} [options] the folder output paths are named from in a message
 * @returns {import('esbuild').Plugin}
 */
export function legacyDecoratorsOnly({ relativeTo = process.cwd() } = {}) {
    return {
        name: 'legacy-decorators-only',
        setup(build) {
            build.onEnd(result => {
                const errors = (result.outputFiles ?? [])
                    .filter(file => /\.[cm]?js$/.test(file.path))
                    .flatMap(file => standardDecoratorsIn(file.text).map(module => ({
                        text: `${path.relative(relativeTo, file.path)} not written: ${module} was compiled with standard `
                            + `decorators, without its package's tsconfig (experimentalDecorators). Resolve it through `
                            + '`alias` (dialogramAlias), not an onResolve plugin.'
                    })));
                return errors.length > 0 ? { errors } : undefined;
            });
        }
    };
}

/**
 * An esbuild plugin for a build with `write: false`, last among its plugins: it writes the outputs
 * when no `onEnd` before it failed the build, and only those that changed.
 *
 * @returns {import('esbuild').Plugin}
 */
export function writeBundles() {
    return {
        name: 'write-bundles',
        setup(build) {
            build.onEnd(async result => {
                if (result.errors.length > 0 || !result.outputFiles) {
                    return undefined;
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
 * as esbuild writes too, so no more torn than its own writes: a linked output stays linked, a
 * watcher of the file keeps its file, and a file a reader holds open (Windows) is not swapped from
 * under it.
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
    } catch (err) {
        // Not written yet; anything else is the write's to report.
        if (err?.code !== 'ENOENT') {
            throw err;
        }
    }
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, contents);
}
