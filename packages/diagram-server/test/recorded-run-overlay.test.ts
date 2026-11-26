/**
 * A view inside a workflow instance answered by a past run is drawn from that run.
 *
 * `parent` nests `counted` as an instance of a run of `counted` made earlier
 * (`c = counted(instance="wf-out/child-run")`): the parent's runs hand on what
 * that run recorded and run nothing of `counted`, so they record nothing
 * inside it. Stepped into from the parent, the view of `c` took the latest run
 * of any workflow on the trail, the parent's, and its edges carried nothing.
 * The crumb of `c` now says the run (`recordedRun`), and the view takes that
 * run, its paths measured from `c`, whichever run is the latest or chosen.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { GEdge, GModelRoot } from '@eclipse-glsp/server';
import { NODE_LIST_ARG, WorkflowDiagramMetadata, type HierarchyGraph, type HierarchyOutlineEntry, type NodeListOutline } from '@dialogram/shared';
import { WorkflowSourceModelStorage } from '../src/server/source-model-storage';
import { recordedRunOfTrail, recordedUnitAt, recordedUnitsOf } from '../src/server/recorded-run';
import { GraphGModelSource, type PyGraphDocument } from '../src/model/graph-gmodel-source';

const tempDirs: string[] = [];
afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function writeJson(filePath: string, value: unknown): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(value), 'utf-8');
}

const CHILD_EDGES = {
    'queue:p.Num-->d.In': { queueId: 'p.Num-->d.In', fromEntity: 'p', outPort: 'Num', toEntity: 'd', inPort: 'In', lastToken: 7 },
    'queue:d.Out-->WF.Num': { queueId: 'd.Out-->WF.Num', fromEntity: 'd', outPort: 'Out', toEntity: 'WF', inPort: 'Num', lastToken: 14 },
    // A workflow nested in `counted`, as that run recorded it.
    'queue:inner/x.Out-->WF.Out': { queueId: 'x.Out-->WF.Out', fromEntity: 'x', outPort: 'Out', toEntity: 'WF', inPort: 'Out', instancePath: ['inner'], lastToken: 'deep' }
};

/** A project with `parent.py` and `child.py`, `counted` run first, then `parent`. */
async function project(): Promise<{ dir: string; parentFile: string; childFile: string }> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'recorded-run-'));
    tempDirs.push(dir);
    const parentFile = path.join(dir, 'parent.py');
    const childFile = path.join(dir, 'child.py');
    await fs.writeFile(parentFile, '# parent\n');
    await fs.writeFile(childFile, '# child\n');
    const out = path.join(dir, 'wf-out');
    const runs = [
        { runId: 'child-run', workflowName: 'counted', sourcePath: childFile, edges: CHILD_EDGES, finishedAt: '2026-11-24T10:00:00Z' },
        {
            runId: 'parent-run', workflowName: 'parent', sourcePath: parentFile, finishedAt: '2026-11-24T11:00:00Z',
            edges: { 'queue:c.Num-->a.In': { queueId: 'c.Num-->a.In', fromEntity: 'c', outPort: 'Num', toEntity: 'a', inPort: 'In', lastToken: 14 } }
        }
    ];
    for (const run of runs) {
        const outDir = path.join(out, run.runId);
        await writeJson(path.join(outDir, 'run.wf-viewer.json'), {
            version: 1, runId: run.runId, outDir, workflowName: run.workflowName, sourcePath: run.sourcePath,
            running: false, finishedAt: run.finishedAt, edges: run.edges
        });
        await writeJson(path.join(outDir, 'run.wf-agent-context.json'), {
            version: 1, runId: run.runId, workflowName: run.workflowName, sourcePath: run.sourcePath,
            agents: [{ instanceName: 'd', entityName: 'Double', fireCount: run.runId === 'child-run' ? 1 : 9, contextBudget: 0, truncationStrategy: 'none', chatHistory: [] }]
        });
    }
    await fs.writeFile(path.join(out, 'run-log.jsonl'), runs.map(run => JSON.stringify({
        runId: run.runId, workflowName: run.workflowName, sourcePath: run.sourcePath,
        outDir: path.join(out, run.runId), finishedAt: run.finishedAt
    })).join('\n') + '\n');
    return { dir, parentFile, childFile };
}

