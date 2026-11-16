/**
 * The panel's signature of what it draws (`panel-signature.ts`): an edit
 * changes it, a run's state on the nodes does not.
 */
import { describe, expect, it } from 'vitest';
import { WorkflowDiagramMetadata as M, WorkflowDiagramTypes as T } from '@dialogram/shared';
import { elementPanelSignature, networkPanelSignature } from '../src/panel-signature';

function port(id: string, name: string, type: string, input: boolean): any {
    return { id, type: input ? T.PORT_INPUT : T.PORT_OUTPUT, args: { [M.PORT_NAME]: name, [M.PORT_TYPE]: type, [M.IS_INPUT_PORT]: input } };
}

function instance(ports: any[], args: Record<string, unknown> = {}): any {
    const node: any = {
        id: 'n:add', type: T.NODE_ACTOR,
        args: { [M.ENTITY_NAME]: 'add', [M.ENTITY_TYPE]: 'Add', ...args },
        children: ports
    };
    for (const each of ports) {
        each.parent = node;
    }
    return node;
}

function indexed(...nodes: any[]): any {
    const byId = new Map<string, any>();
    const visit = (e: any) => { byId.set(e.id, e); (e.children ?? []).forEach(visit); };
    const root = { id: 'root', type: 'graph', args: { [M.NETWORK_NAME]: 'motion' }, children: nodes, index: { getById: (id: string) => byId.get(id) } };
    nodes.forEach(visit);
    return root;
}

describe('the panel signature of a node', () => {
    const shown = () => instance([port('n:add_port_MOT', 'MOT', 'Int(8)', true), port('n:add_port_VID', 'VID', 'Int(8)', false)]);

    it('changes when a port is retyped, renamed, added or taken out', () => {
        const before = elementPanelSignature(shown());
        const retyped = shown(); retyped.children[0].args[M.PORT_TYPE] = 'Int(9)';
        const renamed = shown(); renamed.children[1].args[M.PORT_NAME] = 'VIDEO';
        const added = shown(); added.children.push(port('n:add_port_X', 'X', 'Int(1)', true));
        const removed = shown(); removed.children.pop();
        for (const after of [retyped, renamed, added, removed]) {
            expect(elementPanelSignature(after)).not.toBe(before);
        }
    });

    it('changes when the node is renamed or its parameters change', () => {
        const before = elementPanelSignature(shown());
        expect(elementPanelSignature(instance(shown().children, { [M.ENTITY_NAME]: 'adder' }))).not.toBe(before);
        expect(elementPanelSignature(instance(shown().children, { [M.ENTITY_PARAMETERS]: { N: '4' } }))).not.toBe(before);
    });

    it('does not change for what a run puts on the node, or for its bounds', () => {
        const before = elementPanelSignature(shown());
        const running = shown();
        running.args['wf:executionState'] = 'firing';
        running.args['wf:firings'] = 12;
        running.position = { x: 40, y: 80 };
        expect(elementPanelSignature(running)).toBe(before);
    });

    it('for a port is its node: another port of the node retyped changes it', () => {
        const node = shown();
        const before = elementPanelSignature(node.children[0]);
        node.children[1].args[M.PORT_TYPE] = 'Int(16)';
        expect(elementPanelSignature(node.children[0])).not.toBe(before);
    });
});

describe('the panel signature of an edge', () => {
    it('follows its ends: the port renamed at one end changes it', () => {
        const add = instance([port('n:add_port_VID', 'VID', 'Int(8)', false)]);
        const edge = { id: 'e1', type: 'edge', sourceId: 'n:add_port_VID', targetId: 'x' };
        const before = elementPanelSignature(edge, indexed(add));
        add.children[0].args[M.PORT_NAME] = 'VIDEO';
        expect(elementPanelSignature(edge, indexed(add))).not.toBe(before);
    });
});

describe('the panel signature of the network', () => {
    const boundary = (name: string, type: string) => ({
        id: `wf:in:${name}`, type: T.NODE_BOUNDARY_INPUT,
        args: { [M.ENTITY_NAME]: name, [M.PORT_NAME]: name, [M.PORT_TYPE]: type }, children: []
    });

    it('changes when one of its own ports is added, renamed or retyped', () => {
        const before = networkPanelSignature(indexed(boundary('TEX', 'Int(8)')));
        expect(networkPanelSignature(indexed(boundary('TEX', 'Int(8)'), boundary('COEF', 'Int(9)')))).not.toBe(before);
        expect(networkPanelSignature(indexed(boundary('TEXT', 'Int(8)')))).not.toBe(before);
        expect(networkPanelSignature(indexed(boundary('TEX', 'Int(9)')))).not.toBe(before);
    });

    it('does not change for the run shown on it', () => {
        const root = indexed(boundary('TEX', 'Int(8)'));
        const before = networkPanelSignature(root);
        root.args['wf:viewerOverlayRunId'] = 'run-7';
        root.args['wf:queueTraceStep'] = 3;
        expect(networkPanelSignature(root)).toBe(before);
    });
});
