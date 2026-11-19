/**
 * What a producer offers on a node, on the client's side: a double-click
 * does the action marked for it, in place of anything the platform would
 * open, and the product's command gets the node it was made on.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import { RevealNodeAction } from '@dialogram/shared';
import { doubleClickNodeAction, nodeActionRequest, nodeWithActions, offeredMenuItems, portNameOf } from '../src/node-actions';
import { FocusAfterLoadService, RevealNodeActionHandler } from '../src/focus-after-load';
import { WorkflowNetworkNavigationMouseListener } from '../src/network-navigation-mouse-listener';
import { ViewerMouseListener } from '../src/viewer-mouse-listener';

const SOURCE = 'file:///w/top.v';
const META = {
    netlist: { cell: 'u_core/g1' },
    actions: [
        { id: 'expand-pin', label: 'Expand This Pin', doubleClick: 'port', menu: false },
        { id: 'expand-in', label: 'Expand Fan-in' }
    ]
};

function scene(meta: Record<string, unknown> = META) {
    const root: any = { id: 'root', type: 'graph', children: [], args: { sourceUri: SOURCE, 'wf:selectedWorkflow': 'top' } };
    const node: any = {
        id: 'u_core/g1', type: WorkflowDiagramTypes.NODE_ACTOR, parent: root, root, children: [],
        args: {
            [WorkflowDiagramMetadata.ENTITY_NAME]: 'u_core/g1',
            'wf:graphNodeId': 'node:scope:root:u_core/g1',
            // Something the platform would open on a double-click, were the producer's action not there.
            [WorkflowDiagramMetadata.REFERENCED_URI]: 'file:///w/rtl.v',
            [WorkflowDiagramMetadata.NODE_META]: meta
        }
    };
    const port: any = { id: 'u_core/g1_port_A1', type: 'port:input', parent: node, children: [], args: { [WorkflowDiagramMetadata.PORT_NAME]: 'A1' } };
    const label: any = { id: 'u_core/g1_port_A1_label', type: 'label:port', parent: port, children: [], args: {} };
    port.children.push(label);
    node.children.push(port);
    root.children.push(node);
    return { root, node, port, label };
}

function behavior(flags: Record<string, unknown> | undefined) {
    (globalThis as any).diagramIdentifier = flags ? { clientBehavior: flags } : undefined;
}

afterEach(() => behavior(undefined));

describe('a double-click on a node whose producer offers actions', () => {
    it('does the port’s action on a port, and on what is drawn inside it', () => {
        behavior({ nodeActionCommand: 'sv.netlist.nodeAction' });
        const { port, label } = scene();
        const expected = { kind: 'dialogram.nodeAction', action: 'expand-pin', elementId: 'u_core/g1', port: 'A1' };
        expect(doubleClickNodeAction(port)).toEqual(expected);
        expect(doubleClickNodeAction(label)).toEqual(expected);
        expect(portNameOf(label)).toBe('A1');
    });

    it('does nothing of the producer’s on the node’s body when only its ports have an action', () => {
        behavior({ nodeActionCommand: 'sv.netlist.nodeAction' });
        const { node } = scene();
        expect(doubleClickNodeAction(node)).toBeUndefined();
        expect(portNameOf(node)).toBeUndefined();
    });

    it('does the node’s action anywhere on a node that has one', () => {
        behavior({ nodeActionCommand: 'sv.netlist.nodeAction' });
        const { node, port } = scene({ actions: [{ id: 'expand-stub', label: 'Expand', doubleClick: 'node' }] });
        expect(doubleClickNodeAction(node)).toEqual({ kind: 'dialogram.nodeAction', action: 'expand-stub', elementId: 'u_core/g1' });
        // No port name: the action is the node's.
        expect(doubleClickNodeAction(port)).toEqual({ kind: 'dialogram.nodeAction', action: 'expand-stub', elementId: 'u_core/g1' });
    });

    it('is nothing without a product command to carry it out, or without actions', () => {
        behavior({});
        expect(doubleClickNodeAction(scene().port)).toBeUndefined();
        behavior({ nodeActionCommand: 'sv.netlist.nodeAction' });
        expect(doubleClickNodeAction(scene({}).port)).toBeUndefined();
        expect(nodeWithActions(scene({}).port)).toBeUndefined();
    });

    it('is the one thing the click does: neither listener opens anything beside it', () => {
        behavior({ nodeActionCommand: 'sv.netlist.nodeAction', doubleClickOpensSource: true });
        const { port } = scene();
        const navigation: any = new WorkflowNetworkNavigationMouseListener();
        navigation.editorContext = { sourceUri: SOURCE };
        expect(navigation.doubleClick(port, {} as MouseEvent)).toEqual([
            { kind: 'dialogram.nodeAction', action: 'expand-pin', elementId: 'u_core/g1', port: 'A1' }
        ]);
        const viewer: any = new ViewerMouseListener();
        viewer.editorContext = { sourceUri: SOURCE };
        expect(viewer.doubleClick(port, {} as MouseEvent)).toEqual([]);
    });
});

describe('what the product’s command is called with', () => {
    it('names the file, the unit, the producer’s node, its meta and the port', () => {
        const { root, node } = scene();
        expect(nodeActionRequest({ kind: 'dialogram.nodeAction', action: 'expand-pin', elementId: node.id, port: 'A1' }, root, node)).toEqual({
            action: 'expand-pin', sourceUri: SOURCE, workflowName: 'top',
            nodeId: 'node:scope:root:u_core/g1', label: 'u_core/g1', meta: META, port: 'A1'
        });
    });

    it('names no node for an action of the canvas, and the view when one is shown', () => {
        const { root } = scene();
        root.args['wf:view'] = 'schematic';
        expect(nodeActionRequest({ kind: 'dialogram.nodeAction', action: 'find' }, root, root)).toEqual({
            action: 'find', sourceUri: SOURCE, workflowName: 'top', view: 'schematic'
        });
    });

    it('is nothing for a diagram that knows no file', () => {
        const { root, node } = scene();
        delete root.args.sourceUri;
        expect(nodeActionRequest({ kind: 'dialogram.nodeAction', action: 'find' }, root, node)).toBeUndefined();
    });
});

describe('the context menu of a product', () => {
    const items = [
        { id: 'dialogram.nodeAction.expand-in', label: 'Expand Fan-in', actions: [{ kind: 'dialogram.nodeAction', action: 'expand-in', elementId: 'u1' }] },
        { id: 'layout', label: 'Layout Diagram', actions: [{ kind: 'dialogram.layoutBoundaryFlow' }] },
        {
            id: 'more', label: 'More', actions: [], children: [
                { id: 'dialogram.nodeAction.find', label: 'Find...', actions: [{ kind: 'dialogram.nodeAction', action: 'find' }] },
                { id: 'fit', label: 'Fit', actions: [{ kind: 'fit' }] }
            ]
        }
    ];

    it('offers what a producer lists when the product names the command that carries it out', () => {
        behavior({ nodeActionCommand: 'sv.netlist.nodeAction' });
        expect(offeredMenuItems(items)).toEqual(items);
    });

    it('offers none of it without the command: an entry that would do nothing is not shown', () => {
        behavior({});
        expect(offeredMenuItems(items).map(i => [i.id, (i.children ?? []).map(c => c.id)])).toEqual([['layout', []], ['more', ['fit']]]);
        behavior(undefined);
        expect(offeredMenuItems(items).map(i => i.id)).toEqual(['layout', 'more']);
        // What was handed in is left as it was.
        expect(items[2].children).toHaveLength(2);
    });
});

describe('a node the product’s command names to be shown', () => {
    it('is selected and centred when the model that has it comes in, and only then', async () => {
        const dispatched: any[] = [];
        const focus: any = new FocusAfterLoadService();
        focus.dispatcher = { dispatch: async (action: unknown) => void dispatched.push(action) };
        const handler: any = new RevealNodeActionHandler();
        handler.focusAfterLoad = focus;
        handler.handle(RevealNodeAction.create('u_core/g1'));
        // The model on screen when the command ran does not have it yet.
        focus.modelRootChanged({ id: 'root', children: [] });
        await new Promise(resolve => setTimeout(resolve, 5));
        expect(dispatched).toEqual([]);
        const { root, node } = scene();
        focus.modelRootChanged(root);
        await new Promise(resolve => setTimeout(resolve, 5));
        expect(dispatched.map(a => a.kind)).toEqual(['elementSelected', 'center']);
        expect(dispatched[0].selectedElementsIDs).toEqual([node.id]);
        // In place of what was selected: the node the step was taken from stays selected across the reload,
        // and adding to the selection would leave the reader with two.
        expect(dispatched[0].deselectAll).toBe(true);
        expect(dispatched[1].elementIds).toEqual([node.id]);
        // Asked for once: a later model does not select it again.
        focus.modelRootChanged(root);
        await new Promise(resolve => setTimeout(resolve, 5));
        expect(dispatched).toHaveLength(2);
    });

    it('is not waited for past the load the command asked for', async () => {
        const dispatched: any[] = [];
        const focus: any = new FocusAfterLoadService();
        focus.dispatcher = { dispatch: async (action: unknown) => void dispatched.push(action) };
        focus.focusWhenLoaded('u_core/g1', -1);
        focus.modelRootChanged(scene().root);
        await new Promise(resolve => setTimeout(resolve, 5));
        expect(dispatched).toEqual([]);
        // And is forgotten: the next model that has it is left alone too.
        focus.until = Date.now() + 60000;
        focus.modelRootChanged(scene().root);
        await new Promise(resolve => setTimeout(resolve, 5));
        expect(dispatched).toEqual([]);
    });

    it('is no action without a name', () => {
        expect(RevealNodeAction.is({ kind: RevealNodeAction.KIND, nodeName: '' })).toBe(false);
        expect(RevealNodeAction.is({ kind: RevealNodeAction.KIND })).toBe(false);
        expect(RevealNodeAction.is(RevealNodeAction.create('g1'))).toBe(true);
    });
});

/**
 * An open node whose frame is that node (open-nodes.ts): the frame carries
 * the node's `meta`, and with it what its producer offers on it.
 */