function storage(): any {
    const s: any = new (WorkflowSourceModelStorage as any)();
    s.storageOptions = { settingsNamespace: 'wfLang', operationPrefix: 'wfpy' };
    s.isLiveExecutionGlowEnabled = async () => false;
    s.ensureModelSource = () => ({
        analysis: {
            buildOverlayAstPathCandidates: () => [],
            buildOverlaySignatureCandidates: (e: any) => (e.fromEntity && e.toEntity ? [`${e.fromEntity}|${e.outPort}|${e.toEntity}|${e.inPort}`] : []),
            buildOverlayNodeIdentityCandidates: () => [],
            resolveOverlayActiveEntityName: () => undefined
        }
    });
    return s;
}

function edge(id: string, from: string, outPort: string, to: string, inPort: string): GEdge {
    const e = new GEdge();
    e.id = id;
    e.args = { 'wf:from': from, 'wf:outPort': outPort, 'wf:to': to, 'wf:inPort': inPort };
    return e;
}

const token = (e: GEdge) => (e.args as any)?.[WorkflowDiagramMetadata.VIEWER_LAST_TOKEN];

/** The view of `counted` stepped into from `parent` (as `c`); `recordedRun` on its crumb or not. */
async function viewOfC(recordedRun: string | undefined, runId?: string) {
    const { dir, parentFile, childFile } = await project();
    const trail = [
        { sourceUri: `file://${parentFile}`, workflowName: 'parent' },
        { sourceUri: `file://${childFile}`, workflowName: 'counted', workflowInstanceName: 'c', ...(recordedRun ? { recordedRun } : {}) }
    ];
    const s = storage();
    const recorded = recordedRunOfTrail(trail, uri => new URL(uri).pathname);
    const root = new GModelRoot();
    root.id = 'root';
    const pd = edge('pd', 'p', 'Num', 'd', 'In');
    const out = edge('out', 'd', 'Out', 'WF', 'Num');
    root.children = [pd, out];
    await s.applyViewerOverlayToEdges(root, childFile, 'counted', trail, ['parent', 'counted'], undefined, true, [parentFile, childFile], runId, recorded);
    return { s, root, pd, out, dir, trail, recorded, childFile, parentFile };
}

describe('a view inside a workflow instance answered by a past run', () => {
    it('shows the tokens that run carried, though the parent ran after it', async () => {
        const { pd, out, root } = await viewOfC('wf-out/child-run');
        expect(token(pd)).toBe(7);
        expect(token(out)).toBe(14);
        expect((root.args as any)['wf:viewerOverlayRunId']).toBe('child-run');
    });

    it('is drawn from that run when another run is chosen for the parent', async () => {
        const { pd } = await viewOfC('wf-out/child-run', 'parent-run');
        expect(token(pd)).toBe(7);
    });

    it('takes the run named by its record, or by its folder', async () => {
        const { pd } = await viewOfC('wf-out/child-run/run.wf-run.json');
        expect(token(pd)).toBe(7);
    });

    it('was the latest run of the trail before, which recorded nothing inside it', async () => {
        const { pd, root } = await viewOfC(undefined);
        expect(token(pd)).toBeUndefined();
        expect((root.args as any)['wf:viewerOverlayRunId']).toBe('parent-run');
    });

    it('measures the run from the instance: a workflow nested in it shows that run\'s records of it', async () => {
        const { parentFile, childFile } = await project();
        const trail = [
            { sourceUri: `file://${parentFile}`, workflowName: 'parent' },
            { sourceUri: `file://${childFile}`, workflowName: 'counted', workflowInstanceName: 'c', recordedRun: 'wf-out/child-run' },
            { sourceUri: `file://${childFile}`, workflowName: 'deeper', workflowInstanceName: 'inner' }
        ];
        const root = new GModelRoot();
        root.id = 'root';
        const x = edge('x', 'x', 'Out', 'WF', 'Out');
        root.children = [x];
        await storage().applyViewerOverlayToEdges(
            root, childFile, 'deeper', trail, ['parent', 'counted', 'deeper'], undefined, true, [parentFile, childFile],
            undefined, recordedRunOfTrail(trail, uri => new URL(uri).pathname)
        );
        expect(token(x)).toBe('deep');
    });

    it('lists that run as the one there is, and its agents', async () => {
        const { s, root, childFile, parentFile, recorded } = await viewOfC('wf-out/child-run', 'parent-run');
        await s.attachWorkflowRunHistory(root, childFile, 'counted', ['parent', 'counted'], [parentFile, childFile], 'parent-run', recorded);
        expect((root.args as any)['wf:selectedRunId']).toBe('child-run');
        expect(JSON.parse((root.args as any)['wf:availableRuns']).map((run: any) => run.runId)).toEqual(['child-run']);
        const agents = await s.tryLoadAgentContext(childFile, 'counted', ['parent', 'counted'], [parentFile, childFile], 'parent-run', recorded);
        expect(agents?.agents[0].fireCount).toBe(1);
    });
});

