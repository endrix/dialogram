/**
 * Each nested workflow instance's edges show that instance's tokens.
 *
 * Two instances of one workflow (`a` and `b`, each holding `i`) wire the same
 * names, so the edge `p.Out --> Out` of one answers to the same signature as
 * the other's. The canvas took the token of whichever record came last, so
 * the view of `a/i` showed what `b/i` carried, and so did the node list's
 * rows. Each record of a nested instance now says the instance it is in
 * (`instancePath`), and a view reads its own instance's
 * records: the canvas the view's, the node list each row's.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { GEdge, GModelRoot } from '@eclipse-glsp/server';
import { WorkflowDiagramMetadata } from '@dialogram/shared';
import { WorkflowSourceModelStorage } from '../src/server/source-model-storage';
import { edgesOfInstance } from '../src/server/overlay-scope';

const tempDirs: string[] = [];
afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

const ENDS = { fromEntity: 'p', outPort: 'Out', toEntity: 'WF', inPort: 'Out' };

/** The run's final records, as the runtime writes them: both instances', and the top's. */
const SCOPED_EDGES = {
    'queue:a/i/p.Out-->WF.Out': { queueId: 'p.Out-->WF.Out', ...ENDS, instancePath: ['a', 'i'], lastToken: 'left' },
    'queue:b/i/p.Out-->WF.Out': { queueId: 'p.Out-->WF.Out', ...ENDS, instancePath: ['b', 'i'], lastToken: 'right' },
    'a/i/ast:7': { queueId: 'q.Out-->p.In', outPort: 'Out', inPort: 'In', instancePath: ['a', 'i'], lastToken: 'left-ast' },
    'b/i/ast:7': { queueId: 'q.Out-->p.In', outPort: 'Out', inPort: 'In', instancePath: ['b', 'i'], lastToken: 'right-ast' },
    'queue:left.Out-->a.In': { queueId: 'left.Out-->a.In', fromEntity: 'left', outPort: 'Out', toEntity: 'a', inPort: 'In', lastToken: 'left' }
};

/** The same run as a runtime that says no instance writes it: one record per local name, the last instance's. */
const UNSCOPED_EDGES = {
    'queue:p.Out-->WF.Out': { queueId: 'p.Out-->WF.Out', ...ENDS, lastToken: 'right' }
};

const TRAIL = (instance: 'a' | 'b') => [
    { sourceUri: 'file:///w/top.py', workflowName: 'top' },
    { sourceUri: 'file:///w/middle.py', workflowName: 'middle', workflowInstanceName: instance },
    { sourceUri: 'file:///w/inner.py', workflowName: 'inner', workflowInstanceName: 'i' }
];

/** A run's folder; with `trace`, a trace of one step, after which `a/i`'s queue holds one token and `b/i`'s none. */
async function runDir(trace: boolean): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nested-edge-tokens-'));
    tempDirs.push(dir);
    if (!trace) {
        return dir;
    }
    const queue = (instancePath: string[], size: number, token: string) => ({
        scope: 'inner', queueId: 'p.Out-->WF.Out', ...ENDS, instancePath, size, lastToken: token
    });
    await fs.writeFile(path.join(dir, 'run.wf-queues.json'), JSON.stringify({
        version: 1,
        steps: [{ step: 1, actorInstanceName: 'p', queueSizes: [queue(['a', 'i'], 1, 'left'), queue(['b', 'i'], 0, 'right')] }]
    }));
    return dir;
}

/** The view of `inner`: its edge to the boundary, and one found by its AST path. */
function model(): { root: GModelRoot; out: GEdge; byAst: GEdge } {
    const root = new GModelRoot();
    root.id = 'root';
    const out = new GEdge();
    out.id = 'out';
    out.args = { 'wf:from': 'p', 'wf:outPort': 'Out', 'wf:to': 'WF', 'wf:inPort': 'Out' };
    const byAst = new GEdge();
    byAst.id = 'byAst';
    byAst.args = { astPath: 'ast:7' };
    root.children = [out, byAst];
    return { root, out, byAst };
}

