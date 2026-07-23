// Task 1 (SP2c-1) seam test: `WorkflowSourceModelStorage` must depend only on the neutral
// `DiagramModelSource` interface -- NOT the concrete `SidecarCliModelSource`. This pins three
// facts the de-coupling must hold:
//
//   (a) the storage's injected model-source field accepts a minimal object implementing ONLY the
//       `DiagramModelSource` interface (a stub with no sidecar/CLI methods at all);
//   (b) a load through that stub publishes exactly the stub's pre-normalized `GraphDocument.diagnostics`
//       to the Problems panel (the storage no longer walks a product-shaped raw payload);
//   (c) `getWorkflowNodeIdentities` returns the stub's `getNodeIdentities` result without ever
//       touching a sidecar/CLI method (the stub has none -- any such call would throw).
//
// Mirrors diagnostics-parity.test.ts's harness (vscode mock + direct storage construction), so the
// pin keeps meaning across the later toolkit-severance tasks.
import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Module } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscodeMock from './vscode-mock';
import type { DiagramModelSource, GraphDocument, GraphNodeIdentity } from '@dialogram/shared';
import { WorkflowSourceModelStorage } from '@dialogram/diagram-server/server/diagram-glsp-module';

const tempPaths: string[] = [];

// Same `require('vscode')` shim the other storage suites use (see diagnostics-parity.test.ts).
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
    for (const p of tempPaths.splice(0)) {
        fs.rmSync(p, { recursive: true, force: true });
    }
});

function makeWorkflowFile(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
    tempPaths.push(dir);
    const file = path.join(dir, 'pipeline.py');
    fs.writeFileSync(file, '# model-source-interface fixture stub\n', 'utf8');
    return file;
}

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

/** A model source implementing ONLY the neutral `DiagramModelSource` interface -- no sidecar/CLI. */
function makeStubModelSource(options: {
    diagnostics?: GraphDocument['diagnostics'];
    identities?: GraphNodeIdentity[];
}): DiagramModelSource & { getNodeIdentitiesCalls: number } {
    const stub = {
        getNodeIdentitiesCalls: 0,
        async getGraph(): Promise<GraphDocument> {
            return {
                version: '1.0',
                graph: {
                    id: 'wf:stub',
                    nodes: [
                        { id: 'n1', kind: 'task', label: 'N1', type: 'Task', scope: 'scope:root', ports: [], meta: {} }
                    ],
                    edges: [],
                    subgraphs: []
                },
                ...(options.diagnostics ? { diagnostics: options.diagnostics } : {})
            };
        },
        async getNodeIdentities(): Promise<GraphNodeIdentity[] | undefined> {
            stub.getNodeIdentitiesCalls++;
            return options.identities;
        }
    };
    return stub;
}

function makeStorageWithModelSource(modelSource: DiagramModelSource): any {
    const storage = new (WorkflowSourceModelStorage as any)();
    // (a) The field accepts an object implementing ONLY `DiagramModelSource`.
    storage.injectedModelSource = modelSource;
    storage.storageOptions = { settingsNamespace: 'wfLang', operationPrefix: 'wfpy' };
    storage.modelState = makeModelStateStub();
    storage.layoutPersistence = {
        loadLayout: async () => undefined,
        loadEdgeRoutes: async () => undefined
    };
    stubOverlaySideChannels(storage);
    return storage;
}

async function flush(): Promise<void> {
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
}

const PROBLEMS_COLLECTION_NAME = 'workflow-graph';

function getDiagnostics(file: string): InstanceType<typeof vscodeMock.Diagnostic>[] | undefined {
    const collection = vscodeMock.languages.createDiagnosticCollection(PROBLEMS_COLLECTION_NAME);
    return collection.get(vscodeMock.Uri.file(file));
}

describe('DiagramModelSource seam: storage depends only on the interface', () => {
    it('publishes exactly the stub model source\'s pre-normalized diagnostics', async () => {
        const workflowFile = makeWorkflowFile('wf-iface-diag');
        const sourceUri = `file://${workflowFile}`;
        const nodeFile = path.join(path.dirname(workflowFile), 'node-source.py');

        const modelSource = makeStubModelSource({
            diagnostics: [
                { uri: nodeFile, severity: 'warning', message: 'stub node diagnostic', startLine: 10, startColumn: 4 },
                { severity: 'error', message: 'stub file diagnostic', code: 'stub_code' }
            ]
        });
        const storage = makeStorageWithModelSource(modelSource);

        await storage.loadSourceModelDocument({ options: {} }, sourceUri);
        await flush();

        // Diagnostic with an explicit uri lands at that file, 0-indexed line/column, Warning.
        const nodeDiagnostics = getDiagnostics(nodeFile);
        expect(nodeDiagnostics).toBeDefined();
        const nodeDiag = nodeDiagnostics!.find(d => d.message === 'stub node diagnostic')!;
        expect(nodeDiag).toBeDefined();
        expect(nodeDiag.severity).toBe(vscodeMock.DiagnosticSeverity.Warning);
        expect(nodeDiag.range.start.line).toBe(9); // line 10, 0-indexed
        expect(nodeDiag.range.start.character).toBe(3); // column 4, 0-indexed

        // Diagnostic without a uri defaults to the workflow file, carries its code, Error severity.
        const workflowDiagnostics = getDiagnostics(workflowFile);
        expect(workflowDiagnostics).toBeDefined();
        const fileDiag = workflowDiagnostics!.find(d => d.message === 'stub file diagnostic')!;
        expect(fileDiag).toBeDefined();
        expect(fileDiag.severity).toBe(vscodeMock.DiagnosticSeverity.Error);
        expect(fileDiag.code).toBe('stub_code');
    });

    it('returns the stub\'s getNodeIdentities result without touching a sidecar', async () => {
        const workflowFile = makeWorkflowFile('wf-iface-ids');
        const modelSource = makeStubModelSource({
            identities: [
                { instanceName: 'workerInstance', definitionName: 'WorkerType' },
                { instanceName: 'loneInstance' }
            ]
        });
        const storage = makeStorageWithModelSource(modelSource);

        const names: Set<string> | undefined = await (storage as any).getWorkflowNodeIdentities(workflowFile, 'RootFlow');

        expect(modelSource.getNodeIdentitiesCalls).toBe(1);
        expect(names).toBeDefined();
        expect([...names!].sort()).toEqual(['WorkerType', 'loneInstance', 'workerInstance']);
    });
});