describe('the run of an instance, as the review found it', () => {
    it('is read where it was found, though it wrote another folder, and runs nothing', async () => {
        const { dir, parentFile, childFile } = await project();
        const moved = path.join(dir, 'kept', 'child-run');
        await fs.mkdir(path.dirname(moved), { recursive: true });
        await fs.rename(path.join(dir, 'wf-out', 'child-run'), moved);
        const overlayPath = path.join(moved, 'run.wf-viewer.json');
        const written = JSON.parse(await fs.readFile(overlayPath, 'utf-8'));
        await fs.writeFile(overlayPath, JSON.stringify({ ...written, running: true, active: [{ entityInstanceName: 'd' }] }));
        const trail = [
            { sourceUri: `file://${parentFile}`, workflowName: 'parent' },
            { sourceUri: `file://${childFile}`, workflowName: 'counted', workflowInstanceName: 'c', recordedRun: 'kept/child-run' }
        ];
        const overlay = await storage().tryLoadLatestViewerOverlay(
            childFile, 'counted', [parentFile, childFile], ['parent', 'counted'], undefined, recordedRunOfTrail(trail, uri => new URL(uri).pathname));
        expect(overlay.outDir).toBe(moved);
        expect(overlay.running).toBe(false);
        expect(overlay.active).toBeUndefined();
    });

    it('is taken whatever spacing its record gives its workflow\'s name', async () => {
        const { dir, childFile, parentFile } = await project();
        const overlayPath = path.join(dir, 'wf-out', 'child-run', 'run.wf-viewer.json');
        const written = JSON.parse(await fs.readFile(overlayPath, 'utf-8'));
        await fs.writeFile(overlayPath, JSON.stringify({ ...written, workflowName: 'counted ' }));
        const trail = [
            { sourceUri: `file://${parentFile}`, workflowName: 'parent' },
            { sourceUri: `file://${childFile}`, workflowName: 'counted', workflowInstanceName: 'c', recordedRun: 'wf-out/child-run' }
        ];
        const overlay = await storage().tryLoadLatestViewerOverlay(
            childFile, 'counted', [parentFile, childFile], ['parent', 'counted'], undefined, recordedRunOfTrail(trail, uri => new URL(uri).pathname));
        expect(overlay?.runId).toBe('child-run');
    });

    it('is listed in the run picker though it cannot be read', async () => {
        const { parentFile, childFile } = await project();
        const trail = [
            { sourceUri: `file://${parentFile}`, workflowName: 'parent' },
            { sourceUri: `file://${childFile}`, workflowName: 'counted', workflowInstanceName: 'c', recordedRun: 'wf-out/gone-run' }
        ];
        const root = new GModelRoot();
        root.id = 'root';
        root.args = {};
        await storage().attachWorkflowRunHistory(root, childFile, 'counted', ['parent', 'counted'], [parentFile, childFile], undefined,
            recordedRunOfTrail(trail, uri => new URL(uri).pathname));
        expect((root.args as any)['wf:selectedRunId']).toBe('gone-run');
        expect(JSON.parse((root.args as any)['wf:availableRuns']).map((run: any) => run.runId)).toEqual(['gone-run']);
    });

    it('is not chosen back at the parent: the parent draws its own latest run', async () => {
        const { parentFile } = await project();
        const s = storage();
        // Back at the parent, the client carries the run the instance's view showed.
        expect(await s.runChosenFor('child-run', undefined, parentFile, 'parent', ['parent'], [parentFile])).toBeUndefined();
        expect(await s.runChosenFor('parent-run', undefined, parentFile, 'parent', ['parent'], [parentFile])).toBe('parent-run');
        expect(await s.runChosenFor(undefined, undefined, parentFile, 'parent', ['parent'], [parentFile])).toBeUndefined();
    });
});

