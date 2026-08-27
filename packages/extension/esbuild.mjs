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

// Plugin to resolve @dialogram/* imports (including subpaths such as
// @dialogram/extension-core/api) to source .ts files
const resolveWorkspacePlugin = {
    name: 'resolve-workspace-packages',
    setup(build) {
        build.onResolve({ filter: /^@dialogram\// }, args => {
            const [pkg, ...rest] = args.path.replace('@dialogram/', '').split('/');
            const srcDir = srcDirs[pkg];
            if (!srcDir) {
                return undefined;
            }
            const entry = rest.length === 0 ? 'index' : rest.join('/');
            return { path: path.join(srcDir, `${entry}.ts`) };
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
    plugins: [resolveWorkspacePlugin, ...plugins]
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
    plugins: [resolveWorkspacePlugin, ...plugins]
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
    plugins: [resolveWorkspacePlugin, ...plugins],
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
    await Promise.all(contexts.map(ctx => ctx.rebuild()));
    contexts.forEach(ctx => ctx.dispose());
}