describe('what a producer offers on a node that is open', () => {
    function opened() {
        const root: any = { id: 'root', type: 'graph', children: [], args: { sourceUri: SOURCE } };
        const frame: any = {
            id: 'scope:open:node:proc', type: WorkflowDiagramTypes.NODE_GROUP, parent: root, root, children: [],
            args: { [WorkflowDiagramMetadata.ENTITY_NAME]: 'regs', 'wf:graphNodeId': 'node:proc', [WorkflowDiagramMetadata.NODE_META]: { actions: [{ id: 'show', label: 'Show', doubleClick: 'node' }] } }
        };
        const pin: any = { id: 'scope:open:node:proc::pin::clk', type: WorkflowDiagramTypes.PORT_GROUP_BOUNDARY, parent: frame, children: [], args: { [WorkflowDiagramMetadata.PORT_NAME]: 'clk', [WorkflowDiagramMetadata.FRAME_PIN]: true } };
        // What the frame holds: a node of its own, which says nothing of itself, and one that does.
        const bare: any = { id: 'scope:open:node:proc/q', type: WorkflowDiagramTypes.NODE_ACTOR, parent: frame, children: [], args: { [WorkflowDiagramMetadata.ENTITY_NAME]: 'q' } };
        const barePort: any = { id: 'scope:open:node:proc/q_port_d', type: 'port:input', parent: bare, children: [], args: { [WorkflowDiagramMetadata.PORT_NAME]: 'd' } };
        bare.children.push(barePort);
        const own: any = { id: 'scope:open:node:proc/r', type: WorkflowDiagramTypes.NODE_ACTOR, parent: frame, children: [], args: { [WorkflowDiagramMetadata.NODE_META]: { actions: [{ id: 'trace', label: 'Trace' }] } } };
        frame.children.push(pin, bare, own);
        root.children.push(frame);
        return { frame, pin, bare, barePort, own };
    }

    it('is offered on its frame and on a pin of it, as on the node and its ports', () => {
        const { frame, pin } = opened();
        expect(nodeWithActions(frame)?.node).toBe(frame);
        expect(nodeWithActions(pin)?.node).toBe(frame);
    });

    it('is not offered on what the frame holds: a node in it stands for itself', () => {
        const { bare, barePort, own } = opened();
        expect(nodeWithActions(bare)).toBeUndefined();
        expect(nodeWithActions(barePort)).toBeUndefined();
        expect(nodeWithActions(own)?.actions.map(action => action.id)).toEqual(['trace']);
    });
});
