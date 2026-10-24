/**
 * Render a graph document to SVG headlessly, through the real server layout
 * and the real client.
 *
 * For looking at what a change does to a diagram without opening VS Code, and
 * for comparing layouts side by side. Every stage is the production one:
 *
 *   graph document ──(GraphGModelSource + ELK, build-schema.ts)──> laid-out GModel
 *                  ──(headless Chrome + the diagram client)───────> rendered page
 *                  ──(svg-export.ts, as "Export as SVG")──────────> a standalone SVG
 *
 * The graph document is what a producer's plan command prints: `ndf diagram
 * <file> --format graph`, `hdl plan <file> --format graph`, `wfpy plan ...`.
 *
 * Usage:
 *   node scripts/render-svg/render.mjs <doc.json | -> [options]
 *
 * Options:
 *   --out <path.svg>        where to write (default: ./diagram.svg)
 *   --png                   also rasterise next to the SVG (Chrome screenshot)
 *   --layout <name>         default | untangled | free-ports (the editor's Layout menu)
 *   --elk <key=value>       an extra ELK graph option, repeatable
 *                           (e.g. --elk elk.direction=DOWN)
 *   --all-layouts           render every layout: <out>-default.svg, -untangled, -free-ports
 *   --families <path.json>  the product's node families (NodeFamilySpec[])
 *   --css <path.css>        a product stylesheet, served after the platform's, repeatable
 *   --behavior <json>       client behavior flags, as a profile's clientBehavior
 *   --theme <dark|light>    the editor colours the page is drawn in (default: dark)
 *   --states <path.json>    node states to draw (ExecutionNodeState[]), as a status
 *                           source publishes them: through the client's own painter.
 *                           A nodeId is the producer's id or the diagram's; ids the
 *                           view does not have are skipped; idle draws nothing
 *   --chrome <path>         Chrome/Chromium binary (default: $CHROME or google-chrome)
 *   --keep                  keep the intermediate schema, bundle and page
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const esbuild = createRequire(path.join(REPO, 'packages/extension/package.json'))('esbuild');
const LAYOUTS = ['default', 'untangled', 'free-ports'];
/** Canvas size for the headless page: larger than any diagram, so nothing is culled. */
const CANVAS_PX = 40000;

/** A JSON file's value, or an error that names the file. */
function readJson(file, what) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        throw new Error(`${what} ${file}: ${error.message}`);
    }
}

/** The states file: an array of `{ nodeId, status }`, or an error that says so. */
function readStates(file) {
    const states = readJson(file, '--states');
    if (!Array.isArray(states)) {
        throw new Error(`--states ${file}: expected an array of { nodeId, status }, got ${states === null ? 'null' : typeof states}`);
    }
    return states;
}

/**
 * JSON written into an inline `<script>`: a `<` in a string (a node id
 * holding `</script>`) would end the script early, so each one is escaped.
 */
function inlineJson(text) {
    return text.replace(/</g, '\\u003c');
}

function parseArgs(argv) {
    const positional = [];
    const repeated = { elk: [], css: [] };
    const single = {};
    const flags = new Set();
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg.startsWith('--') || arg === '-') {
            positional.push(arg);
            continue;
        }
        const name = arg.slice(2);
        if (['png', 'keep', 'all-layouts'].includes(name)) {
            flags.add(name);
        } else if (name in repeated) {
            repeated[name].push(argv[++i]);
        } else {
            single[name] = argv[++i];
        }
    }
    if (positional.length !== 1) {
        console.error('usage: render.mjs <doc.json | -> [--out x.svg] [--layout default|untangled|free-ports] [--elk k=v] [--all-layouts] [--families f.json] [--css s.css] [--png]');
        process.exit(2);
    }
    const elk = {};
    for (const pair of repeated.elk) {
        const at = pair.indexOf('=');
        if (at <= 0) {
            throw new Error(`--elk expects key=value, got '${pair}'`);
        }
        elk[pair.slice(0, at)] = pair.slice(at + 1);
    }
    return {
        doc: positional[0],
        out: path.resolve(single.out ?? 'diagram.svg'),
        layout: single.layout ?? 'default',
        elk,
        allLayouts: flags.has('all-layouts'),
        families: single.families ? readJson(single.families, '--families') : [],
        css: repeated.css.map(file => path.resolve(file)),
        behavior: single.behavior ? JSON.parse(single.behavior) : {},
        states: single.states ? readStates(single.states) : [],
        // The client draws a family's colour and icon from its own copy of the
        // families (`clientBehavior.nodeFamilies`), as the webview gets them
        // from the profile; the server copy only classifies the nodes.
        theme: single.theme ?? 'dark',
        png: flags.has('png'),
        keep: flags.has('keep'),
        chrome: single.chrome ?? process.env.CHROME ?? 'google-chrome'
    };
}

