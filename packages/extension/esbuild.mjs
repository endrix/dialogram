//@ts-check
import * as esbuild from 'esbuild';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');
const minify = process.argv.includes('--minify');

// Build stamp: every bundle logs its build identity on load so a running
// Extension Development Host (and its webviews) can always be checked
// against the working tree. Guards against stale-bundle confusion.
import { execSync } from 'node:child_process';
const gitSha = (() => {
    try {
        return execSync('git rev-parse --short HEAD', { cwd: path.resolve('../..') }).toString().trim();
    } catch {
        return 'unknown';
    }
})();
const buildStamp = `${new Date().toISOString()} ${gitSha}`;
const stampBanner = (name) => ({ js: `console.log("[dialogram build] ${name} ${buildStamp}");` });


const success = watch ? 'Watch build succeeded' : 'Build succeeded';

function getTime() {
    const date = new Date();
    return `[${`${padZeroes(date.getHours())}:${padZeroes(date.getMinutes())}:${padZeroes(date.getSeconds())}`}] `;
}

function padZeroes(i) {
    return i.toString().padStart(2, '0');
}

const plugins = [{
    name: 'watch-plugin',
    setup(build) {
        build.onEnd(result => {
            if (result.errors.length === 0) {
                console.log(getTime() + success);
            }
        });
    },
}];

// Resolve workspace package source directories for esbuild
const srcDirs = {
    'shared': path.resolve(__dirname, '../shared/src'),
    'diagram-server': path.resolve(__dirname, '../diagram-server/src'),
    'diagram-client': path.resolve(__dirname, '../diagram-client/src'),
    'extension-core': path.resolve(__dirname, '../extension-core/src'),
    'sidecar-toolkit': path.resolve(__dirname, '../sidecar-toolkit/src'),
};

// @dialogram/* imports (subpaths too, such as @dialogram/extension-core/api) resolve to the
// packages' source .ts files. An alias, not an onResolve plugin: esbuild applies a tsconfig.json
// only to a path its own resolver found, so a file a plugin resolved was compiled without its
// package's `experimentalDecorators`, with standard decorators, and inversify's property
// `@inject` threw at load ("Cannot read properties of undefined (reading 'prototype')"): the
// platform bundle would not activate once a file with one was first imported by package name.
const workspaceAlias = Object.fromEntries(Object.entries(srcDirs).map(([pkg, dir]) => [`@dialogram/${pkg}`, dir]));

