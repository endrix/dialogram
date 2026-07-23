// Tests for the cold-load deferral of agent-enrichment discovery (skill status on nodes + the
// skills/Claude-agents picker snapshots on the root).
//
// The expensive tail of a first diagram open was three directory scans over `.claude`/`.wf` skill &
// agent roots — directories BEYOND the run-output dirs. Under host-boot contention their many small
// readdir/readFile awaits inflated to seconds (live evidence: a restored tab spent ~21s here). None
// feed first-paint geometry or the execution glow, so these tests pin the new behavior: on a COLD
// cache the first model renders WITHOUT the enrichment and one background discovery delivers it
// through exactly one model refresh whose (now warm-cache) reload applies it synchronously; on a
// WARM cache it is applied synchronously with no background work; empty discovery dispatches nothing.
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { RequestModelAction } from '@eclipse-glsp/protocol';
import { GModelRoot, GNode } from '@eclipse-glsp/server';
import { WorkflowDiagramMetadata } from '@dialogram/shared';
import { WorkflowSourceModelStorage } from '@dialogram/diagram-server/server/diagram-glsp-module';
import { SidecarModelSource, type SidecarRuntimeConfig } from '../src/index';
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

/** ModelState stub exposing the writable `root` getter that `isModelStillCurrentForSource` reads. */
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

/**
 * Stub the run-output overlays (they read run-output dirs and are irrelevant here) and the caller
 * side (empty → no caller refresh), but keep the REAL `applyAgentEnrichment` under test. The three
 * enrichment discovery seams are stubbed so the machinery is exercised without touching real
 * `.claude` roots.
 */
