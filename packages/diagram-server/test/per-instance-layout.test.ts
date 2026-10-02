/**
 * A nested workflow shown in place has its layout per instance, in the root.
 *
 * Its key is the instance path from the editor's root and it lives in the root
 * file's layout store, so two uses of one workflow can be arranged
 * differently. An instance with no layout yet starts from the workflow's
 * standalone layout. A product opening nested files in their own editors
 * keeps one layout per workflow, as before.
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { URI } from 'vscode-uri';
import { instanceLayoutFor, layoutTargetOf } from '../src/server/layout-target';
import { WorkflowSourceModelStorage } from '../src/server/source-model-storage';
import { WORKFLOW_LAYOUT_PERSISTENCE_KEY, WORKFLOW_NETWORK_MODEL_KEY } from '@dialogram/shared';

const toPath = (uri: string) => URI.parse(uri).fsPath;
const TOP = 'file:///w/top.py';
const BLOCK = 'file:///w/layers/block.py';
const trail = [
    { sourceUri: TOP, workflowName: 'top' },
    { sourceUri: BLOCK, workflowName: 'block', workflowInstanceName: 'b2' }
];

describe('the layout of a view', () => {
    it('is the root’s, per instance, for a nested view', () => {
        expect(instanceLayoutFor(trail, { filePath: '/w/layers/block.py', workflowName: 'block' }, toPath)).toEqual({
            target: { filePath: '/w/top.py', networkId: 'top/b2/block' },
            fallback: { filePath: '/w/layers/block.py', networkId: 'block' }
        });
    });

    it('tells two instances of one workflow apart', () => {
        const other = [trail[0], { ...trail[1], workflowInstanceName: 'b3' }];
        expect(instanceLayoutFor(other, { filePath: '/w/layers/block.py', workflowName: 'block' }, toPath)?.target.networkId)
            .toBe('top/b3/block');
    });

    it('is the workflow’s own for a root, or a trail that does not end at the view', () => {
        expect(instanceLayoutFor([trail[0]], { filePath: '/w/top.py', workflowName: 'top' }, toPath)).toBeUndefined();
        expect(instanceLayoutFor(trail, { filePath: '/w/layers/other.py', workflowName: 'other' }, toPath)).toBeUndefined();
    });
});

/** Load a nested view through the storage and record which layouts it asks for. */
async function loadNested(nestedNavigation: 'in-place' | 'new-editor', saved: Record<string, string[]>) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'per-instance-layout-'));
    const blockFile = path.join(dir, 'block.py');
    await fs.writeFile(blockFile, '# block\n');
    const topFile = path.join(dir, 'top.py');
    const blockUri = URI.file(blockFile).toString();
    const asked: string[] = [];
    const state = new Map<string, unknown>();

    const storage: any = new (WorkflowSourceModelStorage as any)();
    storage.storageOptions = { settingsNamespace: 'wf', operationPrefix: 'wf', nestedNavigation };
    storage.ensureModelSource = () => undefined;
    storage.modelState = { set: (k: string, v: unknown) => state.set(k, v), get: (k: string) => state.get(k), updateRoot: () => {} };
    const key = (file: string, id: string) => `${path.basename(file)}#${id}`;
    storage.layoutPersistence = {
        loadLayout: async (file: string, id: string) => {
            asked.push(key(file, id));
            const nodes = saved[key(file, id)];
            return nodes ? new Map(nodes.map(n => [n, { x: 1, y: 1 }])) : undefined;
        },
        loadEdgeRoutes: async () => undefined
    };

    const doc = { version: '1', graph: { id: 'wf:block', nodes: [], edges: [] } };
    const opts = {
        sourceUri: blockUri,
        networkName: 'block',
        'wf:navTrail': JSON.stringify([
            { sourceUri: URI.file(topFile).toString(), workflowName: 'top' },
            { sourceUri: blockUri, workflowName: 'block', workflowInstanceName: 'b2' }
        ])
    };
    try {
        await storage.finishLoadFromDoc(doc, blockUri, blockFile, opts, undefined);
    } catch {
        // Past the layout lookup the load needs a live session; what it asked
        // for and recorded is what this tests.
    }
    await fs.rm(dir, { recursive: true, force: true });
    return {
        asked,
        persistence: state.get(WORKFLOW_LAYOUT_PERSISTENCE_KEY) as any,
        model: state.get(WORKFLOW_NETWORK_MODEL_KEY) as any
    };
}

describe('loading a nested view', () => {
    it('reads and saves its layout in the root file, under the instance path', async () => {
        const { asked, persistence, model } = await loadNested('in-place', { 'top.py#top/b2/block': ['n'] });

        expect(asked).toEqual(['top.py#top/b2/block']);
        expect(path.basename(persistence.workflowFilePath)).toBe('top.py');
        expect(persistence.networkId).toBe('top/b2/block');
        // Every handler that saves a layout (moving a node, rerouting, a layout
        // command) reads it from here, so it saves where the view was read.
        expect(path.basename(layoutTargetOf(model).filePath)).toBe('top.py');
        expect(layoutTargetOf(model).networkId).toBe('top/b2/block');
    });

    it('starts from the workflow’s standalone layout until it has its own, still saving per instance', async () => {
        const { asked, persistence } = await loadNested('in-place', { 'block.py#block': ['n'] });

        expect(asked).toEqual(['top.py#top/b2/block', 'block.py#block']);
        expect(persistence.networkId).toBe('top/b2/block');
    });

    it('keeps one layout per workflow when nested files open in their own editors', async () => {
        const { asked, persistence } = await loadNested('new-editor', {});

        expect(asked).toEqual(['block.py#block']);
        expect(persistence.networkId).toBe('block');
    });
});

describe('where a handler saves a layout', () => {
    it('is the target recorded at load', () => {
        expect(layoutTargetOf({
            documentUri: BLOCK,
            workflowName: 'block',
            layoutTarget: { filePath: '/w/top.py', networkId: 'top/b2/block' }
        })).toEqual({ filePath: '/w/top.py', networkId: 'top/b2/block' });
    });

    it('is the shown file and workflow without one, as before', () => {
        expect(layoutTargetOf({ documentUri: BLOCK, workflowName: 'block' })).toEqual({ filePath: '/w/layers/block.py', networkId: 'block' });
        expect(layoutTargetOf({ documentUri: BLOCK }).networkId).toBe('unknown');
    });
});