describe('the run of the view at a trail\'s end', () => {
    const fsPath = (uri: string) => new URL(uri).pathname;

    it('is the deepest crumb\'s past run, written relative to the file of the crumb above it', () => {
        const trail = [
            { sourceUri: 'file:///w/top.py', workflowName: 'top' },
            { sourceUri: 'file:///w/sub/mid.py', workflowName: 'mid', recordedRun: 'wf-out/old' },
            { sourceUri: 'file:///w/sub/leaf.py', workflowName: 'leaf', recordedRun: '../runs/r1' },
            { sourceUri: 'file:///w/sub/leaf.py', workflowName: 'below' }
        ];
        expect(recordedRunOfTrail(trail, fsPath)).toEqual({ runDir: '/w/runs/r1', at: 2, workflowName: 'leaf' });
    });

    it('reads `~` as the home folder, keeps an absolute path, and takes a record\'s folder', () => {
        const at = (recordedRun: string) => recordedRunOfTrail([
            { sourceUri: 'file:///w/top.py', workflowName: 'top' },
            { sourceUri: 'file:///w/c.py', workflowName: 'c', recordedRun }
        ], fsPath, '/home/me')?.runDir;
        expect(at('~/runs/r1')).toBe('/home/me/runs/r1');
        expect(at('/abs/r2')).toBe('/abs/r2');
        expect(at('wf-out/r3/run.wf-run.json')).toBe('/w/wf-out/r3');
        // Written on Windows: `~` and a backslash.
        expect(at('~\\r4')).toBe(path.join('/home/me', 'r4'));
    });

    it('is none when no crumb is answered by a past run, the root\'s included', () => {
        expect(recordedRunOfTrail([{ sourceUri: 'file:///w/top.py', workflowName: 'top', recordedRun: 'wf-out/x' }], fsPath)).toBeUndefined();
        expect(recordedRunOfTrail([
            { sourceUri: 'file:///w/top.py', workflowName: 'top' },
            { sourceUri: 'file:///w/c.py', workflowName: 'c' }
        ], fsPath)).toBeUndefined();
    });
});

describe('a workflow node answered by a past run', () => {
    const nodeOf = (meta: Record<string, unknown> | undefined): any => {
        const doc: PyGraphDocument = {
            version: '1',
            graph: {
                id: 'root',
                nodes: [{ id: 'node:root:c', kind: 'workflow', label: 'c', type: 'counted', scope: 'root', ports: [], ...(meta ? { meta } : {}) }],
                edges: []
            }
        };
        return new GraphGModelSource().transform(doc).graph.children?.find((child: any) => child.args?.[WorkflowDiagramMetadata.IS_NETWORK_INSTANCE]);
    };

    it('says the run, as the producer wrote it', () => {
        const node = nodeOf({ taskKind: 'workflow', workflowInstance: { run: 'wf-out/child-run' } });
        expect(node?.args?.[WorkflowDiagramMetadata.RECORDED_RUN]).toBe('wf-out/child-run');
    });

    it('says none for a workflow that runs with its parent', () => {
        expect(nodeOf({ taskKind: 'workflow' })?.args).not.toHaveProperty(WorkflowDiagramMetadata.RECORDED_RUN);
    });
});

