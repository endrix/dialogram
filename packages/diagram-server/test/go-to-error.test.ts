/**
 * "Go to Error": a run failed deep in a nested hierarchy. Each view marks the
 * node the failure is in -- the actor that failed, or the nested workflow
 * containing it -- and right-clicking that node (or the canvas, when the
 * failure is not in view) offers to go to it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { GModelRoot, GNode } from '@eclipse-glsp/server';
import { WorkflowDiagramMetadata, WorkflowDiagramTypes, errorInView, hierarchyTrailTo } from '@dialogram/shared';
import { WorkflowSourceModelStorage } from '../src/server/source-model-storage';
import { WorkflowContextMenuItemProvider, goToErrorAction } from '../src/server/context-menu-item-provider';

const TOP = 'file:///w/top.py';
const MID = 'file:///w/mid.py';
const INNER = 'file:///w/inner.py';
const outline = {
    path: [], workflowName: 'top', sourceUri: TOP,
    children: [{
        path: ['m'], workflowName: 'middle', sourceUri: MID,
        children: [{ path: ['m', 'i'], workflowName: 'inner', sourceUri: INNER, children: [] }]
    }]
};
const ERROR_PATH = ['m', 'i', 'x'];

describe('where a failure shows in a view', () => {
    it('is the node of the view it is in, with what lies inside it', () => {
        expect(errorInView(ERROR_PATH, [])).toEqual({ nodeName: 'm', within: ['i', 'x'] });
        expect(errorInView(ERROR_PATH, ['m'])).toEqual({ nodeName: 'i', within: ['x'] });
        expect(errorInView(ERROR_PATH, ['m', 'i'])).toEqual({ nodeName: 'x', within: [] });
    });

    it('is nowhere in a view it is not under', () => {
        expect(errorInView(ERROR_PATH, ['other'])).toBeUndefined();
        expect(errorInView(ERROR_PATH, ['m', 'i', 'x'])).toBeUndefined();
    });

    it('is reached by the trail a drill-down would give', () => {
        expect(hierarchyTrailTo(outline, TOP, ['m', 'i'])).toEqual([
            { sourceUri: TOP, workflowName: 'top' },
            { sourceUri: MID, workflowName: 'middle', workflowInstanceName: 'm' },
            { sourceUri: INNER, workflowName: 'inner', workflowInstanceName: 'i' }
        ]);
    });
});

const tempDirs: string[] = [];
afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function markAt(viewTrail: object[]) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'go-to-error-'));
    tempDirs.push(dir);
    const storage: any = new (WorkflowSourceModelStorage as any)();
    storage.storageOptions = { settingsNamespace: 'wf', operationPrefix: 'wf' };
    storage.isLiveExecutionGlowEnabled = async () => false;
    storage.tryLoadLatestViewerOverlay = async () => ({
        runId: 'r', outDir: dir, running: false, active: [], edges: {},
        error: { entityInstanceName: 'x', entityInstancePath: ERROR_PATH, message: 'ValueError: deep down' }
    });
    storage.ensureModelSource = () => ({
        analysis: {
            buildOverlayAstPathCandidates: () => [],
            buildOverlaySignatureCandidates: () => [],
            buildOverlayNodeIdentityCandidates: (args: any) => (args?.name ? [args.name] : []),
            resolveOverlayActiveEntityName: () => undefined
        }
    });
    const root = new GModelRoot();
    root.id = 'root';
    root.args = {};
    const node = (name: string) => {
        const n = new GNode();
        n.id = name;
        n.args = { name };
        return n;
    };
    const nodes = { m: node('m'), i: node('i'), x: node('x'), other: node('other') };
    root.children = Object.values(nodes);
    await storage.applyViewerOverlayToEdges(root, '/w/top.py', 'top', viewTrail, ['top'], undefined, false, ['/w/top.py']);
    return { root, nodes };
}

const errored = (n: GNode) => (n.args as any)?.[WorkflowDiagramMetadata.IS_ERRORED] === true;

describe('the error mark', () => {
    it('is on the nested workflow containing the failure, in the root view', async () => {
        const { root, nodes } = await markAt([{ sourceUri: TOP, workflowName: 'top' }]);

        expect(errored(nodes.m)).toBe(true);
        expect((nodes.m.args as any)['wf:errorWithin']).toEqual(['i', 'x']);
        // Not on a node merely named like the one that failed.
        expect(errored(nodes.x)).toBe(false);
        expect((root.args as any)['wf:errorPath']).toEqual(ERROR_PATH);
    });

    it('is on the actor that failed, in its own view', async () => {
        const { nodes } = await markAt([
            { sourceUri: TOP, workflowName: 'top' },
            { sourceUri: MID, workflowName: 'middle', workflowInstanceName: 'm' },
            { sourceUri: INNER, workflowName: 'inner', workflowInstanceName: 'i' }
        ]);

        expect(errored(nodes.x)).toBe(true);
        expect((nodes.x.args as any)['wf:errorWithin']).toBeUndefined();
        expect(errored(nodes.m)).toBe(false);
    });
});

describe('Go to Error', () => {
    const rootArgs = (viewTrail: object[]) => ({
        'wf:errorPath': ERROR_PATH,
        'wf:hierarchy': JSON.stringify(outline),
        'wf:navTrail': JSON.stringify(viewTrail)
    });

    it('opens the view the failure is in and selects the node that failed', () => {
        expect(goToErrorAction(rootArgs([{ sourceUri: TOP, workflowName: 'top' }]) as any)).toEqual({
            kind: 'dialogram.goToError',
            trail: hierarchyTrailTo(outline, TOP, ['m', 'i']),
            nodeName: 'x'
        });
    });

    it('is not offered in the view the failure already shows in, or without the hierarchy', () => {
        const atFailure = rootArgs([
            { sourceUri: TOP, workflowName: 'top' },
            { sourceUri: MID, workflowName: 'middle', workflowInstanceName: 'm' },
            { sourceUri: INNER, workflowName: 'inner', workflowInstanceName: 'i' }
        ]);
        expect(goToErrorAction(atFailure as any)).toBeUndefined();
        expect(goToErrorAction({ 'wf:errorPath': ERROR_PATH } as any)).toBeUndefined();
    });

    function menuFor(selected: string[], nodeArgs: Record<string, unknown> = {}) {
        const root: any = { id: 'root', type: 'graph', args: rootArgs([{ sourceUri: TOP, workflowName: 'top' }]) };
        const node: any = {
            id: 'm', type: WorkflowDiagramTypes.NODE_NETWORK,
            args: { [WorkflowDiagramMetadata.ENTITY_NAME]: 'm', ...nodeArgs }, parent: root
        };
        const provider: any = new WorkflowContextMenuItemProvider();
        provider.modelState = { sourceUri: TOP, root, index: { find: (id: string) => (id === 'm' ? node : undefined) } };
        return provider.getItems(selected, { x: 0, y: 0 }).map((i: any) => i.id);
    }

    it('is on the nested workflow the failure is inside', () => {
        expect(menuFor(['m'], { 'wf:errorWithin': ['i', 'x'] })).toContain('dialogram.goToError');
        expect(menuFor(['m'])).not.toContain('dialogram.goToError');
    });

    it('is on the canvas when the failure is out of view', () => {
        expect(menuFor([])).toContain('dialogram.goToError');
    });
});
