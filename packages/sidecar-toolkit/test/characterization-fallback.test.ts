// Characterization test (F6, final-review finding) for the wfpy CLI-failure -> static-sidecar-
// fallback branch in `SidecarCliModelSource#getGraph` (see `sidecar-cli-model-source.ts:184-199`
// for the CLI-failure branch and `:259-292` for `renderStaticSidecarFallback`). When the wfpy
// runtime `plan` CLI exits non-zero, `getGraph` falls back to the static sidecar's
// `exportWorkflowGraph` op: if that sidecar can still produce a graph, the diagram renders the
// statically-parsed structure instead of collapsing to a single error node, with a synthetic
// `runtime_plan_failed` file-level diagnostic merged in so the runtime failure isn't hidden.
//
// This pins CURRENT behavior (the final review confirmed it matches pre-branch) rather than
// asserting a spec -- a characterization pin, same intent as characterization-graph-load.test.ts
// (which stays untouched/frozen; this is a new file so that constraint isn't at risk here).
//
// Spawns REAL fake CLI/sidecar processes (test/fixtures/fake-cli.cjs with FAKE_CLI_FAIL=1,
// test/fixtures/fake-sidecar.cjs default reply) through the storage's public `runtimeProfile`
// seam, mirroring characterization-graph-load.test.ts's approach.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Module } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscodeMock from './vscode-mock';
import { WorkflowSourceModelStorage } from '@dialogram/diagram-server/server/diagram-glsp-module';
import { createSidecarModelSource, type SidecarRuntimeConfig } from '../src/index';
import { NEUTRAL_CREATE_NODE_CONFIG } from './fixtures/create-node-config';

const FIXTURES = path.join(__dirname, 'fixtures');
const FAKE_CLI = path.join(FIXTURES, 'fake-cli.cjs');
const FAKE_SIDECAR = path.join(FIXTURES, 'fake-sidecar.cjs');

const tempPaths: string[] = [];
const envKeys = ['FAKE_CLI_LOG', 'FAKE_CLI_FAIL', 'FAKE_SIDECAR_LOG'] as const;

// See characterization-graph-load.test.ts for why this patch is needed: WorkflowSourceModelStorage
// does a bare `require('vscode')` at a couple of call sites (`getCliInvocation`,
// `tryLoadGraphFromSidecar`), which vitest's `vscode` alias (ESM-only) doesn't cover.
let originalModuleLoad: (request: string, parent: unknown, isMain: boolean) => unknown;
beforeAll(() => {
    originalModuleLoad = (Module as any)._load;
    (Module as any)._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
        if (request === 'vscode') {
            return vscodeMock;
        }
        return originalModuleLoad.call(this, request, parent, isMain);
    };
});
afterAll(() => {
    (Module as any)._load = originalModuleLoad;
});

afterEach(() => {
    for (const key of envKeys) {
        delete process.env[key];
    }
    for (const p of tempPaths.splice(0)) {
        fs.rmSync(p, { recursive: true, force: true });
    }
});

function makeLogFile(prefix: string): string {
    const file = path.join(os.tmpdir(), `${prefix}-${process.pid}-${Math.random().toString(36).slice(2)}.log`);
    tempPaths.push(file);
    return file;
}

function readLogLines(file: string): unknown[] {
    if (!fs.existsSync(file)) {
        return [];
    }
    const content = fs.readFileSync(file, 'utf8').trim();
    if (content === '') {
        return [];
    }
    return content.split('\n').map(line => JSON.parse(line));
}

function makeWorkflowFile(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
    tempPaths.push(dir);
    const file = path.join(dir, 'pipeline.py');
    fs.writeFileSync(file, '# characterization-fallback fixture workflow stub\n', 'utf8');
    return file;
}

/** Recursively collects every `.id` in a GModel element tree (root, nodes, edges, ports, ...). */
function collectIds(element: unknown): string[] {
    if (!element || typeof element !== 'object') {
        return [];
    }
    const el = element as { id?: unknown; children?: unknown };
    const ids: string[] = [];
    if (typeof el.id === 'string') {
        ids.push(el.id);
    }
    if (Array.isArray(el.children)) {
        for (const child of el.children) {
            ids.push(...collectIds(child));
        }
    }
    return ids;
}

/** ModelState stub matching the shape `finishLoadFromDoc` reads/writes (set/get/updateRoot). */
function makeModelStateStub(): { set: (key: unknown, value: unknown) => void; get: (key: unknown) => unknown; updateRoot: (root: unknown) => void; root: unknown } {
    const store = new Map<unknown, unknown>();
    let root: unknown;
    return {
        set: (key: unknown, value: unknown) => {
            store.set(key, value);
        },
        get: (key: unknown) => store.get(key),
        updateRoot: (r: unknown) => {
            root = r;
        },
        get root(): unknown {
            return root;
        }
    };
}

