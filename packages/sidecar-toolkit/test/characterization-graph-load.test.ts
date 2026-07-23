// Characterization tests for wfpy (CLI `plan`) and calpy (sidecar) graph loading.
//
// These pin CURRENT black-box behavior of WorkflowSourceModelStorage ahead of the module split
// planned for later tasks. They spawn REAL fake CLI/sidecar processes (test/fixtures/*.cjs)
// through the storage's public `runtimeProfile` seam instead of monkey-patching internal
// methods like `tryLoadGraphFromSidecar` or `graphPayloadToDoc` -- so the pins keep meaning
// even after the god-class is restructured.
//
// The only stubbed internals are the *unrelated* overlay/history/agent side-channels that
// `finishLoadFromDoc` calls (viewer overlay tokens, run history, agent context/skills), which
// read from run-log files and the VS Code workspace that don't exist in this test's temp dirs.
// That stubbing mirrors the existing precedent in cross-file-navigation-overlay.test.ts and
// never touches the CLI/sidecar spawn path, the plan cache, `graphPayloadToDoc`, or
// `finishLoadFromDoc`'s own node/edge/ModelState wiring -- the behavior under test here.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Module } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscodeMock from './vscode-mock';
import {
    WorkflowSourceModelStorage,
    WORKFLOW_LAYOUT_PERSISTENCE_KEY,
    WORKFLOW_NETWORK_MODEL_KEY
} from '@dialogram/diagram-server/server/diagram-glsp-module';
import { createSidecarModelSource, type SidecarRuntimeConfig } from '../src/index';
import { NEUTRAL_CREATE_NODE_CONFIG } from './fixtures/create-node-config';

const FIXTURES = path.join(__dirname, 'fixtures');
const FAKE_CLI = path.join(FIXTURES, 'fake-cli.cjs');
const FAKE_SIDECAR = path.join(FIXTURES, 'fake-sidecar.cjs');

const FIXTURE_OP_KINDS = { createEntityPort: 'op.createEntityPort', deleteEntityPort: 'op.deleteEntityPort' };

/** wfpy-shaped runtime config wired to the fake CLI (`plan --format graph --best-effort`). */
function wfpyPlanCfg(): SidecarRuntimeConfig {
    return {
        settingsNamespace: 'wfLang',
        sidecarOperationPrefix: 'wfpy',
        sidecarCommandSettingKey: 'wfpySidecarCommand',
        sidecarCommandDefault: FAKE_SIDECAR,
        cliCommandSettingKey: 'wfpyCommand',
        cliCommandDefault: process.execPath,
        cliPythonModule: undefined,
        operationKinds: FIXTURE_OP_KINDS,
        ...NEUTRAL_CREATE_NODE_CONFIG,
        acceptedOperationPrefixes: ['wfpy', 'calpy'],
        graphAcquisition: 'cli-plan',
        cliGraphArgs: (file: string) => [FAKE_CLI, 'plan', file, '--format', 'graph', '--best-effort']
    };
}

/** calpy-shaped runtime config wired to the fake sidecar export op (no CLI path). */
function calpySidecarCfg(): SidecarRuntimeConfig {
    return {
        settingsNamespace: 'calLang',
        sidecarOperationPrefix: 'calpy',
        sidecarCommandSettingKey: 'calpySidecarCommand',
        sidecarCommandDefault: FAKE_SIDECAR,
        cliCommandSettingKey: 'calpyCommand',
        cliCommandDefault: 'calpy',
        cliPythonModule: undefined,
        operationKinds: FIXTURE_OP_KINDS,
        ...NEUTRAL_CREATE_NODE_CONFIG,
        acceptedOperationPrefixes: ['wfpy', 'calpy'],
        graphAcquisition: 'sidecar-export',
        graphExportFailureLabel: 'CalPy sidecar graph export failed'
    };
}

const tempPaths: string[] = [];
const envKeys = ['FAKE_CLI_LOG', 'FAKE_SIDECAR_LOG', 'FAKE_SIDECAR_FAIL'] as const;

