// Regression test for the Task 5 review finding: extracting sidecar/CLI graph acquisition into
// `SidecarCliModelSource` accidentally changed what `WorkflowSourceModelStorage#publishGraphDiagnostics`
// consumes on the calpy sidecar-success and static-sidecar-fallback paths. Those paths return
// `graphPayloadToDoc(...)`'s TRANSFORMED graph (nested `children[]` graphs folded away, node
// locations moved under `node.meta.source`) instead of the raw pre-transform payload the old
// (pre-extraction) code published diagnostics from. Three regressions this pins:
//
//   (a) a nested `children[]` child-graph's own diagnostics stopped being published at all
//       (the old `walk` recursed into `child.graph`; the transformed doc has no `children`);
//   (b) a node-level diagnostic's location moved from top-level `location` to `meta.source`, so
//       `collectElements`'s `el.location ?? el.source` finds nothing and the diagnostic gets
//       mis-attributed to the workflow file at line 1 instead of the node's real file/line/column;
//   (c) the synthetic hard-failure diagnostic's `code: 'graph_export_failed'` was dropped --
//       `createGraphExportFailureDoc`'s own `errors` field carries only `message`/`file`.
//
// Exercises the REAL fake-sidecar mechanism (test/fixtures/fake-sidecar.cjs, extended with a
// `FAKE_SIDECAR_DIAGNOSTICS=1` reply) through the storage's public `runtimeProfile` seam, mirroring
// characterization-graph-load.test.ts's approach -- so this pin keeps meaning across further
// refactors, same as that file.
//
// Also pins the F1 final-review finding: on the wfpy CLI-success path (and the plan-cache hit),
// `rawDiagnosticsPayload` is never set, so `loadPythonModel` falls back to publishing straight
// from `doc`. Pre-branch (see `a5e5833:.../workflow-diagram-glsp-module.ts` around the CLI-success
// and plan-cache-hit branches) that fallback published `doc.graph` ALONE -- doc-level `errors`
// (a sibling of `graph`, not `graph.errors`) never reached the Problems panel on those paths.
// Exercises the REAL fake-cli mechanism (test/fixtures/fake-cli.cjs, extended with a
// `FAKE_CLI_DOC_ERRORS=1` variant) the same way characterization-graph-load.test.ts does.
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
const FAKE_SIDECAR = path.join(FIXTURES, 'fake-sidecar.cjs');
const FAKE_CLI = path.join(FIXTURES, 'fake-cli.cjs');

const tempPaths: string[] = [];
const envKeys = [
    'FAKE_SIDECAR_LOG', 'FAKE_SIDECAR_FAIL', 'FAKE_SIDECAR_DIAGNOSTICS', 'FAKE_SIDECAR_DIAGNOSTICS_NODE_FILE',
    'FAKE_CLI_LOG', 'FAKE_CLI_DOC_ERRORS'
] as const;

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