function stubOverlaySideChannels(storage: Record<string, unknown>): void {
    storage.applyViewerOverlayToEdges = async () => undefined;
    storage.applyAgentContextToNodes = async () => undefined;
    storage.attachWorkflowRunHistory = async () => undefined;
    storage.applyAgentEnrichment = async () => undefined;
    storage.getWorkflowCallerReferences = async () => [];
}

function wfpyPlanCfg(): SidecarRuntimeConfig {
    return {
        settingsNamespace: 'wfLang',
        sidecarOperationPrefix: 'wfpy',
        sidecarCommandSettingKey: 'wfpySidecarCommand',
        sidecarCommandDefault: FAKE_SIDECAR,
        cliCommandSettingKey: 'wfpyCommand',
        cliCommandDefault: process.execPath,
        cliPythonModule: undefined,
        operationKinds: { createEntityPort: 'op.createEntityPort', deleteEntityPort: 'op.deleteEntityPort' },
        ...NEUTRAL_CREATE_NODE_CONFIG,
        acceptedOperationPrefixes: ['wfpy', 'calpy'],
        graphAcquisition: 'cli-plan',
        cliGraphArgs: (file: string) => [FAKE_CLI, 'plan', file, '--format', 'graph', '--best-effort']
    };
}

function makeWfpyStorageWithFallback(): any {
    const storage = new (WorkflowSourceModelStorage as any)();
    const cfg = wfpyPlanCfg();
    storage.injectedModelSource = createSidecarModelSource(cfg);
    storage.storageOptions = { settingsNamespace: cfg.settingsNamespace, operationPrefix: cfg.sidecarOperationPrefix };
    storage.modelState = makeModelStateStub();
    storage.layoutPersistence = {
        loadLayout: async () => undefined,
        loadEdgeRoutes: async () => undefined
    };
    stubOverlaySideChannels(storage);
    return storage;
}

/** Flush pending microtasks so the fire-and-forget `publishGraphDiagnostics` promise settles. */
async function flush(): Promise<void> {
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
}

const PROBLEMS_COLLECTION_NAME = 'workflow-graph';

function getDiagnostics(file: string): InstanceType<typeof vscodeMock.Diagnostic>[] | undefined {
    const collection = vscodeMock.languages.createDiagnosticCollection(PROBLEMS_COLLECTION_NAME);
    return collection.get(vscodeMock.Uri.file(file));
}

describe('characterization (F6): wfpy CLI-failure falls back to the static sidecar', () => {
    it('renders the statically-parsed structure via the sidecar export op, and merges a runtime_plan_failed diagnostic', async () => {
        const cliLog = makeLogFile('fake-cli-fail');
        const sidecarLog = makeLogFile('fake-sidecar-fallback');
        process.env.FAKE_CLI_LOG = cliLog;
        process.env.FAKE_CLI_FAIL = '1';
        process.env.FAKE_SIDECAR_LOG = sidecarLog;
        const workflowFile = makeWorkflowFile('wf-char-fallback');
        const sourceUri = `file://${workflowFile}`;

        const storage = makeWfpyStorageWithFallback();
        await storage.loadSourceModelDocument({ options: {} }, sourceUri);
        await flush();

        // The wfpy CLI was consulted (and failed) first.
        const cliCalls = readLogLines(cliLog) as string[][];
        expect(cliCalls).toHaveLength(1);
        expect(cliCalls[0]).toEqual(expect.arrayContaining(['plan', workflowFile, '--format', 'graph', '--best-effort']));

        // PIN: the fallback still renders the fixture's nodes/edge via the static sidecar --
        // the graph does not collapse to a single error node.
        const root = storage.modelState.root;
        expect(root).toBeDefined();
        expect(collectIds(root)).toEqual(expect.arrayContaining(['n1', 'n2', 'e1']));

        // PIN: the sidecar log shows the wfpy export op (exportWorkflowGraph, not
        // exportNetworkGraph -- that op is calpy-only).
        const sidecarCalls = readLogLines(sidecarLog) as Array<{ op: string }>;
        expect(sidecarCalls).toHaveLength(1);
        expect(sidecarCalls[0].op).toBe('wfpy.exportWorkflowGraph');

        // PIN: the merged `runtime_plan_failed` diagnostic appears on the workflow file, carrying
        // the CLI failure message forward so the graph isn't a deceptively-clean view of a broken
        // runtime.
        const diagnostics = getDiagnostics(workflowFile) ?? [];
        expect(diagnostics).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    code: 'runtime_plan_failed',
                    message: expect.stringContaining('Showing statically-parsed structure')
                })
            ])
        );
    });
});