async function apply(edges: Record<string, unknown>, instance: 'a' | 'b', step?: number) {
    const dir = await runDir(step !== undefined);
    const storage: any = new (WorkflowSourceModelStorage as any)();
    storage.storageOptions = { settingsNamespace: 'wfLang', operationPrefix: 'wfpy' };
    storage.isLiveExecutionGlowEnabled = async () => true;
    storage.tryLoadLatestViewerOverlay = async () => ({ runId: 'r', outDir: dir, running: false, active: [], edges });
    storage.ensureModelSource = () => ({
        analysis: {
            buildOverlayAstPathCandidates: (args: any) => (args?.astPath ? [args.astPath] : []),
            buildOverlaySignatureCandidates: (e: any) => (e.fromEntity && e.toEntity
                ? [`${e.fromEntity}|${e.outPort}|${e.toEntity}|${e.inPort}`]
                : []),
            buildOverlayNodeIdentityCandidates: () => [],
            resolveOverlayActiveEntityName: () => undefined
        }
    });
    const m = model();
    const applied = await storage.applyViewerOverlayToEdges(
        m.root, '/w/inner.py', 'inner', TRAIL(instance), ['top', 'middle', 'inner'], step, true, ['/w/inner.py']
    );
    return { ...m, applied };
}

const token = (edge: GEdge) => (edge.args as any)?.[WorkflowDiagramMetadata.VIEWER_LAST_TOKEN];
const size = (edge: GEdge) => (edge.args as any)?.[WorkflowDiagramMetadata.QUEUE_SIZE];

describe('the edges of a nested workflow instance', () => {
    it('show what that instance carried, not what another instance of its workflow did', async () => {
        const a = await apply(SCOPED_EDGES, 'a');
        expect(token(a.out)).toBe('left');
        expect(token(a.byAst)).toBe('left-ast');

        const b = await apply(SCOPED_EDGES, 'b');
        expect(token(b.out)).toBe('right');
        expect(token(b.byAst)).toBe('right-ast');
    });

    it('show their own queue at a trace step', async () => {
        const a = await apply(SCOPED_EDGES, 'a', 0);
        expect(size(a.out)).toBe(1);
        expect(token(a.out)).toBe('left');

        const b = await apply(SCOPED_EDGES, 'b', 0);
        expect(size(b.out)).toBe(0);
        expect(token(b.out)).toBe('right');
    });

    it('give the node list each row\'s own instance\'s token, whichever view is open', async () => {
        const { applied } = await apply(SCOPED_EDGES, 'a');
        const args = { 'wf:from': 'p', 'wf:outPort': 'Out', 'wf:to': 'WF', 'wf:inPort': 'Out' };
        expect(applied.tokenOf(args, ['b', 'i'])).toEqual({ token: 'right' });
        expect(applied.tokenOf(args, ['a', 'i'])).toEqual({ token: 'left' });
        expect(applied.tokenOf(args)).toEqual({ token: 'left' });
        // The top's view has no such edge of its own.
        expect(applied.tokenOf(args, [])).toBeUndefined();
    });

    it('of a run whose records say no instance, show its records as before', async () => {
        const a = await apply(UNSCOPED_EDGES, 'a');
        expect(token(a.out)).toBe('right');
    });
});

describe('an instance\'s edge records', () => {
    it('are keyed as its own edges look them up: the instance path taken off the key', () => {
        expect(Object.keys(edgesOfInstance(SCOPED_EDGES, ['b', 'i']))).toEqual(['queue:p.Out-->WF.Out', 'ast:7']);
        expect(Object.keys(edgesOfInstance(SCOPED_EDGES, []))).toEqual(['queue:left.Out-->a.In']);
        expect(edgesOfInstance(UNSCOPED_EDGES, ['a', 'i'])).toBe(UNSCOPED_EDGES);
    });
});
