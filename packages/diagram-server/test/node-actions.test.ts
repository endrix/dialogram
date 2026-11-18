/**
 * What a producer offers on a node or on the canvas (`meta.actions`,
 * shared/node-actions.ts): listed first in the context menu, each an action
 * the client carries to the product's command.
 */
import { describe, expect, it } from 'vitest';
import {
    doubleClickAction, NodeActionAction, parseNodeActions, WorkflowDiagramMetadata, WorkflowDiagramTypes
} from '@dialogram/shared';
import { WorkflowContextMenuItemProvider } from '../src/server/context-menu-item-provider';
import { GraphGModelSource, type PyGraphDocument } from '../src/model/graph-gmodel-source';

const SHOWN = 'file:///w/top.v';
const OFFERED = [
    { id: 'expand-pin', label: 'Expand This Pin', doubleClick: 'port', menu: false },
    { id: 'expand-in', label: 'Expand Fan-in' },
    { id: 'remove', label: 'Remove from the Schematic' }
];

function provider(root: any, element?: any): any {
    const p: any = new WorkflowContextMenuItemProvider();
    p.modelState = { sourceUri: SHOWN, root, index: { find: () => element } };
    return p;
}

describe('what a producer lists', () => {
    it('is read entry by entry: an id and a label, each id once', () => {
        expect(parseNodeActions([
            ...OFFERED,
            { id: 'expand-in', label: 'Again' },      // the id is taken
            { id: '', label: 'No id' }, { id: 'x' },    // no id, no label
            'expand', null,
            { id: 'odd', label: ' Odd ', doubleClick: 'sideways', menu: 'no' }
        ])).toEqual([
            { id: 'expand-pin', label: 'Expand This Pin', doubleClick: 'port', menu: false },
            { id: 'expand-in', label: 'Expand Fan-in' },
            { id: 'remove', label: 'Remove from the Schematic' },
            { id: 'odd', label: 'Odd' }
        ]);
        expect(parseNodeActions(undefined)).toEqual([]);
        expect(parseNodeActions({ id: 'a', label: 'b' })).toEqual([]);
    });

    it('says what a double-click does: on a port the port’s, else the node’s', () => {
        const actions = parseNodeActions([...OFFERED, { id: 'open', label: 'Open', doubleClick: 'node' }]);
        expect(doubleClickAction(actions, true)?.id).toBe('expand-pin');
        expect(doubleClickAction(actions, false)?.id).toBe('open');
        // A node with no action of its own does nothing on its body; its ports still do.
        expect(doubleClickAction(parseNodeActions(OFFERED), false)).toBeUndefined();
        // A port of a node whose action is the node's takes the node's.
        expect(doubleClickAction(parseNodeActions([{ id: 'open', label: 'Open', doubleClick: 'node' }]), true)?.id).toBe('open');
    });
});

describe('the context menu', () => {
    const root: any = { id: 'root', type: 'graph', args: {} };
    const node: any = {
        id: 'u1', type: WorkflowDiagramTypes.NODE_ACTOR, parent: root,
        args: { [WorkflowDiagramMetadata.ENTITY_NAME]: 'u1', [WorkflowDiagramMetadata.NODE_META]: { actions: OFFERED } }
    };

    it('lists a node’s actions first, in the producer’s order, but those a double-click alone does', () => {
        const items = provider(root, node).getItems(['u1'], { x: 0, y: 0 });
        const offered = items.filter((i: any) => String(i.id).startsWith(NodeActionAction.KIND));
        expect(offered.map((i: any) => [i.id, i.label])).toEqual([
            ['dialogram.nodeAction.expand-in', 'Expand Fan-in'],
            ['dialogram.nodeAction.remove', 'Remove from the Schematic']
        ]);
        expect(offered[0].actions).toEqual([{ kind: 'dialogram.nodeAction', action: 'expand-in', elementId: 'u1' }]);
        expect(offered.every((i: any) => i.group === 'producer')).toBe(true);
        const sorted = [...items].sort((a: any, b: any) => String(a.sortString).localeCompare(String(b.sortString)));
        expect(sorted.slice(0, 2).map((i: any) => i.id)).toEqual(offered.map((i: any) => i.id));
    });

    it('offers them on a port or a label of the node too: it stands for its node', () => {
        const port: any = { id: 'u1_port_A', type: 'port:input', parent: node, args: {} };
        const items = provider(root, port).getItems(['u1_port_A'], { x: 0, y: 0 });
        const action = items.find((i: any) => i.id === 'dialogram.nodeAction.expand-in').actions[0];
        expect(action.elementId).toBe('u1');
    });

    it('lists the canvas’s own with no element', () => {
        const canvas: any = { id: 'root', type: 'graph', args: { [WorkflowDiagramMetadata.ACTIONS]: [{ id: 'find', label: 'Find in the Netlist...' }] } };
        const items = provider(canvas).getItems([], { x: 0, y: 0 });
        const find = items.find((i: any) => i.id === 'dialogram.nodeAction.find');
        expect(find.label).toBe('Find in the Netlist...');
        expect(find.actions).toEqual([{ kind: 'dialogram.nodeAction', action: 'find' }]);
    });

    it('lists none for a node whose producer offers none', () => {
        const plain = { ...node, args: { [WorkflowDiagramMetadata.ENTITY_NAME]: 'u1', [WorkflowDiagramMetadata.NODE_META]: {} } };
        const ids = provider(root, plain).getItems(['u1'], { x: 0, y: 0 }).map((i: any) => i.id);
        expect(ids.some((id: string) => id.startsWith(NodeActionAction.KIND))).toBe(false);
    });
});

describe('a document that offers actions', () => {
    it('keeps a node’s with its meta, where the menu and the client read them', () => {
        const doc: PyGraphDocument = {
            version: '1',
            graph: {
                id: 'top',
                nodes: [{ id: 'node:u1', kind: 'instance', label: 'u1', scope: 'root', ports: [], meta: { actions: OFFERED } }],
                edges: []
            }
        };
        const graph: any = new GraphGModelSource({} as any).transform(doc).graph;
        const node = graph.children.find((c: any) => c.id === 'u1');
        expect(parseNodeActions(node.args[WorkflowDiagramMetadata.NODE_META].actions).map(a => a.id)).toEqual(['expand-pin', 'expand-in', 'remove']);
    });
});