/** Dialogram's sources use legacy (experimental) decorators, as its tsconfig says. */
const TSCONFIG = { compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false } };

/** Resolve `@dialogram/*` to the workspace sources, as the extension's build does. */
const resolveWorkspace = {
    name: 'resolve-workspace-packages',
    setup(build) {
        build.onResolve({ filter: /^@dialogram\// }, args => {
            const [pkg, ...rest] = args.path.replace('@dialogram/', '').split('/');
            const dir = path.join(REPO, 'packages', pkg, 'src');
            if (!fs.existsSync(dir)) {
                return undefined;
            }
            return { path: path.join(dir, `${rest.length === 0 ? 'index' : rest.join('/')}.ts`) };
        });
    }
};

async function bundleSchemaBuilder(workDir) {
    const outfile = path.join(workDir, 'build-schema.cjs');
    await esbuild.build({
        entryPoints: [path.join(HERE, 'build-schema.ts')],
        outfile,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node18',
        logLevel: 'error',
        external: ['vscode'],
        tsconfigRaw: TSCONFIG,
        plugins: [resolveWorkspace]
    });
    return outfile;
}

async function bundleClient(workDir) {
    const outdir = path.join(workDir, 'bundle');
    await esbuild.build({
        entryPoints: [path.join(HERE, 'headless-entry.ts')],
        outdir,
        bundle: true,
        platform: 'browser',
        format: 'iife',
        target: 'ES2017',
        logLevel: 'error',
        tsconfigRaw: TSCONFIG,
        plugins: [resolveWorkspace],
        loader: { '.css': 'css', '.ttf': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl', '.eot': 'dataurl', '.svg': 'dataurl' },
        define: { 'process.env.NODE_ENV': '"production"', global: 'window' }
    });
    return outdir;
}

/** The handful of editor colours the stylesheets read, for a page outside VS Code. */
function themeVariables(theme) {
    const dark = {
        '--vscode-editor-background': '#1e1e1e',
        '--vscode-editor-foreground': '#d4d4d4',
        '--vscode-foreground': '#cccccc',
        '--vscode-descriptionForeground': '#9d9d9d',
        '--vscode-font-family': 'system-ui, sans-serif',
        '--vscode-editor-font-family': 'monospace'
    };
    const light = {
        '--vscode-editor-background': '#ffffff',
        '--vscode-editor-foreground': '#333333',
        '--vscode-foreground': '#3b3b3b',
        '--vscode-descriptionForeground': '#717171',
        '--vscode-font-family': 'system-ui, sans-serif',
        '--vscode-editor-font-family': 'monospace'
    };
    return Object.entries(theme === 'light' ? light : dark).map(([k, v]) => `${k}: ${v};`).join(' ');
}

function renderInChrome(chrome, pagePath) {
    const result = spawnSync(
        chrome,
        ['--headless=new', '--disable-gpu', '--no-sandbox', '--allow-file-access-from-files',
            '--virtual-time-budget=20000', '--dump-dom', `file://${pagePath}`],
        { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 }
    );
    if (result.error) {
        throw new Error(`could not run ${chrome}: ${result.error.message}`);
    }
    const match = /<pre id="result"[^>]*>([\s\S]*?)<\/pre>/.exec(result.stdout ?? '');
    if (!match) {
        throw new Error('the page produced no result (is the bundle broken?)');
    }
    const text = match[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
    return JSON.parse(text);
}

function rasterise(chrome, svgPath) {
    const png = svgPath.replace(/\.svg$/, '.png');
    const svg = fs.readFileSync(svgPath, 'utf8');
    const size = /width="(\d+)" height="(\d+)"/.exec(svg);
    spawnSync(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', `--screenshot=${png}`,
        `--window-size=${size ? `${size[1]},${size[2]}` : '1600,1200'}`, `file://${svgPath}`], { encoding: 'utf8' });
    return png;
}

async function renderOne(args, workDir, schemaBuilder, bundleDir, docPath, layout, out) {
    const schemaPath = path.join(workDir, `schema-${layout}.json`);
    const configPath = path.join(workDir, `config-${layout}.json`);
    fs.writeFileSync(configPath, JSON.stringify({ doc: docPath, out: schemaPath, families: args.families, layout, elk: args.elk }));
    process.stdout.write(`· ${layout}: `);
    const build = spawnSync(process.execPath, [schemaBuilder, configPath], { encoding: 'utf8', cwd: REPO });
    if (build.status !== 0) {
        console.log('layout failed');
        throw new Error((build.stderr || build.stdout || `exit ${build.status}`).trim());
    }
    process.stdout.write(`${build.stdout.trim()}; `);

    const pagePath = path.join(workDir, `page-${layout}.html`);
    const links = [path.join(bundleDir, 'headless-entry.css'), ...args.css]
        .map(file => `<link rel="stylesheet" href="file://${file}">`).join('\n');
    fs.writeFileSync(pagePath, `<!doctype html><html><head><meta charset="utf-8">
${links}
<style>
html, body { margin: 0; ${themeVariables(args.theme)} background: var(--vscode-editor-background); color: var(--vscode-foreground); }
#dialogram-headless { width: ${CANVAS_PX}px; height: ${CANVAS_PX}px; }
#dialogram-headless > svg { width: 100%; height: 100%; }
</style>
</head><body class="vscode-${args.theme}"><div class="sprotty" id="dialogram-headless"></div>
<div id="dialogram-headless_hidden"></div><div id="dialogram-headless_popup"></div>
<script>window.diagramIdentifier = { clientBehavior: ${inlineJson(JSON.stringify({ nodeFamilies: args.families, ...args.behavior }))} };
window.__SCHEMA__ = ${inlineJson(fs.readFileSync(schemaPath, 'utf8'))};
window.__STATES__ = ${inlineJson(JSON.stringify(args.states))};
window.__CANVAS__ = ${CANVAS_PX};</script>
<script src="file://${path.join(bundleDir, 'headless-entry.js')}"></script>
</body></html>`);

    const result = renderInChrome(args.chrome, pagePath);
    if (result.error) {
        console.log('render failed');
        throw new Error(String(result.error));
    }
    fs.writeFileSync(out, result.svg);
    console.log(`${result.elementCount} elements → ${out}`);
    if (args.png) {
        console.log(`  rasterised → ${rasterise(args.chrome, out)}`);
    }
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dialogram-render-'));
    // The work directory goes whatever happens, a failed layout or render
    // or an interrupt included, unless it was asked to be kept (then it is
    // said where).
    const leave = async signal => {
        // esbuild bundles in a process of its own, which would go on writing
        // into the directory after it is removed: stop it first.
        await Promise.race([Promise.resolve(esbuild.stop()), new Promise(resolve => setTimeout(resolve, 2000))]);
        if (!args.keep) {
            fs.rmSync(workDir, { recursive: true, force: true });
        }
        process.exit(signal === 'SIGINT' ? 130 : 143);
    };
    process.once('SIGINT', leave);
    process.once('SIGTERM', leave);
    try {
        const docPath = path.join(workDir, 'doc.json');
        fs.writeFileSync(docPath, args.doc === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(args.doc, 'utf8'));

        process.stdout.write('· bundling the layout and the client… ');
        const [schemaBuilder, bundleDir] = await Promise.all([bundleSchemaBuilder(workDir), bundleClient(workDir)]);
        console.log('done');

        const layouts = args.allLayouts ? LAYOUTS : [args.layout];
        for (const layout of layouts) {
            const out = args.allLayouts ? args.out.replace(/\.svg$/, `-${layout}.svg`) : args.out;
            await renderOne(args, workDir, schemaBuilder, bundleDir, docPath, layout, out);
        }
    } finally {
        if (args.keep) {
            console.log(`· intermediates kept in ${workDir}`);
        } else {
            fs.rmSync(workDir, { recursive: true, force: true });
        }
    }
}

main().catch(error => {
    console.error(error?.message ?? error);
    process.exit(1);
});
