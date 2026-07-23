// Tests for the cold-load deferral of caller-reference ("Used By" breadcrumb) discovery.
//
// The expensive part of a first diagram open in a large tree was the synchronous walk of every
// source file under the scan roots to find which workflows call the open one. These tests pin the
// new behavior: on a COLD caller-reference cache the first model renders WITHOUT the references and
// discovery runs in the background, delivering the result through exactly one model refresh whose
// (now warm-cache) reload includes it; on a WARM cache the references are included synchronously,
// exactly as before. Also covers the bounded directory walk (excluded dirs + file-count ceiling).
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { RequestModelAction } from '@eclipse-glsp/protocol';
import { WorkflowSourceModelStorage } from '@dialogram/diagram-server/server/diagram-glsp-module';
import { SidecarModelSource, type SidecarRuntimeConfig } from '../src/index';
import { collectPythonFilesUnderRoots, MAX_SOURCE_FILES_PER_SCAN } from '../src/server/source-analysis';
import { NEUTRAL_CREATE_NODE_CONFIG } from './fixtures/create-node-config';

function testCfg(overrides: Partial<SidecarRuntimeConfig> = {}): SidecarRuntimeConfig {
    return {
        settingsNamespace: 'wfLang',
        sidecarOperationPrefix: 'wfpy',
        sidecarCommandSettingKey: 'wfpySidecarCommand',
        sidecarCommandDefault: 'wfpy-sidecar',
        cliCommandSettingKey: 'wfpyCommand',
        cliCommandDefault: 'wfpy',
        cliPythonModule: undefined,
        operationKinds: { createEntityPort: 'op.createEntityPort', deleteEntityPort: 'op.deleteEntityPort' },
        acceptedOperationPrefixes: ['wfpy', 'calpy'],
        graphAcquisition: 'cli-plan',
        cliGraphArgs: (file: string) => ['plan', file, '--format', 'graph', '--best-effort'],
        ...NEUTRAL_CREATE_NODE_CONFIG,
        ...overrides
    };
}

const tempDirs: string[] = [];

async function mkTempDir(prefix: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

async function writeFile(filePath: string, content = ''): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf-8');
}

