/**
 * The views a producer offers of a unit besides its structure.
 *
 * A node whose unit has such views (`wf:views`, from the document's
 * `meta.views`) gets one context-menu item per view, each an `openView`
 * action the client shows in place as a crumb under the instance. The canvas
 * offers the views of the unit shown, all but the one on screen.
 */
import { describe, expect, it } from 'vitest';
import { WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import { WorkflowContextMenuItemProvider } from '../src/server/context-menu-item-provider';
import { GraphGModelSource } from '../src/model/graph-gmodel-source';
import { parseNavigationTrailArg, parseViewsMeta, viewIsOfInstance, withTrailView } from '../src/server/graph-load-request-options';
import { GraphGModelSource } from '../src/model/graph-gmodel-source';

const SHOWN = 'file:///w/top.vhd';
const VIEWS = [{ id: 'synth', label: 'Synthesis View' }];

function provider(root: any, node?: any): any {
    const p: any = new WorkflowContextMenuItemProvider();
    p.modelState = { sourceUri: SHOWN, root, index: { find: () => node } };
    return p;
}

describe('a view of a node’s unit', () => {
    const root: any = { id: 'root', type: 'graph', args: {} };
    const node: any = {
        id: 'n', type: WorkflowDiagramTypes.NODE_ACTOR, parent: root,
        args: {
            [WorkflowDiagramMetadata.ENTITY_NAME]: 'u_add',
            'wf:entityInstanceName': 'u_add',
            [WorkflowDiagramMetadata.REFERENCED_URI]: 'file:///w/adder.vhd',
            [WorkflowDiagramMetadata.REFERENCED_ENTITY_NAME]: 'adder',
            [WorkflowDiagramMetadata.VIEWS]: VIEWS
        }
    };

    it('is a context-menu item that opens it under the instance', () => {
        const items = provider(root, node).getItems(['n'], { x: 0, y: 0 });
        const item = items.find((i: any) => i.id === 'dialogram.openView.synth');
        expect(item.label).toBe('Synthesis View');
        // Last in the menu, in a group of its own, so the client draws a separator above it.
        expect(item.group).toBe('views');
        expect(items.every((i: any) => i === item || String(i.sortString) < item.sortString)).toBe(true);
        expect(item.actions).toEqual([{
            kind: 'dialogram.openView', view: 'synth', label: 'Synthesis View',
            uri: 'file:///w/adder.vhd', workflowName: 'adder', workflowInstanceName: 'u_add'
        }]);
    });

    it('says so when the view is of the instance, not of the definition its file holds', () => {
        const ofInstance = { ...node, args: { ...node.args, [WorkflowDiagramMetadata.VIEWS]: [{ id: 'inside', label: 'Inside', of: 'instance' }] } };
        const item = provider(root, ofInstance).getItems(['n'], { x: 0, y: 0 }).find((i: any) => i.id === 'dialogram.openView.inside');
        expect(item.actions).toEqual([{
            kind: 'dialogram.openView', view: 'inside', label: 'Inside',
            uri: 'file:///w/adder.vhd', workflowName: 'adder', workflowInstanceName: 'u_add', viewOf: 'instance'
        }]);
    });

    it('is not offered on a node whose unit has none', () => {
        const plain = { ...node, args: { ...node.args, [WorkflowDiagramMetadata.VIEWS]: undefined } };
        const ids = provider(root, plain).getItems(['n'], { x: 0, y: 0 }).map((i: any) => i.id);
        expect(ids.some((id: string) => id.startsWith('dialogram.openView'))).toBe(false);
    });
});

describe('a view of the unit shown', () => {
    it('is offered on the canvas, all but the one on screen', () => {
        const root: any = { id: 'root', type: 'graph', args: { 'wf:selectedWorkflow': 'adder', [WorkflowDiagramMetadata.VIEWS]: VIEWS } };
        const items = provider(root).getItems([], { x: 0, y: 0 });
        expect(items.find((i: any) => i.id === 'dialogram.openView.synth').actions).toEqual([{
            kind: 'dialogram.openView', view: 'synth', label: 'Synthesis View', uri: SHOWN, workflowName: 'adder'
        }]);
        const shown: any = { ...root, args: { ...root.args, 'wf:view': 'synth' } };
        expect(provider(shown).getItems([], { x: 0, y: 0 }).some((i: any) => i.id === 'dialogram.openView.synth')).toBe(false);
    });
});

describe('the document’s meta.views', () => {
    it('reaches the node as wf:views, labels defaulting to the id', () => {
        expect(parseViewsMeta([{ id: 'synth' }, { id: '' }, 'x'])).toEqual([{ id: 'synth', label: 'synth' }]);
        // What a view is of: the instance when the producer says so, else nothing said.
        expect(parseViewsMeta([{ id: 'a', of: 'instance' }, { id: 'b', of: 'definition' }, { id: 'c', of: true }]))
            .toEqual([{ id: 'a', label: 'a', of: 'instance' }, { id: 'b', label: 'b' }, { id: 'c', label: 'c' }]);
        expect(parseViewsMeta([])).toBeUndefined();
        const doc: any = {
            version: '1.1',
            graph: {
                id: 'wf:top', subgraphs: [{ id: 'scope:root', kind: 'root', parent: null, controlNodeId: null, children: [], nodes: ['node:scope:root:u_add'], edges: [] }],
                edges: [],
                nodes: [{ id: 'node:scope:root:u_add', kind: 'instance', label: 'u_add', type: 'adder', scope: 'scope:root', ports: [],
                    meta: { referencedEntityName: 'adder', views: VIEWS } }]
            }
        };
        const model: any = new GraphGModelSource(undefined).transform(doc);
        const find = (el: any): any => el?.args?.[WorkflowDiagramMetadata.VIEWS] ? el : (el?.children ?? []).map(find).find(Boolean);
        expect(find(model.graph ?? model)?.args[WorkflowDiagramMetadata.VIEWS]).toEqual(VIEWS);
    });
});

describe('a view of the instance, on the trail', () => {
    const trail = (last: Record<string, unknown>) => JSON.stringify([
        { sourceUri: 'file:///w/top.py', workflowName: 'top' },
        { sourceUri: 'file:///w/unit.py', workflowName: 'Unit', workflowInstanceName: 'u1', view: 'inside', ...last }
    ]);

    it('is kept on its crumb, and on no crumb that is not a view', () => {
        expect(parseNavigationTrailArg(trail({ viewOf: 'instance' }))[1]).toEqual({
            sourceUri: 'file:///w/unit.py', workflowName: 'Unit', workflowInstanceName: 'u1', view: 'inside', viewOf: 'instance'
        });
        expect(parseNavigationTrailArg(trail({ viewOf: 'definition' }))[1].viewOf).toBeUndefined();
        expect(parseNavigationTrailArg(trail({ view: '', viewOf: 'instance' }))[1].viewOf).toBeUndefined();
    });

    it('is what the request asks for when the last crumb is that view, reached through an instance', () => {
        const opts = (last: Record<string, unknown>, view: unknown = 'inside') => ({ 'wf:view': view, 'wf:navTrail': trail(last) });
        expect(viewIsOfInstance(opts({ viewOf: 'instance' }))).toBe(true);
        expect(viewIsOfInstance(opts({}))).toBe(false);
        expect(viewIsOfInstance(opts({ viewOf: 'instance' }, 'synthesis'))).toBe(false);
        // No view asked for at all (an explicit `undefined` would take the default above).
        expect(viewIsOfInstance(opts({ viewOf: 'instance' }, null))).toBe(false);
        expect(viewIsOfInstance(opts({ viewOf: 'instance', workflowInstanceName: ' ' }))).toBe(false);
        expect(viewIsOfInstance({})).toBe(false);
    });

    it('needs a whole trail: every crumb under the root reached through an instance', () => {
        const through = (middle: Record<string, unknown>) => ({
            'wf:view': 'inside',
            'wf:navTrail': JSON.stringify([
                { sourceUri: 'file:///w/top.py', workflowName: 'top' },
                { sourceUri: 'file:///w/mid.py', workflowName: 'mid', ...middle },
                { sourceUri: 'file:///w/unit.py', workflowName: 'Unit', workflowInstanceName: 'u1', view: 'inside', viewOf: 'instance' }
            ])
        });
        expect(viewIsOfInstance(through({ workflowInstanceName: 'm1' }))).toBe(true);
        // The middle unit was shown by name: the path would skip it.
        expect(viewIsOfInstance(through({}))).toBe(false);
        // A crumb alone has no root to be asked of.
        expect(viewIsOfInstance({
            'wf:view': 'inside',
            'wf:navTrail': JSON.stringify([{ sourceUri: 'file:///w/unit.py', workflowName: 'Unit', workflowInstanceName: 'u1', view: 'inside', viewOf: 'instance' }])
        })).toBe(false);
    });

    it('settles the view of a request that names none, when the request is for the last crumb’s unit', () => {
        const refresh = { networkName: 'Unit', 'wf:navTrail': trail({ viewOf: 'instance' }) };
        expect(withTrailView('file:///w/unit.py', refresh)).toEqual({ ...refresh, 'wf:view': 'inside' });
        // No name at all is the crumb's unit too.
        expect(withTrailView('file:///w/unit.py', { 'wf:navTrail': trail({}) })['wf:view']).toBe('inside');
        // A view the request names is the request's; another file, another name, or a crumb that is no view, leave it be.
        const named = { ...refresh, 'wf:view': 'synthesis' };
        expect(withTrailView('file:///w/unit.py', named)).toBe(named);
        expect(withTrailView('file:///w/other.py', refresh)).toBe(refresh);
        expect(withTrailView('file:///w/unit.py', { ...refresh, networkName: 'Other' })['wf:view']).toBeUndefined();
        expect(withTrailView('file:///w/unit.py', { networkName: 'Unit', 'wf:navTrail': trail({ view: '' }) })['wf:view']).toBeUndefined();
        expect(withTrailView('file:///w/unit.py', {})).toEqual({});
    });

    it('reaches a node’s arguments from the document, with what it is of', () => {
        const graph: any = new GraphGModelSource().transform({
            version: '1',
            graph: {
                id: 'root',
                nodes: [{
                    id: 'node:u1', kind: 'actor', label: 'u1', scope: 'scope:root', ports: [],
                    meta: { referencedEntityName: 'Unit', views: [{ id: 'inside', label: 'Inside', of: 'instance' }, { id: 'synth' }] }
                }],
                edges: []
            }
        }).graph;
        expect(graph.children.find((child: any) => child.id === 'u1').args[WorkflowDiagramMetadata.VIEWS])
            .toEqual([{ id: 'inside', label: 'Inside', of: 'instance' }, { id: 'synth', label: 'synth' }]);
    });
});