describe('the list of viewers of a hierarchy holding a unit answered by a past run', () => {
    // `parent` holds `c = counted(instance="wf-out/child-run")` and a viewer `a` on `c.Num`;
    // `counted`, grafted under `c`, a viewer `d` on `p.Num`.
    const viewer = (name: string) => ({
        id: `node:${name}`, kind: 'viewer', label: name, type: 'Shown', scope: 'root',
        meta: { definitionAnnotations: [{ name: 'viewer', arguments: [{ name: 'inputs', value: '["In"]' }] }] },
        ports: [{ id: `port:node:${name}:In`, name: 'In', direction: 'in' }]
    });
    const out = (name: string, kind: string, port: string, meta?: Record<string, unknown>) => ({
        id: `node:${name}`, kind, label: name, type: name, scope: 'root', ...(meta ? { meta } : {}),
        ports: [{ id: `port:node:${name}:${port}`, name: port, direction: 'out' }]
    });
    const wire = (from: string, port: string, to: string) =>
        ({ id: `${from}-${to}`, from: `port:node:${from}:${port}`, to: `port:node:${to}:In`, scope: 'root' });
    const docOf = (nodes: unknown[], edges: unknown[]): any => ({ version: '1', graph: { id: 'root', nodes, edges } });

    function graphsOf(parentFile: string, childFile: string, run: string): HierarchyGraph[] {
        return [
            {
                path: [], workflowName: 'parent', sourceUri: `file://${parentFile}`,
                document: docOf([out('c', 'workflow', 'Num', { workflowInstance: { run } }), viewer('a')], [wire('c', 'Num', 'a')])
            },
            {
                path: ['c'], workflowName: 'counted', sourceUri: `file://${childFile}`, recordedRun: run,
                document: docOf([out('p', 'task', 'Num'), viewer('d')], [wire('p', 'Num', 'd')])
            }
        ];
    }

    function listStorage() {
        const s = storage();
        s.storageOptions = {
            ...s.storageOptions,
            nodeList: { family: 'viewer', title: 'Viewers' },
            nodeFamilies: [{ annotation: 'viewer', color: '#49a6b8' }]
        };
        return s;
    }

    const rowAt = (entry: HierarchyOutlineEntry, at: string): HierarchyOutlineEntry | undefined =>
        entry.path.join('/') === at ? entry : entry.children.map(child => rowAt(child, at)).find(Boolean);
    const shown = (list: NodeListOutline, at: string) => {
        const node = rowAt(list.outline, at)!.detachedNode!;
        return { token: node.edges[0]?.args?.[WorkflowDiagramMetadata.VIEWER_LAST_TOKEN], run: (node.rootArgs ?? list.rootArgs)?.['wf:viewerOverlayRunId'] };
    };

    /** The list on the view at `trail`, drawn from the run that view is drawn from. */
    async function listOn(trailTo: 'parent' | 'c', run = 'wf-out/child-run', more: { askedRunId?: string; trailRun?: string; older?: boolean } = {}) {
        const { dir, parentFile, childFile } = await project();
        if (more.older) {
            // An older run of the parent, which the reader chose at the parent.
            const outDir = path.join(dir, 'wf-out', 'parent-old');
            await writeJson(path.join(outDir, 'run.wf-viewer.json'), {
                version: 1, runId: 'parent-old', outDir, workflowName: 'parent', sourcePath: parentFile, running: false,
                finishedAt: '2026-11-24T09:00:00Z',
                edges: { 'queue:c.Num-->a.In': { queueId: 'c.Num-->a.In', fromEntity: 'c', outPort: 'Num', toEntity: 'a', inPort: 'In', lastToken: 'old' } }
            });
            // Logged before the others: the latest is the one logged last.
            const log = path.join(dir, 'wf-out', 'run-log.jsonl');
            await fs.writeFile(log, JSON.stringify({
                runId: 'parent-old', workflowName: 'parent', sourcePath: parentFile, outDir, finishedAt: '2026-11-24T09:00:00Z'
            }) + '\n' + await fs.readFile(log, 'utf-8'));
        }
        const parentCrumb = { sourceUri: `file://${parentFile}`, workflowName: 'parent' };
        const trail = trailTo === 'parent'
            ? [parentCrumb]
            : [parentCrumb, { sourceUri: `file://${childFile}`, workflowName: 'counted', workflowInstanceName: 'c', recordedRun: more.trailRun ?? run }];
        const viewFile = trailTo === 'parent' ? parentFile : childFile;
        const s = listStorage();
        const recorded = recordedRunOfTrail(trail, uri => new URL(uri).pathname);
        const root = new GModelRoot();
        root.id = 'root';
        root.children = [];
        const applied = await s.applyViewerOverlayToEdges(
            root, viewFile, trailTo === 'parent' ? 'parent' : 'counted', trail, ['parent', 'counted'], undefined, true, [parentFile, childFile], undefined, recorded);
        await s.attachNodeList(root, { hierarchyGraphs: graphsOf(parentFile, childFile, run) }, applied, viewFile, trail, recorded, more.askedRunId);
        const raw = (root.args as any)?.[NODE_LIST_ARG];
        return { list: raw ? (JSON.parse(raw) as NodeListOutline) : undefined, dir };
    }

    it('at the parent, lists the unit\'s viewers with what its run made, and the parent\'s with what the parent\'s run made', async () => {
        const { list, dir } = await listOn('parent');

        expect(shown(list!, 'a')).toEqual({ token: 14, run: 'parent-run' });
        expect(shown(list!, 'c/d')).toEqual({ token: 7, run: 'child-run' });
        // The run's folder is where it was found, which the viewer's paths are under.
        expect(rowAt(list!.outline, 'c/d')!.detachedNode!.rootArgs?.['wf:viewerOverlayOutDir']).toBe(path.join(dir, 'wf-out', 'child-run'));
        expect(rowAt(list!.outline, 'c')!.recordedRun).toBe('wf-out/child-run');
    });

    it('inside the unit, lists the same viewers: the parent\'s from the parent\'s latest run, the unit\'s from its own', async () => {
        const { list } = await listOn('c');

        expect(shown(list!, 'a')).toEqual({ token: 14, run: 'parent-run' });
        expect(shown(list!, 'c/d')).toEqual({ token: 7, run: 'child-run' });
    });

    it('inside the unit, keeps the parent\'s run the reader chose at the parent, which the client carries in', async () => {
        const { list } = await listOn('c', 'wf-out/child-run', { askedRunId: 'parent-old', older: true });

        expect(shown(list!, 'a')).toEqual({ token: 'old', run: 'parent-old' });
        expect(shown(list!, 'c/d')).toEqual({ token: 7, run: 'child-run' });
    });

    it('inside the unit, takes the parent\'s latest when the run carried in is none of the parent\'s', async () => {
        const { list } = await listOn('c', 'wf-out/child-run', { askedRunId: 'child-run', older: true });

        expect(shown(list!, 'a')).toEqual({ token: 14, run: 'parent-run' });
    });

    it('reads the unit\'s run its source names now, not the one an older trail into it carries', async () => {
        // The view was opened at `wf-out/gone`; the source names `wf-out/child-run` since.
        const { list } = await listOn('c', 'wf-out/child-run', { trailRun: 'wf-out/gone' });

        expect(shown(list!, 'c/d')).toEqual({ token: 7, run: 'child-run' });
    });

    it('opens the unit\'s viewers with no run when its run is not found, never with the parent\'s', async () => {
        const { list } = await listOn('parent', 'wf-out/gone');

        expect(shown(list!, 'a')).toEqual({ token: 14, run: 'parent-run' });
        expect(rowAt(list!.outline, 'c/d')!.detachedNode!.rootArgs).toEqual({});
        expect(shown(list!, 'c/d').token).toBeUndefined();
    });

    it('finds each unit\'s run from the file of the graph it is drawn in, and the deepest unit an instance is in', () => {
        const units = recordedUnitsOf([
            { path: [], workflowName: 'top', sourceUri: 'file:///w/top.py', document: {} as any },
            { path: ['m'], workflowName: 'mid', sourceUri: 'file:///w/sub/mid.py', recordedRun: 'wf-out/r1', document: {} as any },
            { path: ['m', 'x'], workflowName: 'leaf', sourceUri: 'file:///w/leaf.py', recordedRun: '../runs/r2', document: {} as any },
            // Its holder is not among the graphs: it cannot be resolved.
            { path: ['gone', 'y'], workflowName: 'y', recordedRun: 'wf-out/r3', document: {} as any }
        ], uri => new URL(uri).pathname);

        expect(units).toEqual([
            { path: ['m', 'x'], runDir: '/w/runs/r2', workflowName: 'leaf' },
            { path: ['m'], runDir: '/w/wf-out/r1', workflowName: 'mid' }
        ]);
        expect(recordedUnitAt(units, ['m', 'x', 'z'])?.workflowName).toBe('leaf');
        expect(recordedUnitAt(units, ['m', 'q'])?.workflowName).toBe('mid');
        expect(recordedUnitAt(units, ['n'])).toBeUndefined();
    });
});
