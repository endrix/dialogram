// A sidecar/CLI command that cannot be spawned at all (ENOENT — not installed,
// or a typo'd command setting) must produce the graph-export-failure document,
// exactly like a command that starts and exits non-zero. Without an 'error'
// handler on the spawned child, Node throws an uncaught exception in the
// extension host ("An unknown error occurred") and loadPythonModel never
// resolves — the diagram sits at "model loading" forever. This is the
// first-run experience for any user without the sidecars on PATH.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Module } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscodeMock from './vscode-mock';
import { WorkflowSourceModelStorage } from '@dialogram/diagram-server/server/diagram-glsp-module';
import { createSidecarModelSource, type SidecarRuntimeConfig } from '../src/index';
import { NEUTRAL_CREATE_NODE_CONFIG } from './fixtures/create-node-config';

// Same require('vscode') shim as characterization-graph-load.test.ts (see the
// explanation there; extracting a shared helper is tracked follow-up work).
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

const MISSING_CMD = 'dialogram-test-definitely-not-installed-xyz';

function makeWorkflowFile(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-spawn-fail-'));
    const file = path.join(dir, 'pipeline.py');
    fs.writeFileSync(file, '# spawn-failure fixture\n', 'utf8');
    return file;
}

function makeModelStateStub() {
    const store = new Map<unknown, unknown>();
    let root: unknown;
    return {
        set: (key: unknown, value: unknown) => void store.set(key, value),
        get: (key: unknown) => store.get(key),
        updateRoot: (r: unknown) => {
            root = r;
        },
        get root(): unknown {
            return root;
        }
    };
}

/** Collects every string `id` and `text` in a GModel tree (children only — parent links are circular). */
function collectStrings(element: unknown, out: string[] = []): string[] {
    if (!element || typeof element !== 'object') {
        return out;
    }
    const el = element as { id?: unknown; text?: unknown; children?: unknown };
    if (typeof el.id === 'string') {
        out.push(el.id);
    }
    if (typeof el.text === 'string') {
        out.push(el.text);
    }
    if (Array.isArray(el.children)) {
        for (const child of el.children) {
            collectStrings(child, out);
        }
    }
    return out;
}

const FIXTURE_OP_KINDS = { createEntityPort: 'op.createEntityPort', deleteEntityPort: 'op.deleteEntityPort' };

function makeStorage(cfg: SidecarRuntimeConfig): any {
    const storage = new (WorkflowSourceModelStorage as any)();
    storage.injectedModelSource = createSidecarModelSource(cfg);
    storage.storageOptions = { settingsNamespace: cfg.settingsNamespace, operationPrefix: cfg.sidecarOperationPrefix };
    storage.modelState = makeModelStateStub();
    storage.layoutPersistence = {
        loadLayout: async () => undefined,
        loadEdgeRoutes: async () => undefined
    };
    storage.applyViewerOverlayToEdges = async () => undefined;
    storage.applyAgentContextToNodes = async () => undefined;
    storage.attachWorkflowRunHistory = async () => undefined;
    storage.applyAgentEnrichment = async () => undefined;
    storage.getWorkflowCallerReferences = async () => [];
    return storage;
}

describe('spawn failure (command not installed)', () => {
    it('calpy: unspawnable sidecar resolves to the failure document instead of hanging', async () => {
        const workflowFile = makeWorkflowFile();
        const storage = makeStorage({
            settingsNamespace: 'calLang',
            sidecarOperationPrefix: 'calpy',
            sidecarCommandSettingKey: 'calpySidecarCommand',
            sidecarCommandDefault: MISSING_CMD,
            cliCommandSettingKey: 'calpyCommand',
            cliCommandDefault: 'calpy',
            cliPythonModule: undefined,
            operationKinds: FIXTURE_OP_KINDS,
            ...NEUTRAL_CREATE_NODE_CONFIG,
            acceptedOperationPrefixes: ['wfpy', 'calpy'],
            graphAcquisition: 'sidecar-export'
        });

        await storage.loadSourceModelDocument({ options: {} }, `file://${workflowFile}`);

        const root = storage.modelState.root;
        expect(root).toBeDefined();
        const strings = collectStrings(root);
        expect(strings.some(s => s.includes('Graph export failed'))).toBe(true);
    }, 10000);

    it('wfpy: unspawnable CLI and sidecar resolve to the failure document instead of hanging', async () => {
        const workflowFile = makeWorkflowFile();
        const storage = makeStorage({
            settingsNamespace: 'wfLang',
            sidecarOperationPrefix: 'wfpy',
            sidecarCommandSettingKey: 'wfpySidecarCommand',
            sidecarCommandDefault: MISSING_CMD,
            cliCommandSettingKey: 'wfpyCommand',
            cliCommandDefault: MISSING_CMD,
            cliPythonModule: undefined,
            operationKinds: FIXTURE_OP_KINDS,
            ...NEUTRAL_CREATE_NODE_CONFIG,
            acceptedOperationPrefixes: ['wfpy', 'calpy'],
            graphAcquisition: 'cli-plan',
            cliGraphArgs: (file: string) => ['plan', file, '--format', 'graph', '--best-effort']
        });

        await storage.loadSourceModelDocument({ options: {} }, `file://${workflowFile}`);

        const root = storage.modelState.root;
        expect(root).toBeDefined();
        const strings = collectStrings(root);
        expect(strings.some(s => s.includes('Graph export failed'))).toBe(true);
    }, 10000);
});
