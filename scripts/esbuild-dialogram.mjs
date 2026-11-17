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
                // One package's manifest half-saved fails no build that does not import it.
                console.warn(`[dialogram build] ${manifest} is not readable JSON, so its package is not aliased: `
                    + `${err instanceof Error ? err.message : err}`);
                return [];
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
 * is refused, rather than ignored. A build with no `outdir` or `outfile` writes its one output to
 * standard output, as esbuild would.
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
            legacyDecoratorsOnly({ relativeTo, written: !inMemory }),
            ...(options.plugins ?? []),
            dialogramPackagesOnly(alias),
            writeBundles({ write: !inMemory, relativeTo, onWritten })
        ]
    };
}

/**
 * An esbuild plugin that refuses an import of a `@dialogram/` path `alias` does not map. Unaliased,
 * esbuild would look for it in `node_modules`, which in a product links to whatever Dialogram
 * checkout it was installed from, not necessarily this one: two platform copies in one bundle. A
 * mapped path passes on to the alias (plugins see an import before the alias does). A path the
 * build marks `external`, or every package under `packages: 'external'`, stays external (plugins
 * see it before esbuild checks): both are read from the build's options as it starts, so what an
 * earlier plugin's `setup` added counts too.
 *
 * @param {Record<string, string>} alias the build's alias
 * @returns {import('esbuild').Plugin}
 */
export function dialogramPackagesOnly(alias) {
    const known = Object.keys(alias).filter(key => key.startsWith('@dialogram/'));
    return {
        name: 'dialogram-packages-only',
        setup(build) {
            if (build.initialOptions.packages === 'external') {
                return;
            }
            // As esbuild reads `external`: a name covers its subpaths, and `*` matches anything.
            const externals = (build.initialOptions.external ?? []).map(pattern => new RegExp(
                `^${pattern.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}(/.*)?$`
            ));
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

/** Whether an output is code: a script by its name, or the one output of a build with no `outdir`. */
const isCode = file => /\.[cm]?js$/.test(file.path) || file.path === '<stdout>';

/**
 * The errors for the code outputs with a module compiled with standard decorators.
 *
 * @param {import('esbuild').OutputFile[]} outputFiles
 * @param {{ relativeTo: string, written: boolean }} how
 */
function standardDecoratorErrors(outputFiles, { relativeTo, written }) {
    return outputFiles.filter(isCode).flatMap(file => standardDecoratorsIn(file.text).map(module => ({
        text: `${file.path === '<stdout>' ? 'The bundle' : path.relative(relativeTo, file.path)}${written ? ' not written' : ''}: `
            + `${module} was compiled with standard decorators, without its package's tsconfig `
            + '(experimentalDecorators). Resolve it through `alias` (dialogramAlias), not an onResolve plugin.'
    })));
}

/**
 * An esbuild plugin that fails a build whose code output has a module compiled with standard
 * decorators, naming each. It writes nothing: in {@link dialogramBuild} the bundle is written last
 * (and checked again then, should a plugin's `onEnd` have changed it), so a failed build leaves the
 * last good one on disk (and in a watch's dev host).
 *
 * @param {{ relativeTo?: string, written?: boolean }} [options] the folder output paths are named
 *   from in a message, and whether the build would have written them
 * @returns {import('esbuild').Plugin}
 */
export function legacyDecoratorsOnly({ relativeTo = process.cwd(), written = true } = {}) {
    return {
        name: 'legacy-decorators-only',
        setup(build) {
            build.onEnd(result => {
                const errors = standardDecoratorErrors(result.outputFiles ?? [], { relativeTo, written });
                return errors.length > 0 ? { errors } : undefined;
            });
        }
    };
}

/**
 * An esbuild plugin for a build with `write: false`, last among its plugins: when no `onEnd` before
 * it failed the build, it writes the outputs that changed (unless `write` is false), then calls
 * `onWritten`. An output a plugin's `onEnd` changed after the first check is checked again first.
 * The one output of a build with no `outdir` goes to standard output.
 *
 * `onWritten` runs once the files are on disk; if it fails, that is a warning, not a failed build,
 * since the bundle was written.
 *
 * @param {{ write?: boolean, relativeTo?: string, onWritten?: (result: import('esbuild').BuildResult) => void | Promise<void> }} [options]
 * @returns {import('esbuild').Plugin}
 */
export function writeBundles({ write = true, relativeTo = process.cwd(), onWritten } = {}) {
    /** What this writer last wrote to each file. @type {Map<string, WrittenFile>} */
    const lastWritten = new Map();
    return {
        name: 'write-bundles',
        setup(build) {
            build.onEnd(async result => {
                if (result.errors.length > 0) {
                    return undefined;
                }
                const outputs = result.outputFiles ?? [];
                const errors = standardDecoratorErrors(outputs, { relativeTo, written: write });
                if (errors.length > 0) {
                    return { errors };
                }
                if (write) {
                    await Promise.all(outputs.map(file => file.path === '<stdout>'
                        ? new Promise(resolve => process.stdout.write(file.contents, () => resolve(undefined)))
                        : writeIfChanged(file, lastWritten)));
                }
                try {
                    await onWritten?.(result);
                } catch (err) {
                    return { warnings: [{ text: `onWritten failed after the bundle was written: ${err instanceof Error ? err.message : err}` }] };
                }
                return undefined;
            });
        }
    };
}

/**
 * @typedef {{ hash: string | undefined, size: number, mtimeMs: number }} WrittenFile
 */

/**
 * Write an output unless its file holds it already, as esbuild's own writer does, so a watcher (a
 * dev host, a webview) is not woken by a rebuild that changed nothing. Written in place, as esbuild
 * writes too, so no more torn than its own writes: a linked output stays linked, a watcher of the
 * file keeps its file, and a file a reader holds open (Windows) is not swapped from under it.
 *
 * A file this writer wrote, untouched since (same size and time on disk), is compared by esbuild's
 * hash of the output, without reading it back or keeping its bytes. Any other file (not written by
 * this watch, or written over by another build since) is read and compared.
 *
 * @param {import('esbuild').OutputFile} output
 * @param {Map<string, WrittenFile>} lastWritten
 */
async function writeIfChanged(output, lastWritten) {
    const file = output.path;
    const contents = output.contents;
    try {
        const stat = await fs.promises.stat(file);
        if (stat.size === contents.byteLength) {
            const last = lastWritten.get(file);
            const untouched = last !== undefined && last.size === stat.size && last.mtimeMs === stat.mtimeMs;
            const same = untouched && last.hash !== undefined && output.hash !== undefined
                ? last.hash === output.hash
                : Buffer.compare(await fs.promises.readFile(file), contents) === 0;
            if (same) {
                lastWritten.set(file, { hash: output.hash, size: stat.size, mtimeMs: stat.mtimeMs });
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
    const stat = await fs.promises.stat(file);
    lastWritten.set(file, { hash: output.hash, size: stat.size, mtimeMs: stat.mtimeMs });
}

/**
 * How a one-shot build that ran several bundles ends: each rejected one sets the exit code, and is
 * printed unless esbuild printed its errors itself (a failure with none, an exception, a cancel).
 *
 * @param {PromiseSettledResult<unknown>[]} results the bundles' `Promise.allSettled` results
 * @returns {boolean} whether every bundle built
 */
export function reportBuilds(results) {
    let ok = true;
    for (const result of results) {
        if (result.status === 'rejected') {
            ok = false;
            process.exitCode = 1;
            if (!(Array.isArray(result.reason?.errors) && result.reason.errors.length > 0)) {
                console.error(result.reason ?? 'The build failed.');
            }
        }
    }
    return ok;
}