function wireStorage(storage: Record<string, unknown>): void {
    storage.applyViewerOverlayToEdges = async () => undefined;
    storage.applyAgentContextToNodes = async () => undefined;
    storage.attachWorkflowRunHistory = async () => undefined;
    storage.getWorkflowRelationshipInfo = async () => ({ workflowNames: ['child'], entryWorkflowNames: [], callersByWorkflow: {} });
    storage.getWorkflowCallerScanRoots = async () => [];
    storage.discoverSkillStatuses = async (_root: string, names: string[]) => new Map(names.map(n => [n, `status:${n}`]));
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

function newStorage(): Record<string, unknown> {
    const storage = new (WorkflowSourceModelStorage as any)();
    storage.injectedModelSource = new SidecarModelSource(testCfg());
    storage.storageOptions = { settingsNamespace: 'wfLang', operationPrefix: 'wfpy' };
    storage.modelState = makeModelStateStub();
    storage.layoutPersistence = { loadLayout: async () => undefined, loadEdgeRoutes: async () => undefined };
    wireStorage(storage);
    return storage;
}

describe('agent-enrichment deferral (cold load) and warm-cache parity', () => {
    it('cold load renders without enrichment, then one background refresh reloads it with the data', async () => {
        const root = await mkTempDir('wf-lang-enrich-cold-');
        const workflowFile = path.join(root, 'child.py');
        await writeFile(workflowFile, '# child workflow stub\n');
        const sourceUri = `file://${workflowFile}`;
        const doc = makeDoc();

        const storage = newStorage();
        const skills = [{ name: 'alpha', root, skillDir: `${root}/alpha`, skillMdPath: `${root}/alpha/SKILL.md`, hasSkillMd: true, hooks: [] }];
        const agents = [{ name: 'beta', path: `${root}/beta.md` }];
        storage.discoverAgentSkillsSnapshot = async () => skills;
        storage.discoverClaudeAgentsSnapshot = async () => agents;

        const dispatched: RequestModelAction[] = [];
        let refreshReload: Promise<void> | undefined;
        storage.actionDispatcher = {
            dispatch: (action: RequestModelAction) => {
                dispatched.push(action);
                refreshReload = (storage as any).finishLoadFromDoc(doc, sourceUri, workflowFile, { networkName: 'child' });
                return refreshReload;
            }
        };

        await (storage as any).finishLoadFromDoc(doc, sourceUri, workflowFile, { networkName: 'child' });

        // Cold first render: enrichment args absent, discovery deferred.
        const coldRoot = (storage as any).modelState.root as { args?: Record<string, unknown> };
        expect(coldRoot.args?.['wf:agentSkillsSnapshot']).toBeUndefined();
        expect(coldRoot.args?.['wf:claudeAgentsSnapshot']).toBeUndefined();
        expect((storage as any).deferredAgentEnrichment).toBeDefined();

        await (storage as any).deferredAgentEnrichment;
        await refreshReload;

        // Exactly one refresh, addressed to this diagram, using the enrichment request-id prefix.
        expect(dispatched).toHaveLength(1);
        expect(dispatched[0].kind).toBe(RequestModelAction.KIND);
        expect(String(dispatched[0].requestId)).toMatch(/^refresh-agent-enrichment-/);
        expect(dispatched[0].options?.sourceUri).toBe(sourceUri);

        // The refresh's warm-cache reload now carries both snapshots.
        const warmRoot = (storage as any).modelState.root as { args?: Record<string, unknown> };
        expect(warmRoot.args?.['wf:agentSkillsSnapshot']).toBe(JSON.stringify(skills));
        expect(warmRoot.args?.['wf:claudeAgentsSnapshot']).toBe(JSON.stringify(agents));
    });

    it('does not refresh when the deferred discovery finds nothing', async () => {
        const root = await mkTempDir('wf-lang-enrich-empty-');
        const workflowFile = path.join(root, 'child.py');
        await writeFile(workflowFile, '# child workflow stub\n');
        const sourceUri = `file://${workflowFile}`;

        const storage = newStorage();
        storage.discoverAgentSkillsSnapshot = async () => [];
        storage.discoverClaudeAgentsSnapshot = async () => [];

        const dispatched: RequestModelAction[] = [];
        storage.actionDispatcher = { dispatch: async (a: RequestModelAction) => { dispatched.push(a); } };

        await (storage as any).finishLoadFromDoc(makeDoc(), sourceUri, workflowFile, { networkName: 'child' });
        await (storage as any).deferredAgentEnrichment;

        expect(dispatched).toHaveLength(0);
    });

    it('warm cache applies enrichment synchronously and schedules no background work', async () => {
        const root = await mkTempDir('wf-lang-enrich-warm-');
        const workflowFile = path.join(root, 'child.py');
        await writeFile(workflowFile, '# child workflow stub\n');
        const sourceUri = `file://${workflowFile}`;

        const storage = newStorage();
        // Spy the discovery seams so we can assert the warm path performs NO discovery I/O.
        const skillsSpy = vi.fn(async () => [{ name: 'alpha', root, skillDir: '', skillMdPath: '', hasSkillMd: true, hooks: [] }]);
        const agentsSpy = vi.fn(async () => [{ name: 'beta', path: '' }]);
        storage.discoverAgentSkillsSnapshot = skillsSpy;
        storage.discoverClaudeAgentsSnapshot = agentsSpy;

        const dispatched: RequestModelAction[] = [];
        storage.actionDispatcher = { dispatch: async (a: RequestModelAction) => { dispatched.push(a); } };

        // Pre-warm the cache the same way the deferred discovery would.
        const runtimeRoot = path.dirname(workflowFile);
        const skills = [{ name: 'alpha', root, skillDir: '', skillMdPath: '', hasSkillMd: true, hooks: [] }];
        const agents = [{ name: 'beta', path: '' }];
        (storage as any).storeAgentEnrichment(runtimeRoot, { skills, agents, skillStatusByName: new Map<string, string>() });

        await (storage as any).finishLoadFromDoc(makeDoc(), sourceUri, workflowFile, { networkName: 'child' });

        const warmRoot = (storage as any).modelState.root as { args?: Record<string, unknown> };
        expect(warmRoot.args?.['wf:agentSkillsSnapshot']).toBe(JSON.stringify(skills));
        expect(warmRoot.args?.['wf:claudeAgentsSnapshot']).toBe(JSON.stringify(agents));
        // Fully synchronous: no discovery, no deferral, no refresh.
        expect(skillsSpy).not.toHaveBeenCalled();
        expect(agentsSpy).not.toHaveBeenCalled();
        expect((storage as any).deferredAgentEnrichment).toBeUndefined();
        expect(dispatched).toHaveLength(0);
    });
});

describe('agent-enrichment skill-status warm apply and subset guard', () => {
    it('applies cached skill status to configured nodes and clears it on the rest', () => {
        const storage = newStorage();
        const skillNode = new GNode();
        skillNode.id = 'n-skill';
        skillNode.args = { 'wf:agentSpec': { skill: 'alpha' } };
        const plainNode = new GNode();
        plainNode.id = 'n-plain';
        plainNode.args = { [WorkflowDiagramMetadata.AGENT_SKILL_STATUS]: 'stale-should-clear' };
        const root = new GModelRoot();
        root.children = [skillNode, plainNode];

        (storage as any).applyAgentSkillStatusFromCache(root, new Map([['alpha', 'status:alpha']]));

        expect((skillNode.args as Record<string, unknown>)[WorkflowDiagramMetadata.AGENT_SKILL_STATUS]).toBe('status:alpha');
        expect((plainNode.args as Record<string, unknown>)[WorkflowDiagramMetadata.AGENT_SKILL_STATUS]).toBeUndefined();
    });

    it('treats a graph needing an uncached skill as a cold miss (subset guard)', () => {
        const storage = newStorage();
        const runtimeRoot = '/some/runtime/root';
        (storage as any).storeAgentEnrichment(runtimeRoot, {
            skills: [],
            agents: [],
            skillStatusByName: new Map([['alpha', 'status:alpha']])
        });

        // Needed skill present → warm hit.
        expect((storage as any).peekAgentEnrichment(runtimeRoot, ['alpha'])).toBeDefined();
        // Needed skill absent → cold miss even though the bundle is fresh.
        expect((storage as any).peekAgentEnrichment(runtimeRoot, ['gamma'])).toBeUndefined();
    });
});
