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
            let name;
            try {
                name = JSON.parse(fs.readFileSync(manifest, 'utf8')).name;
            } catch (err) {
                throw new Error(`${manifest} is not readable JSON: ${err instanceof Error ? err.message : err}`);
            }
            return typeof name === 'string' && name.startsWith('@dialogram/') ? [[name, src]] : [];
        })
    );
}

/**
 * esbuild options for a build of Dialogram's sources, the way the platform builds them:
 *
 * - `alias` maps `@dialogram/<pkg>` to the checkout's sources (the build's own entries win);
 * - an import of a `@dialogram/` path the alias lacks, and the build does not mark `external`, is
 *   refused, after the build's own plugins (one may serve such a path itself);
 * - a bundle with a module compiled with standard decorators fails the build
 *   ({@link legacyDecoratorsOnly}, first, so the build's own `onEnd` sees the failure);
 * - the bundle is written last ({@link writeBundles}), and only when no `onEnd` failed the build:
 *   a failed build leaves the last good bundle on disk. `onWritten` runs after the write, so a
 *   "build succeeded" line said there is never ahead of the files.
 *
 * `inMemory` leaves the outputs in the result's `outputFiles` (a test reads them), checked all the
 * same (`onWritten` then runs once they pass). The build writes the bundle itself: `options.write`
 * is refused, rather than ignored. A build with `packages: 'external'` keeps every package it does
 * not alias external, as asked: nothing is refused.
 *
 * @param {import('esbuild').BuildOptions} options
 * @param {{ packagesDir: string, relativeTo?: string, inMemory?: boolean, onWritten?: (result: import('esbuild').BuildResult) => void }} platform
 * @returns {import('esbuild').BuildOptions & { write: false, alias: Record<string, string>, plugins: import('esbuild').Plugin[] }}
 */
export function dialogramBuild(options, { packagesDir, relativeTo, inMemory = false, onWritten }) {
    if (options.write !== undefined) {
        throw new Error('dialogramBuild writes the bundle itself: leave `write` out, or pass `inMemory: true` to keep it in memory.');
    }
    const alias = { ...dialogramAlias(packagesDir), ...(options.alias ?? {}) };
    return {
        ...options,
        alias,
        write: false,
        plugins: [
            legacyDecoratorsOnly({ relativeTo }),
            ...(options.plugins ?? []),
            ...(options.packages === 'external' ? [] : [dialogramPackagesOnly(alias, { external: options.external })]),
            writeBundles({ write: !inMemory, onWritten })
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
 * An esbuild plugin that fails a build whose code output has a module compiled with standard
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
                // Every output but a stylesheet or a source map: a build with no `outdir` names
                // its one output `<stdout>`.
                const errors = (result.outputFiles ?? [])
                    .filter(file => !/\.(css|map)$/.test(file.path))
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
 * An esbuild plugin for a build with `write: false`, last among its plugins: when no `onEnd` before
 * it failed the build, it writes the outputs that changed (unless `write` is false), then calls
 * `onWritten`. What it last wrote is kept, so a watch's rebuild compares with that rather than
 * read every bundle back from disk.
 *
 * @param {{ write?: boolean, onWritten?: (result: import('esbuild').BuildResult) => void }} [options]
 * @returns {import('esbuild').Plugin}
 */
export function writeBundles({ write = true, onWritten } = {}) {
    /** @type {Map<string, Uint8Array>} */
    const lastWritten = new Map();
    return {
        name: 'write-bundles',
        setup(build) {
            build.onEnd(async result => {
                if (result.errors.length > 0) {
                    return undefined;
                }
                if (write && result.outputFiles) {
                    await Promise.all(result.outputFiles.map(file => writeIfChanged(file.path, file.contents, lastWritten)));
                }
                onWritten?.(result);
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
 * The file's last contents are taken from `lastWritten` when this writer wrote it, and read from
 * disk otherwise; either way a file gone or of another size since is written again.
 *
 * @param {string} file
 * @param {Uint8Array} contents
 * @param {Map<string, Uint8Array>} lastWritten
 */
async function writeIfChanged(file, contents, lastWritten) {
    try {
        const stat = await fs.promises.stat(file);
        if (stat.size === contents.byteLength) {
            const last = lastWritten.get(file) ?? await fs.promises.readFile(file);
            if (Buffer.compare(last, contents) === 0) {
                lastWritten.set(file, contents);
                return;
            }
        }
    } catch (err) {
        // Not written yet; anything else is the write's to report.
        if (err?.code !== 'ENOENT') {
            throw err;
        }
    }
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, contents);
    lastWritten.set(file, contents);
}
