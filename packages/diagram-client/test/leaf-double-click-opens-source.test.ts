/**
 * Double-clicking a node that is not a network instance.
 *
 * Such a node has no diagram to drill into, so the listener used to return
 * nothing. With `clientBehavior.doubleClickOpensSource` the profile asks for
 * the node's referenced definition in the text editor instead: an HDL leaf
 * whose body is processes and assignments has code to show and no view yet.
 * The target is the one "Go to Source" uses, so a product that already fills
 * `referencedSource` gets this for the price of the flag.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { WorkflowNetworkNavigationMouseListener } from '../src/network-navigation-mouse-listener';
import { WorkflowDiagramTypes, WorkflowDiagramMetadata } from '@dialogram/shared';

const SOURCE_URI = 'file:///w/top.vhd';
const LEAF_URI = 'file:///w/adder.vhd';
const RANGE = { start: { line: 14, character: 0 }, end: { line: 14, character: 0 } };

function leafNode(args: Record<string, unknown>) {
    const node: any = {
        id: 'n1',
        type: WorkflowDiagramTypes.NODE_ACTOR,
        args,
        children: [],
        root: { args: {}, children: [] }
    };
    node.root.children = [node];
    return node;
}

/** A port of the node, as the element a double-click often lands on. */
function portOf(node: any) {
    const port = { id: 'n1_port_a', type: 'port', parent: node, args: {} };
    node.children.push(port);
    return port;
}

function doubleClick(element: unknown): any[] {
    const listener: any = new WorkflowNetworkNavigationMouseListener();
    listener.editorContext = { sourceUri: SOURCE_URI };
    return listener.doubleClick(element, {} as MouseEvent);
}

function behavior(flags: Record<string, unknown> | undefined) {
    (globalThis as any).diagramIdentifier = flags ? { clientBehavior: flags } : undefined;
}

afterEach(() => behavior(undefined));

describe('double-click on a node that is not a network instance', () => {
    it('does nothing without the flag, as before', () => {
        behavior({});
        const node = leafNode({
            [WorkflowDiagramMetadata.REFERENCED_URI]: LEAF_URI,
            [WorkflowDiagramMetadata.REFERENCED_SOURCE_RANGE]: RANGE
        });
        expect(doubleClick(node)).toEqual([]);
    });

    it('opens the referenced definition in the text editor with the flag', () => {
        behavior({ doubleClickOpensSource: true });
        const node = leafNode({
            [WorkflowDiagramMetadata.REFERENCED_URI]: LEAF_URI,
            [WorkflowDiagramMetadata.REFERENCED_SOURCE_RANGE]: RANGE
        });
        const [action] = doubleClick(node);
        expect(action.kind).toBe('navigateToExternalTarget');
        expect(action.uri).toBe(LEAF_URI);
        const options = JSON.parse(action.args.jsonOpenerOptions);
        expect(options.selection).toEqual(RANGE);
        expect(options.preview).toBe(false);
    });

    it('resolves a port to its node', () => {
        behavior({ doubleClickOpensSource: true });
        const node = leafNode({ [WorkflowDiagramMetadata.REFERENCED_URI]: LEAF_URI });
        const [action] = doubleClick(portOf(node));
        expect(action.uri).toBe(LEAF_URI);
        expect(JSON.parse(action.args.jsonOpenerOptions).selection).toBeUndefined();
    });

    it('leaves a node that references nothing alone', () => {
        behavior({ doubleClickOpensSource: true });
        expect(doubleClick(leafNode({}))).toEqual([]);
    });

    it('never applies to a network instance, which still drills down', () => {
        behavior({ doubleClickOpensSource: true });
        const node = leafNode({
            [WorkflowDiagramMetadata.IS_NETWORK_INSTANCE]: true,
            [WorkflowDiagramMetadata.REFERENCED_URI]: LEAF_URI
        });
        node.type = WorkflowDiagramTypes.NODE_NETWORK;
        // No entity name: the drill-down path bails out before building a trail,
        // and the leaf path must not take over.
        expect(doubleClick(node)).toEqual([]);
    });
});