// Every bundle's decorators are the legacy ones the packages' tsconfigs ask for. A standard one
// means a module was compiled without its tsconfig, and inversify's property `@inject` throws
// at load. Such a bundle fails the build, naming the module, and is not written: the contexts
// build in memory (`write: false`) and this writes their outputs only when they pass, so the
// bundle on disk (and in a watch's dev host) stays the last good one.
const STANDARD_DECORATOR_HELPER = /\[\s*"class",\s*"method",\s*"getter",\s*"setter",\s*"accessor",\s*"field"/;
function standardDecoratorsIn(text) {
    // esbuild's helper for standard decorators; its kind names survive --minify.
    if (!STANDARD_DECORATOR_HELPER.test(text)) {
        return [];
    }
    // Unminified, each module is headed by a comment naming it, and each decorated class calls
    // `__decoratorStart(`. Minified, neither is left.
    const found = new Set();
    let module = '';
    for (const line of text.split('\n')) {
        const origin = /^\s*\/\/ (\S+\.[cm]?[jt]sx?)$/.exec(line);
        if (origin) {
            module = origin[1];
        } else if (line.includes('__decoratorStart(')) {
            found.add(module || '(a module before the first module comment)');
        }
    }
    return found.size > 0 ? [...found] : ['a module (build without --minify to see which)'];
}
const writeLegacyDecoratorBundles = {
    name: 'write-legacy-decorator-bundles',
    setup(build) {
        build.onEnd(result => {
            // A failed build has nothing to write, and says why itself.
            if (result.errors.length > 0 || !result.outputFiles) {
                return undefined;
            }
            const errors = result.outputFiles
                .filter(file => /\.[cm]?js$/.test(file.path))
                .flatMap(file => standardDecoratorsIn(file.text).map(module => ({
                    text: `${path.relative(__dirname, file.path)} not written: ${module} was compiled with standard `
                        + `decorators, without its package's tsconfig (experimentalDecorators). Resolve it through `
                        + `\`alias\`, not an onResolve plugin.`
                })));
            if (errors.length > 0) {
                return { errors };
            }
            for (const file of result.outputFiles) {
                fs.mkdirSync(path.dirname(file.path), { recursive: true });
                fs.writeFileSync(file.path, file.contents);
            }
            return undefined;
        });
    }
};

// Host entry: returns the DialogramApi from activate().
const hostCtx = await esbuild.context({
    banner: stampBanner('host main.cjs'),
    entryPoints: ['src/main.ts'],
    outdir: 'out',
    bundle: true,
    target: 'ES2019',
    format: 'cjs',
    outExtension: { '.js': '.cjs' },
    loader: { '.ts': 'ts' },
    external: ['vscode'],
    platform: 'node',
    sourcemap: !minify,
    minify,
    alias: workspaceAlias,
    write: false,
    plugins: [writeLegacyDecoratorBundles, ...plugins]
});

// libavoid (WASM), vendored at vendor/libavoid — see its README for why it is
// built from source rather than taken from npm (the published package generates
// its bindings with `new Function`, which the webview CSP forbids).
//
// Neither wrapper is bundled: emscripten reads `import.meta.url` to locate
// itself and esbuild rewrites `import.meta` to `{}` in CJS/IIFE output, so an
// inlined module aborts during init. Both are loaded at runtime from a file.
const libavoidVendor = path.resolve(__dirname, '../../vendor/libavoid');
if (fs.existsSync(libavoidVendor)) {
    // Server side: next to dist/platform.cjs, which is what __dirname resolves
    // to for the bundled GLSP server.
    const serverOut = path.resolve(__dirname, 'dist/libavoid');
    fs.mkdirSync(serverOut, { recursive: true });
    fs.copyFileSync(path.join(libavoidVendor, 'libavoid-node.mjs'), path.join(serverOut, 'libavoid-node.mjs'));
    fs.copyFileSync(path.join(libavoidVendor, 'libavoid.wasm'), path.join(serverOut, 'libavoid.wasm'));
    fs.copyFileSync(path.join(libavoidVendor, 'LICENSE'), path.join(serverOut, 'LICENSE'));

    // Webview side: served to the iframe over asWebviewUri.
    const webviewOut = path.resolve(__dirname, 'dist/webview');
    fs.mkdirSync(webviewOut, { recursive: true });
    fs.copyFileSync(path.join(libavoidVendor, 'libavoid-web.mjs'), path.join(webviewOut, 'libavoid.mjs'));
    fs.copyFileSync(path.join(libavoidVendor, 'libavoid.wasm'), path.join(webviewOut, 'libavoid.wasm'));
    fs.copyFileSync(path.join(libavoidVendor, 'LICENSE'), path.join(webviewOut, 'libavoid-LICENSE'));
} else {
    console.warn('[esbuild] vendor/libavoid missing; edge routing falls back to the built-in router');
}

// Platform bundle: the whole extension-core runtime (GLSP server + chat
// backend) PLUS the sidecar-toolkit's profile assembly, compiled into ONE realm
// (see src/platform-entry.ts — DI-decorated classes cannot cross bundles).
// Loaded by the host once per process. Profile isolation is provided by
// per-profile ChatProfileRuntime, ChatBackend, and GlspIntegrationHandle instances.
const platformCtx = await esbuild.context({
    banner: stampBanner('platform.cjs'),
    entryPoints: ['src/platform-entry.ts'],
    outfile: 'dist/platform.cjs',
    bundle: true,
    target: 'ES2019',
    format: 'cjs',
    loader: { '.ts': 'ts' },
    external: ['vscode'],
    platform: 'node',
    sourcemap: !minify,
    minify,
    alias: workspaceAlias,
    write: false,
    plugins: [writeLegacyDecoratorBundles, ...plugins]
});

// GLSP diagram client bundle (runs in consumer webviews, browser IIFE)
const glspClientCtx = await esbuild.context({
    // libavoid must NOT be inlined here. esbuild rewrites `import.meta` to `{}`
    // in an IIFE, and emscripten's browser build derives its script directory
    // from `import.meta.url` — undefined, so the module aborts at init and every
    // later error reads "program has already aborted!". It is loaded at runtime
    // as a real ES module instead; see libavoid-loader.ts.
    banner: stampBanner('webview diagram-client.js'),
    entryPoints: [path.join(srcDirs['diagram-client'], 'diagram-client.ts')],
    outdir: 'dist/webview',
    bundle: true,
    target: 'ES2017',
    format: 'iife',
    platform: 'browser',
    sourcemap: false,
    minify,
    alias: workspaceAlias,
    write: false,
    plugins: [writeLegacyDecoratorBundles, ...plugins],
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
        'global': 'window'
    }
});

const contexts = [hostCtx, platformCtx, glspClientCtx];
if (watch) {
    await Promise.all(contexts.map(ctx => ctx.watch()));
} else {
    try {
        await Promise.all(contexts.map(ctx => ctx.rebuild()));
    } catch {
        // esbuild has printed each error.
        process.exitCode = 1;
    } finally {
        contexts.forEach(ctx => ctx.dispose());
    }
}