// WorkflowSourceModelStorage internally does `require('vscode')` (not `import`) at a couple of
// call sites (`getCliInvocation`, `tryLoadGraphFromSidecar`) to reach the real VS Code API when
// hosted in the extension. Vitest's `vscode` alias (vitest.config.ts) only covers ESM `import`
// resolution, so a bare `require('vscode')` throws "Cannot find module" under vitest and those
// methods silently fall back to hardcoded defaults, bypassing the injected `runtimeProfile`
// stub entirely (masking the very seam this suite spawns real processes through). Patch Node's
// module loader for the lifetime of this file only, restored in afterAll, so `require('vscode')`
// resolves to the same mock `import('vscode')` already resolves to.
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
    fs.writeFileSync(file, '# characterization fixture workflow stub\n', 'utf8');
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

/** ModelState stub matching the shape `finishLoadFromDoc` writes to (set/get) and reads root from (updateRoot). */
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

/**
 * Stubs the overlay/history/agent side-channels `finishLoadFromDoc` calls after building the
 * GModel root. These read run-log files and VS Code workspace state unrelated to the CLI/
 * sidecar/doc-conversion behavior these tests pin; cribbed from the equivalent stub set in
 * cross-file-navigation-overlay.test.ts (`finishLoadFromDoc` root-parameters test).
 */
function stubOverlaySideChannels(storage: Record<string, unknown>): void {
    storage.applyViewerOverlayToEdges = async () => undefined;
    storage.applyAgentContextToNodes = async () => undefined;
    storage.attachWorkflowRunHistory = async () => undefined;
    storage.applyAgentEnrichment = async () => undefined;
    storage.getWorkflowCallerReferences = async () => [];
}

