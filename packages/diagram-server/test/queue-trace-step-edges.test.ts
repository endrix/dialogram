/**
 * Stepping back through a run's queue trace changes the edges.
 *
 * An edge that carried a token is drawn in the carried colour. It used to take
 * that token from the run's final overlay at every step, so after a run every
 * carried edge stayed coloured however far back the stepper went: going back
 * changed the step counter and nothing else. At a step, an edge the trace
 * knows is now drawn as it was then -- with no token if none had reached it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { GEdge, GModelRoot, GNode } from '@eclipse-glsp/server';
import { WorkflowDiagramMetadata } from '@dialogram/shared';
import { WorkflowSourceModelStorage } from '../src/server/source-model-storage';

const tempDirs: string[] = [];
afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

const TOKEN = (name: string) => `/run/work/edge-tokens/${name}.json`;

/** A run of c -> d -> output: its final overlay and a trace of three steps. */
async function runDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-step-edges-'));
    tempDirs.push(dir);
    const queue = (astPath: string, size: number, token?: string) => ({
        scope: 'flow',
        queueId: astPath,
        overlayAstPath: astPath,
        size,
        ...(token ? { lastToken: token } : {})
    });
    await fs.writeFile(path.join(dir, 'run.wf-queues.json'), JSON.stringify({
        version: 1,
        steps: [
            // Step 1: c fired; nothing has reached the output.
            { step: 1, actorInstanceName: 'c', queueSizes: [queue('cd', 1, TOKEN('cd')), queue('out', 0)] },
            // Step 2: d fired.
            { step: 2, actorInstanceName: 'd', queueSizes: [queue('cd', 0, TOKEN('cd')), queue('out', 1, TOKEN('out'))] }
        ]
    }));
    return dir;
}

function model(): { root: GModelRoot; cd: GEdge; out: GEdge; d: GNode } {
    const root = new GModelRoot();
    root.id = 'root';
    const edge = (id: string): GEdge => {
        const e = new GEdge();
        e.id = id;
        e.args = { astPath: id };
        return e;
    };
    const cd = edge('cd');
    const out = edge('out');
    const d = new GNode();
    d.id = 'd';
    d.args = { name: 'd' };
    root.children = [cd, out, d];
    return { root, cd, out, d };
}

async function applyAt(step: number | undefined, error?: string) {
    const dir = await runDir();
    const storage: any = new (WorkflowSourceModelStorage as any)();
    storage.storageOptions = { settingsNamespace: 'wfLang', operationPrefix: 'wfpy' };
    storage.isLiveExecutionGlowEnabled = async () => true;
    storage.tryLoadLatestViewerOverlay = async () => ({
        runId: 'r',
        outDir: dir,
        running: false,
        active: [],
        // The end of the run: both edges carried a token.
        edges: { cd: { lastToken: TOKEN('cd') }, out: { lastToken: TOKEN('out') } },
        ...(error ? { error: { entityInstanceName: error } } : {})
    });
    storage.ensureModelSource = () => ({
        analysis: {
            buildOverlayAstPathCandidates: (args: any) => (args?.astPath ? [args.astPath] : []),
            buildOverlaySignatureCandidates: () => [],
            buildOverlayNodeIdentityCandidates: (args: any) => (args?.name ? [args.name] : []),
            resolveOverlayActiveEntityName: () => undefined
        }
    });
    const m = model();
    await storage.applyViewerOverlayToEdges(m.root, '/w/flow.py', 'flow', [], ['flow'], step, true, ['/w/flow.py']);
    return m;
}

const token = (edge: GEdge) => (edge.args as any)?.[WorkflowDiagramMetadata.VIEWER_LAST_TOKEN];
const size = (edge: GEdge) => (edge.args as any)?.[WorkflowDiagramMetadata.QUEUE_SIZE];

describe('the edges at a step of the queue trace', () => {
    it('are drawn as they were then: no token where none had arrived', async () => {
        const { cd, out } = await applyAt(0);

        expect(token(cd)).toBe(TOKEN('cd'));
        expect(size(cd)).toBe(1);
        // The run's final overlay has a token here; at step 1 it had not come.
        expect(token(out)).toBeUndefined();
        expect(size(out)).toBe(0);
    });

    it('carry what reached them by the last step', async () => {
        const { cd, out } = await applyAt(1);

        expect(token(cd)).toBe(TOKEN('cd'));
        expect(token(out)).toBe(TOKEN('out'));
        expect(size(out)).toBe(1);
    });

    it('show the failed node only at the last step, after which it failed', async () => {
        const early = await applyAt(0, 'd');
        expect((early.d.args as any)?.[WorkflowDiagramMetadata.IS_ERRORED]).toBeUndefined();

        const last = await applyAt(1, 'd');
        expect((last.d.args as any)?.[WorkflowDiagramMetadata.IS_ERRORED]).toBe(true);
    });
});
