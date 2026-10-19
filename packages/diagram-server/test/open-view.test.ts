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
import { parseViewsMeta } from '../src/server/graph-load-request-options';

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
        expect(item.actions).toEqual([{
            kind: 'dialogram.openView', view: 'synth', label: 'Synthesis View',
            uri: 'file:///w/adder.vhd', workflowName: 'adder', workflowInstanceName: 'u_add'
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
