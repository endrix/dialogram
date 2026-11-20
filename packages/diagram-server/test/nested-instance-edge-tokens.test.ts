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
import { WorkflowDiagramMetadata, trailInstancePath } from '@dialogram/shared';
import { WorkflowSourceModelStorage } from '../src/server/source-model-storage';
import { edgesOfInstance, fromRunRoot, runRootPrefix } from '../src/server/overlay-scope';

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

type Crumb = { sourceUri: string; workflowName: string; workflowInstanceName?: string };

/**
 * The view at the end of `trail` (by default `top` > `middle` as `instance` > `inner` as `i`),
 * with the run's records `edges`; `run` adds to what the run's overlay says (its root's file and
 * workflow), `trace` replaces the one-step trace.
 */
async function apply(
    edges: Record<string, unknown>,
    instance: 'a' | 'b',
    step?: number,
    opts: { trail?: Crumb[]; run?: Record<string, unknown>; trace?: unknown[] } = {}
) {
    const dir = await runDir(step !== undefined);
    if (opts.trace) {
        await fs.writeFile(path.join(dir, 'run.wf-queues.json'), JSON.stringify({
            version: 1,
            steps: [{ step: 1, actorInstanceName: 'p', queueSizes: opts.trace }]
        }));
    }
    const storage: any = new (WorkflowSourceModelStorage as any)();
    storage.storageOptions = { settingsNamespace: 'wfLang', operationPrefix: 'wfpy' };
    storage.isLiveExecutionGlowEnabled = async () => true;
    storage.tryLoadLatestViewerOverlay = async () => ({ runId: 'r', outDir: dir, running: false, active: [], edges, ...opts.run });
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
        m.root, '/w/inner.py', 'inner', opts.trail ?? TRAIL(instance), ['top', 'middle', 'inner'], step, true, ['/w/inner.py']
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

const ARGS = { 'wf:from': 'p', 'wf:outPort': 'Out', 'wf:to': 'WF', 'wf:inPort': 'Out' };

describe('a run whose root is not the trail\'s root', () => {
    // `middle` run on its own: its records count from `middle`, so `a/i` is `i` there.
    const MIDDLE_RUN = { sourcePath: '/w/middle.py', workflowName: 'middle' };
    const MIDDLE_EDGES = {
        'queue:i/p.Out-->WF.Out': { queueId: 'p.Out-->WF.Out', ...ENDS, instancePath: ['i'], lastToken: 'own' }
    };

    it('shows its records in the view of an instance under it, measured from the run\'s root', async () => {
        const a = await apply(MIDDLE_EDGES, 'a', undefined, { run: MIDDLE_RUN });
        expect(token(a.out)).toBe('own');
    });

    it('gives the node list only the rows under the run\'s root, measured from it', async () => {
        const { applied } = await apply(MIDDLE_EDGES, 'a', undefined, { run: MIDDLE_RUN });
        expect(applied.tokenOf(ARGS, ['a', 'i'])).toEqual({ token: 'own' });
        expect(applied.tokenOf(ARGS)).toEqual({ token: 'own' });
        // `b` is another instance of `middle`, which this run did not run.
        expect(applied.tokenOf(ARGS, ['b', 'i'])).toBeUndefined();
    });

    it('is read from the trail\'s root when no crumb is its root, as before', async () => {
        const a = await apply(SCOPED_EDGES, 'a', undefined, { run: { sourcePath: '/elsewhere/top.py', workflowName: 'top' } });
        expect(token(a.out)).toBe('left');
    });
});

describe('a crumb that names no instance', () => {
    // Drilled into `middle` without an instance name: the view and the hierarchy both take its workflow's name.
    const trail: Crumb[] = [
        { sourceUri: 'file:///w/top.py', workflowName: 'top' },
        { sourceUri: 'file:///w/middle.py', workflowName: 'middle' },
        { sourceUri: 'file:///w/inner.py', workflowName: 'inner', workflowInstanceName: 'i' }
    ];
    const EDGES = {
        'queue:middle/i/p.Out-->WF.Out': { queueId: 'p.Out-->WF.Out', ...ENDS, instancePath: ['middle', 'i'], lastToken: 'by-name' },
        'queue:a/i/p.Out-->WF.Out': { queueId: 'p.Out-->WF.Out', ...ENDS, instancePath: ['a', 'i'], lastToken: 'left' }
    };

    it('puts the canvas and the node list on the same instance', async () => {
        const view = await apply(EDGES, 'a', undefined, { trail });
        expect(token(view.out)).toBe('by-name');
        expect(view.applied.tokenOf(ARGS)).toEqual(view.applied.tokenOf(ARGS, ['middle', 'i']));
    });
});

describe('a run that says its instances in one of its two files', () => {
    it('reads the other by instance too', async () => {
        // Only the trace says instances; the final records are the top's own.
        const topOnly = {
            'queue:p.Out-->WF.Out': { queueId: 'p.Out-->WF.Out', ...ENDS, lastToken: 'top' }
        };
        const queue = (instancePath: string[] | undefined, size: number, lastToken: string) => ({
            queueId: 'p.Out-->WF.Out', ...ENDS, ...(instancePath ? { instancePath } : {}), size, lastToken
        });
        // The top's queue comes last, and with the same ends would win if the trace were read whole.
        const a = await apply(topOnly, 'a', 0, { trace: [queue(['a', 'i'], 3, 'a-t'), queue(undefined, 9, 'top-t')] });
        expect(size(a.out)).toBe(3);
        expect(token(a.out)).toBe('a-t');

        // A trace that knows another of `a/i`'s queues: this edge falls back to the final records,
        // where the top's own record, with the same ends, is not `a/i`'s.
        const other = { queueId: 'q.Out-->p.In', fromEntity: 'q', outPort: 'Out', toEntity: 'p', inPort: 'In', instancePath: ['a', 'i'], size: 1, lastToken: 'q' };
        const fallback = await apply(topOnly, 'a', 0, { trace: [other] });
        expect(token(fallback.out)).toBeUndefined();
    });
});

describe('an instance\'s edge records', () => {
    it('are keyed as its own edges look them up: the instance path taken off the key', () => {
        expect(Object.keys(edgesOfInstance(SCOPED_EDGES, ['b', 'i']))).toEqual(['queue:p.Out-->WF.Out', 'ast:7']);
        expect(Object.keys(edgesOfInstance(SCOPED_EDGES, []))).toEqual(['queue:left.Out-->a.In']);
        expect(edgesOfInstance(UNSCOPED_EDGES, ['a', 'i'])).toBe(UNSCOPED_EDGES);
    });

    it('lose the path as the runtime wrote it into the key, spaces and all', () => {
        const spaced = { ' a/i/ast:7': { instancePath: [' a', 'i'], lastToken: 'x' } };
        expect(Object.keys(edgesOfInstance(spaced, ['a', 'i']))).toEqual(['ast:7']);
    });
});

describe('where a run\'s root sits on a trail', () => {
    const trail: Crumb[] = TRAIL('a');
    const isFile = (file: string) => (crumb: Crumb) => crumb.sourceUri === file;

    it('is the instance path of its crumb, or the trail\'s root', () => {
        expect(runRootPrefix(trail, isFile('file:///w/middle.py'), trailInstancePath)).toEqual(['a']);
        expect(runRootPrefix(trail, isFile('file:///w/top.py'), trailInstancePath)).toEqual([]);
        expect(runRootPrefix(trail, isFile('file:///w/none.py'), trailInstancePath)).toEqual([]);
    });

    it('measures the paths under it from it, and none outside it', () => {
        expect(fromRunRoot(['a', 'i'], ['a'])).toEqual(['i']);
        expect(fromRunRoot(['a'], ['a'])).toEqual([]);
        expect(fromRunRoot(['b', 'i'], ['a'])).toBeUndefined();
        expect(fromRunRoot([], ['a'])).toBeUndefined();
    });
});