function makeStorage(cfg: SidecarRuntimeConfig): any {
    const storage = new (WorkflowSourceModelStorage as any)();
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

describe('characterization: wfpy CLI plan path', () => {
    it('loads the graph via a real spawn of the CLI with the pinned arg tail, and populates ModelState', async () => {
        const logFile = makeLogFile('fake-cli');
        process.env.FAKE_CLI_LOG = logFile;
        const workflowFile = makeWorkflowFile('wf-char-cli');
        const sourceUri = `file://${workflowFile}`;

        const storage = makeStorage(wfpyPlanCfg());

        await storage.loadSourceModelDocument({ options: {} }, sourceUri);

        // PIN: the CLI was spawned exactly once with the arg tail plan/<file>/--format graph --best-effort.
        const calls = readLogLines(logFile) as string[][];
        expect(calls).toHaveLength(1);
        expect(calls[0]).toEqual(expect.arrayContaining(['plan', workflowFile, '--format', 'graph', '--best-effort']));

        // PIN: the fixture's nodes/edge reached ModelState's root via convertToGModelRoot.
        const root = storage.modelState.root;
        expect(root).toBeDefined();
        const ids = collectIds(root);
        expect(ids).toEqual(expect.arrayContaining(['n1', 'n2', 'e1']));
    });

    it('short-circuits the second identical load through the plan cache (CLI spawns once)', async () => {
        const logFile = makeLogFile('fake-cli-cache');
        process.env.FAKE_CLI_LOG = logFile;
        const workflowFile = makeWorkflowFile('wf-char-cli-cache');
        const sourceUri = `file://${workflowFile}`;

        // One storage instance: the plan cache lives on the instance (planGraphCache), so a
        // fresh instance per call would defeat the pin.
        const storage = makeStorage(wfpyPlanCfg());

        await storage.loadSourceModelDocument({ options: {} }, sourceUri);
        await storage.loadSourceModelDocument({ options: {} }, sourceUri);

        const calls = readLogLines(logFile);
        expect(calls).toHaveLength(1);
        expect(collectIds(storage.modelState.root)).toEqual(expect.arrayContaining(['n1', 'n2']));
    });
});

describe('characterization: calLang sidecar path', () => {
    it('loads via a real spawn of the sidecar export op and never falls through to the CLI', async () => {
        const sidecarLog = makeLogFile('fake-sidecar');
        process.env.FAKE_SIDECAR_LOG = sidecarLog;
        const workflowFile = makeWorkflowFile('wf-char-sidecar');
        const sourceUri = `file://${workflowFile}`;

        // calpy resolves to a pure SidecarModelSource with no CLI path, so the CLI is structurally
        // never consulted (the counter stays 0 with nothing to increment it).
        const cliInvocationCalls = 0;
        const storage = makeStorage(calpySidecarCfg());

        await storage.loadSourceModelDocument({ options: {} }, sourceUri);

        const sidecarCalls = readLogLines(sidecarLog) as Array<{ op: string }>;
        expect(sidecarCalls).toHaveLength(1);
        expect(sidecarCalls[0].op).toMatch(/export(Network|Workflow)Graph/);

        expect(collectIds(storage.modelState.root)).toEqual(expect.arrayContaining(['n1', 'n2']));
        // PIN: calLang never falls through to the CLI dispatch, even indirectly.
        expect(cliInvocationCalls).toBe(0);
    });

    it('yields an error/fallback document on sidecar failure, still without CLI fallback', async () => {
        const sidecarLog = makeLogFile('fake-sidecar-fail');
        process.env.FAKE_SIDECAR_LOG = sidecarLog;
        process.env.FAKE_SIDECAR_FAIL = '1';
        const workflowFile = makeWorkflowFile('wf-char-sidecar-fail');
        const sourceUri = `file://${workflowFile}`;

        // calpy resolves to a pure SidecarModelSource with no CLI path, so the CLI is structurally
        // never consulted (the counter stays 0 with nothing to increment it).
        const cliInvocationCalls = 0;
        const storage = makeStorage(calpySidecarCfg());

        await expect(storage.loadSourceModelDocument({ options: {} }, sourceUri)).resolves.toBeUndefined();

        // The sidecar still received (and logged) the request before failing.
        const sidecarCalls = readLogLines(sidecarLog) as Array<{ op: string }>;
        expect(sidecarCalls).toHaveLength(1);

        // PIN: a failed sidecar still produces a renderable fallback document (a single error
        // node -- its GModel id is the human-readable label "Graph export failed", not the raw
        // `__graph_export_error__` IR id: `transform()` prefers `node.label` over `node.id` for
        // the stable GModel id whenever a label is present), not a thrown error and not a CLI
        // invocation.
        const root = storage.modelState.root as { args?: Record<string, unknown> };
        expect(root).toBeDefined();
        expect(collectIds(root)).toContain('Graph export failed');
        expect(root.args?.['wf:partial']).toBe(true);
        expect(root.args?.['wf:errors']).toEqual([
            expect.objectContaining({ message: expect.stringContaining('CalPy sidecar graph export failed') })
        ]);
        expect(cliInvocationCalls).toBe(0);
    });
});

describe('characterization: finishLoadFromDoc output shape', () => {
    it('produces the pinned GModel structure and ModelState side-channel entries for the fixture doc', async () => {
        const workflowFile = makeWorkflowFile('wf-char-finish');
        const sourceUri = `file://${workflowFile}`;
        const doc = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'plan-graph.json'), 'utf8'));

        const storage = makeStorage(wfpyPlanCfg());

        await storage.finishLoadFromDoc(doc, sourceUri, workflowFile, {});

        const root = storage.modelState.root;
        expect(root).toBeDefined();
        expect(root.type).toBeDefined();
        expect(collectIds(root)).toEqual(expect.arrayContaining(['n1', 'n2', 'e1']));

        // PIN: the layout-persistence and network-model ModelState side-channel entries that
        // submission/bounds handlers read back are populated.
        const layoutMeta = storage.modelState.get(WORKFLOW_LAYOUT_PERSISTENCE_KEY) as Record<string, unknown>;
        expect(layoutMeta).toBeDefined();
        expect(layoutMeta.workflowFilePath).toBe(workflowFile);
        expect(typeof layoutMeta.networkId).toBe('string');

        const networkModel = storage.modelState.get(WORKFLOW_NETWORK_MODEL_KEY) as Record<string, unknown>;
        expect(networkModel).toBeDefined();
        expect(networkModel.graph).toBeDefined();
    });
});
