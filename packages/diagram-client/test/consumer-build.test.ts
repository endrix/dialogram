/**
 * Consumer-path proof (SP3 Task 5).
 *
 * Proves an EXTERNAL consumer can build a diagram webview from the diagram-client
 * library source + its OWN custom view module — the path SP4 (mlir) will take.
 *
 * Two independent checks against the SAME fixture module:
 *  1. BUILD: run esbuild's JS API headlessly (no network, no disk writes) over
 *     the fixture entry that imports `createDiagramContainer` from the package
 *     root, using the shells' option family (bundle + IIFE + browser + fonts
 *     inlined) plus `jsxFactory: 'svg'` for the consumer's custom SVG views.
 *     Assert the bundle builds and the custom type id survives in it.
 *  2. COMPOSE + REGISTER: in-process, construct the container with the custom
 *     module and assert its `configureModelElement` registration is present
 *     (recorded against the shared GLSP stub — a real GLSP container cannot boot
 *     headlessly because its browser bundle imports `.css` at load).
 */
import 'reflect-metadata';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { describe, it, expect } from 'vitest';
import { createDiagramContainer, composeDiagramModules } from '../src/container';
import { diagramBaseModule } from '../src/base.module';
import { customDemoModule } from './fixtures/custom-view-consumer/custom-module';
import { CUSTOM_DEMO_NODE_TYPE } from './fixtures/custom-view-consumer/custom-node';
import { recordModuleRegistrations } from './container-registration-recorder';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const ENTRY = path.resolve(__dirname, 'fixtures/custom-view-consumer/entry.ts');

describe('consumer-path proof — external bundle build', () => {
    it(
        'bundles the library + a custom view module with the shells esbuild recipe',
        async () => {
            const result = await esbuild.build({
                entryPoints: [ENTRY],
                absWorkingDir: REPO_ROOT, // resolve node_modules / @dialogram/* symlinks
                bundle: true,
                write: false, // fully headless — outputs stay in memory
                // outdir names the (in-memory) outputs so the CSS loader can emit
                // a sibling stylesheet; nothing is written to disk (write: false).
                outdir: 'consumer-build-out',
                format: 'iife',
                platform: 'browser',
                target: 'ES2017',
                jsxFactory: 'svg', // consumer custom SVG views (mlir --jsx-factory=svg)
                logLevel: 'silent',
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
            const js = result.outputFiles.find(f => f.path.endsWith('.js'));
            expect(js).toBeTruthy();
            // A real bundle of the GLSP graph is large; a trivial/failed build would not be.
            expect(js!.text.length).toBeGreaterThan(10_000);
            // The consumer's custom module (and thus its registration) is in the bundle.
            expect(js!.text).toContain(CUSTOM_DEMO_NODE_TYPE);
        },
        60_000
    );
});

describe('consumer-path proof — in-process composition + registration', () => {
    it('composes the neutral base + the consumer module (base first, custom after)', () => {
        const modules = composeDiagramModules({ clientId: 'consumer_0', features: [customDemoModule] });
        expect(modules[0]).toBe(diagramBaseModule);
        expect(modules).toContain(customDemoModule);
    });

    it('constructs a container with the custom module and boots headlessly', () => {
        const container = createDiagramContainer({ clientId: 'consumer_0', features: [customDemoModule] });
        expect(container).toBeTruthy();
    });

    it('registers the custom model element (typeId, model, view) via the consumer module', () => {
        const regs = recordModuleRegistrations([diagramBaseModule, customDemoModule]);
        const custom = regs.find(
            entry => entry.op === 'modelElement' && entry.typeId === CUSTOM_DEMO_NODE_TYPE
        );
        expect(custom).toBeTruthy();
        expect(custom?.model).toBe('CustomDemoNode');
        expect(custom?.view).toBe('CustomDemoNodeView');
    });
});

/**
 * Reuse-boundary guard (D2): the neutral property-panel toolkit resolves from the
 * package entry and is the expected kind, while the domain-coupled content class
 * (`PropertyPanel`) stays unexported — mirroring `WorkflowDiagramStarter`.
 */
describe('property-panel library surface — package entry exports', () => {
    it('exports the reusable chrome + field toolkit as the expected kinds', async () => {
        const entry = await import('../src/index');
        expect(typeof entry.PropertyPanelChrome).toBe('function'); // class
        expect(entry.DEFAULT_PROPERTY_PANEL_CHROME_CONFIG.panelId).toBe('property-panel');
        expect(typeof entry.ppField).toBe('function');
        expect(typeof entry.ppNumberField).toBe('function');
        expect(typeof entry.ppReadonlyRow).toBe('function');
        expect(typeof entry.renderInto).toBe('function');
        expect(typeof entry.readStringArg).toBe('function');
        expect(typeof entry.readNumberArg).toBe('function');
        expect(typeof entry.readBoolArg).toBe('function');
    });

    it('does NOT export the domain-coupled PropertyPanel content class', async () => {
        const entry = await import('../src/index');
        expect((entry as Record<string, unknown>).PropertyPanel).toBeUndefined();
    });
});
