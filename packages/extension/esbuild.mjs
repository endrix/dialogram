//@ts-check
import * as esbuild from 'esbuild';
import * as path from 'node:path';
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