afterEach(async () => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

/** ModelState stub exposing the writable `root` getter that `isModelStillCurrent` reads. */
function makeModelStateStub(): { set: () => void; get: () => undefined; updateRoot: (r: unknown) => void; root: unknown } {
    let root: unknown;
    return {
        set: () => undefined,
        get: () => undefined,
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
}

/** Minimal doc for `finishLoadFromDoc` — one workflow node, no edges. */
function makeDoc(): unknown {
    return {
        version: '1',
        graph: {
            id: 'wf:child',
            nodes: [{ id: 'node:child', kind: 'workflow', label: 'child', scope: 'scope:root', ports: [] }],
            edges: [],
            subgraphs: []
        }
    };
}

describe('caller-reference deferral (cold load) and warm-cache parity', () => {
    it('cold load renders without caller data, then one background refresh reloads it with the data', async () => {
        const root = await mkTempDir('wf-lang-caller-defer-cold-');
        const workflowFile = path.join(root, 'child.py');
        await writeFile(workflowFile, '# child workflow stub\n');
        const sourceUri = `file://${workflowFile}`;
        const doc = makeDoc();

        const storage = new (WorkflowSourceModelStorage as any)();
        storage.injectedModelSource = new SidecarModelSource(testCfg());
        storage.storageOptions = { settingsNamespace: 'wfLang', operationPrefix: 'wfpy' };
        storage.modelState = makeModelStateStub();
        storage.layoutPersistence = { loadLayout: async () => undefined, loadEdgeRoutes: async () => undefined };
        stubOverlaySideChannels(storage);
        // Keep the (real) getWorkflowCallerReferences → it warms the internal cache. Feed it a
        // same-file caller via relationship info and no scan roots, so the walk is skipped but the
        // result is non-empty — exercising the cache/loop-guard exactly as production does.
        storage.getWorkflowRelationshipInfo = async () => ({
            workflowNames: ['child'],
            entryWorkflowNames: [],
            callersByWorkflow: { child: ['main'] }
        });
        storage.getWorkflowCallerScanRoots = async () => [];

        const dispatched: RequestModelAction[] = [];
        // The refresh dispatch is fire-and-forget in production; capture the reload promise so the
        // test can await it deterministically.
        let refreshReload: Promise<void> | undefined;
        storage.actionDispatcher = {
            dispatch: (action: RequestModelAction) => {
                dispatched.push(action);
                // Simulate the reload the WorkflowRequestModelActionHandler performs for this refresh.
                refreshReload = storage.finishLoadFromDoc(doc, sourceUri, workflowFile, { networkName: 'child' });
                return refreshReload;
            }
        };

        await storage.finishLoadFromDoc(doc, sourceUri, workflowFile, { networkName: 'child' });

        // Cold first render: caller data is absent, discovery was deferred.
        const coldRoot = storage.modelState.root as { args?: Record<string, unknown> };
        expect(coldRoot.args?.['wf:parentWorkflows']).toBeUndefined();
        expect(storage.deferredCallerDiscovery).toBeDefined();

        await storage.deferredCallerDiscovery;
        await refreshReload;

        // Exactly one refresh, addressed to this diagram, using the polling-refresh request id.
        expect(dispatched).toHaveLength(1);
        expect(dispatched[0].kind).toBe(RequestModelAction.KIND);
        expect(String(dispatched[0].requestId)).toMatch(/^refresh-caller-refs-/);
        expect(dispatched[0].options?.sourceUri).toBe(sourceUri);

        // The refresh's warm-cache reload now carries the caller data.
        const warmRoot = storage.modelState.root as { args?: Record<string, unknown> };
        expect(warmRoot.args?.['wf:parentWorkflows']).toEqual([{ sourceUri, workflowName: 'main' }]);
    });

    it('does not refresh when the deferred discovery finds no callers', async () => {
        const root = await mkTempDir('wf-lang-caller-defer-empty-');
        const workflowFile = path.join(root, 'child.py');
        await writeFile(workflowFile, '# child workflow stub\n');
        const sourceUri = `file://${workflowFile}`;

        const storage = new (WorkflowSourceModelStorage as any)();
        storage.injectedModelSource = new SidecarModelSource(testCfg());
        storage.storageOptions = { settingsNamespace: 'wfLang', operationPrefix: 'wfpy' };
        storage.modelState = makeModelStateStub();
        storage.layoutPersistence = { loadLayout: async () => undefined, loadEdgeRoutes: async () => undefined };
        stubOverlaySideChannels(storage);
        storage.getWorkflowRelationshipInfo = async () => ({ workflowNames: ['child'], entryWorkflowNames: [], callersByWorkflow: {} });
        storage.getWorkflowCallerScanRoots = async () => [];

        const dispatched: RequestModelAction[] = [];
        storage.actionDispatcher = { dispatch: async (a: RequestModelAction) => { dispatched.push(a); } };

        await storage.finishLoadFromDoc(makeDoc(), sourceUri, workflowFile, { networkName: 'child' });
        await storage.deferredCallerDiscovery;

        expect(dispatched).toHaveLength(0);
    });

    it('warm cache includes caller data synchronously and schedules no background work', async () => {
        const root = await mkTempDir('wf-lang-caller-warm-');
        const workflowFile = path.join(root, 'child.py');
        await writeFile(workflowFile, '# child workflow stub\n');
        const sourceUri = `file://${workflowFile}`;

        const storage = new (WorkflowSourceModelStorage as any)();
        storage.injectedModelSource = new SidecarModelSource(testCfg());
        storage.storageOptions = { settingsNamespace: 'wfLang', operationPrefix: 'wfpy' };
        storage.modelState = makeModelStateStub();
        storage.layoutPersistence = { loadLayout: async () => undefined, loadEdgeRoutes: async () => undefined };
        stubOverlaySideChannels(storage);
        storage.getWorkflowRelationshipInfo = async () => ({ workflowNames: ['child'], entryWorkflowNames: [], callersByWorkflow: {} });

        const dispatched: RequestModelAction[] = [];
        storage.actionDispatcher = { dispatch: async (a: RequestModelAction) => { dispatched.push(a); } };

        // Pre-warm the cache the same way discovery would.
        const cacheKey = `${path.resolve(workflowFile)}::child`;
        const references = [{ sourceUri, workflowName: 'main' }];
        storage.storeCallerReferences(cacheKey, references);

        await storage.finishLoadFromDoc(makeDoc(), sourceUri, workflowFile, { networkName: 'child' });

        const warmRoot = storage.modelState.root as { args?: Record<string, unknown> };
        expect(warmRoot.args?.['wf:parentWorkflows']).toEqual(references);
        // Warm path is fully synchronous: no deferral, no refresh.
        expect(storage.deferredCallerDiscovery).toBeUndefined();
        expect(dispatched).toHaveLength(0);
    });
});

describe('bounded caller-reference source walk', () => {
    it('skips vendored, dot, and cache directories but collects first-party .py files', async () => {
        const root = await mkTempDir('wf-lang-walk-bounds-');
        const target = path.join(root, 'pkg', 'child.py');
        const realA = path.join(root, 'pkg', 'parent.py');
        const realB = path.join(root, 'pkg', 'sub', 'other.py');
        await writeFile(target, '# target\n');
        await writeFile(realA, '# real a\n');
        await writeFile(realB, '# real b\n');
        // Excluded: named vendor/cache dirs and any dotdir.
        await writeFile(path.join(root, 'node_modules', 'dep.py'), '# vendored\n');
        await writeFile(path.join(root, '__pycache__', 'cache.py'), '# cache\n');
        await writeFile(path.join(root, '.git', 'hook.py'), '# hidden\n');
        await writeFile(path.join(root, '.venv', 'lib', 'x.py'), '# hidden venv\n');

        const files = await collectPythonFilesUnderRoots([root], target);

        expect(files.sort()).toEqual([path.resolve(realA), path.resolve(realB)].sort());
        expect(files).not.toContain(path.resolve(target));
        expect(files.some(f => f.includes('node_modules') || f.includes('__pycache__') || f.includes('.git') || f.includes('.venv'))).toBe(false);
    });

    it('stops at the file-count ceiling and warns once naming the root', async () => {
        const root = await mkTempDir('wf-lang-walk-ceiling-');
        const target = path.join(root, 'target.py');
        await writeFile(target, '# target\n');
        for (let i = 0; i < 5; i++) {
            await writeFile(path.join(root, `f${i}.py`), '# f\n');
        }
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        const files = await collectPythonFilesUnderRoots([root], target, 3);

        expect(files).toHaveLength(3);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(String(warnSpy.mock.calls[0][0])).toContain('3-file ceiling');
        expect(String(warnSpy.mock.calls[0][0])).toContain(path.resolve(root));
    });

    it('exports a sane production ceiling', () => {
        expect(MAX_SOURCE_FILES_PER_SCAN).toBe(2000);
    });
});