function makeWorkflowFile(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
    tempPaths.push(dir);
    const file = path.join(dir, 'pipeline.py');
    fs.writeFileSync(file, '# diagnostics-parity fixture workflow stub\n', 'utf8');
    return file;
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

/**
 * Stubs the overlay/history/agent side-channels `finishLoadFromDoc` calls after building the
 * GModel root -- unrelated to diagnostics publishing, cribbed from
 * characterization-graph-load.test.ts's identical stub set.
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

const FIXTURE_OP_KINDS = { createEntityPort: 'op.createEntityPort', deleteEntityPort: 'op.deleteEntityPort' };

function makeCalpyStorage(): any {
    return makeStorage({
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
        graphAcquisition: 'sidecar-export'
    });
}

function makeWfpyStorage(): any {
    return makeStorage({
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
    });
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

describe('diagnostics parity: raw sidecar/fallback payload reaches publishGraphDiagnostics', () => {
    it('publishes the node-level diagnostic at the node\'s real file/line/column, and publishes the nested child-graph diagnostic', async () => {
        const workflowFile = makeWorkflowFile('wf-diag-calpy');
        const sourceUri = `file://${workflowFile}`;
        const nodeSourceFile = path.join(path.dirname(workflowFile), 'node-source.py');
        process.env.FAKE_SIDECAR_DIAGNOSTICS = '1';
        process.env.FAKE_SIDECAR_DIAGNOSTICS_NODE_FILE = nodeSourceFile;

        const storage = makeCalpyStorage();
        await storage.loadSourceModelDocument({ options: {} }, sourceUri);
        await flush();

        // (b) node-level diagnostic lands at the node's real file/line/column -- NOT
        // workflowFile:1. The fake sidecar's node carries `location: {file: nodeSourceFile,
        // line: 42, column: 7}`; publishGraphDiagnostics 0-indexes line/column for vscode.Range.
        const nodeDiagnostics = getDiagnostics(nodeSourceFile);
        expect(nodeDiagnostics).toBeDefined();
        expect(nodeDiagnostics).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    message: 'node-level diagnostic',
                    severity: vscodeMock.DiagnosticSeverity.Warning
                })
            ])
        );
        const nodeDiagnostic = nodeDiagnostics!.find(d => d.message === 'node-level diagnostic')!;
        expect(nodeDiagnostic.range.start.line).toBe(41); // line 42, 0-indexed
        expect(nodeDiagnostic.range.start.character).toBe(6); // column 7, 0-indexed

        // Regression guard: the diagnostic must NOT have been mis-attributed to the workflow
        // file at line 1 (the bug this test pins).
        const workflowFileDiagnosticsWrongly = getDiagnostics(workflowFile)?.filter(d => d.message === 'node-level diagnostic') ?? [];
        expect(workflowFileDiagnosticsWrongly).toHaveLength(0);

        // (a) the nested `children[]` child-graph's own diagnostic IS published. The child node
        // has no `location`, so it falls back to the workflow file.
        const workflowFileDiagnostics = getDiagnostics(workflowFile);
        expect(workflowFileDiagnostics).toBeDefined();
        expect(workflowFileDiagnostics).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    message: 'nested child-graph diagnostic',
                    severity: vscodeMock.DiagnosticSeverity.Error
                })
            ])
        );
    });

    it('publishes a diagnostic with code "graph_export_failed" on sidecar hard failure', async () => {
        const workflowFile = makeWorkflowFile('wf-diag-hard-failure');
        const sourceUri = `file://${workflowFile}`;
        process.env.FAKE_SIDECAR_FAIL = '1';

        const storage = makeCalpyStorage();
        await storage.loadSourceModelDocument({ options: {} }, sourceUri);
        await flush();

        const diagnostics = getDiagnostics(workflowFile);
        expect(diagnostics).toBeDefined();
        expect(diagnostics).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ code: 'graph_export_failed' })
            ])
        );
    });
});

describe('diagnostics parity (F1): wfpy CLI-success path never leaks doc-level errors', () => {
    it('does not publish doc-level `errors` as diagnostics on a successful CLI plan, while nodes still render', async () => {
        const workflowFile = makeWorkflowFile('wf-diag-cli-doc-errors');
        const sourceUri = `file://${workflowFile}`;
        process.env.FAKE_CLI_DOC_ERRORS = '1';

        const storage = makeWfpyStorage();
        await storage.loadSourceModelDocument({ options: {} }, sourceUri);
        await flush();

        // The load still succeeds and the fixture's nodes reach the model root.
        const root = storage.modelState.root;
        expect(root).toBeDefined();
        expect(collectIds(root)).toEqual(expect.arrayContaining(['n1', 'n2', 'e1']));

        // PIN (F1): pre-branch, the wfpy CLI-success path published `doc.graph` ALONE --
        // doc-level `errors` (a sibling of `graph`, not `graph.errors`) never reached the
        // Problems panel here. The fixture's doc-level error names a file that never appears in
        // `graph.nodes`/`graph.edges`, so it must produce NO diagnostics anywhere.
        const docLevelErrorFile = '/tmp/doc-level-error-source.py';
        const leaked = getDiagnostics(docLevelErrorFile) ?? [];
        expect(leaked).toHaveLength(0);
        const workflowFileDiagnostics = getDiagnostics(workflowFile) ?? [];
        expect(workflowFileDiagnostics.filter(d => d.message.includes('doc-level error'))).toHaveLength(0);
    });
});
