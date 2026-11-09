/**
 * A bundle of the unit's own ports (`s_axis_tvalid`, `s_axis_tready`,
 * `s_axis_tdata`) drawn as one boundary node, and opened into its members
 * under it.
 */
import { describe, expect, it } from 'vitest';
import { GModelIndex } from '@eclipse-glsp/server';
import { BoundaryPortGeometry, WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import { GraphGModelSource, type PyGraphDocument, type PyGraphEdge, type PyGraphNode } from '../src/model/graph-gmodel-source';
import { portBusStateOf } from '../src/model/port-bundles';
import { convertToGModelRoot } from '../src/server/gmodel-convert';
import { relativeToParent, restoreGroupGeometry } from '../src/server/group-geometry';
import { collectNodePositions, nodeLayoutKeyOf } from '../src/server/layout-snapshot';
import { withBoundaryBusPositions } from '../src/server/boundary-bus-positions';
import { countCoincidentNodes } from '../src/server/source-model-storage';
import { TogglePortBusCommand, WorkflowTogglePortBusOperationHandler } from '../src/operations/toggle-port-bus-handler';

type Point = { x: number; y: number };

const input = (name: string, group?: string, side?: string): PyGraphNode => ({
    id: `wf:input:${name}`, kind: 'wf-input', label: name, scope: 'root',
    ports: [{ id: `port:wf:input:${name}:out`, name, direction: 'out', ...(group ? { group } : {}) }],
    meta: { ...(side ? { side } : {}), source: { file: '/w/top.sv', line: 10 + name.length } }
});
const output = (name: string, group?: string, side?: string): PyGraphNode => ({
    id: `wf:output:${name}`, kind: 'wf-output', label: name, scope: 'root',
    ports: [{ id: `port:wf:output:${name}:in`, name, direction: 'in', ...(group ? { group } : {}) }],
    ...(side ? { meta: { side } } : {})
});
const U = 'node:scope:root:u_prod';
const port = (name: string, direction: 'in' | 'out', group?: string, side?: string) =>
    ({ id: `port:${U}:${name}`, name, direction, ...(group ? { group } : {}), ...(side ? { side } : {}) });
const edge = (from: string, to: string): PyGraphEdge => ({ id: `edge:${from}->${to}`, from, to, scope: 'root' });

// The handshake golden, cut down: an AXI-stream slave port on the unit, its
// `tready` placed with the inputs it answers, into an instance with a bundle
// of its own; a clock, and a bundle of one.
const instance: PyGraphNode = {
    id: U, kind: 'instance', label: 'u_prod', scope: 'root',
    ports: [port('clk', 'in'), port('in_valid', 'in', 'in'), port('in_ready', 'out', 'in', 'west'), port('in_data', 'in', 'in')]
};
const doc: PyGraphDocument = {
    version: '1',
    graph: {
        id: 'root',
        nodes: [
            input('clk'),
            input('s_axis_tvalid', 's_axis'),
            output('s_axis_tready', 's_axis', 'west'),
            input('s_axis_tdata', 's_axis'),
            input('irq', 'irq'),
            output('m_axis_tvalid', 'm_axis'),
            output('m_axis_tdata', 'm_axis'),
            instance
        ],
        edges: [
            edge('port:wf:input:clk:out', `port:${U}:clk`),
            edge('port:wf:input:s_axis_tvalid:out', `port:${U}:in_valid`),
            edge(`port:${U}:in_ready`, 'port:wf:output:s_axis_tready:in'),
            edge('port:wf:input:s_axis_tdata:out', `port:${U}:in_data`)
        ]
    }
};

const S_AXIS = 'bus:wf:west:s_axis';
const S_AXIS_PORT = `${S_AXIS}_port_s_axis`;
const MEMBERS = ['s_axis_tvalid', 's_axis_tready', 's_axis_tdata'];

function model(open: Record<string, string[]> = {}): any[] {
    const state = portBusStateOf(new Map(Object.entries(open).map(([k, v]) => [k, new Set(v)])));
    return new GraphGModelSource().transform(doc, { portBuses: state }).graph.children ?? [];
}
const nodeIds = (children: any[]) => children.filter(c => String(c.type).startsWith('node:')).map(c => c.id);
const nodeOf = (children: any[], id: string) => children.find(c => c.id === id);
const portOf = (node: any) => node.children.find((c: any) => String(c.type).startsWith('port'));
const edgesOf = (children: any[]) => children.filter(c => typeof c.sourceId === 'string');

describe('a closed bundle of the unit’s ports', () => {
    it('is one boundary node, named after the bundle, in place of the first member', () => {
        expect(nodeIds(model())).toEqual(['clk', S_AXIS, 'irq', 'bus:wf:east:m_axis', 'u_prod']);
    });

    it('is an input when most members are, and says how many it holds', () => {
        const bus = nodeOf(model(), S_AXIS);
        expect(bus.type).toBe(WorkflowDiagramTypes.NODE_BOUNDARY_INPUT);
        expect(bus.args[WorkflowDiagramMetadata.BOUNDARY_SIDE]).toBeUndefined();
        expect(bus.children.find((c: any) => c.type === WorkflowDiagramTypes.LABEL_BOUNDARY_NAME).text).toBe('s_axis');
        expect(bus.children.find((c: any) => c.type === WorkflowDiagramTypes.LABEL_BOUNDARY_TYPE).text).toBe('3 ports');
        const busPort = portOf(bus);
        expect(busPort.id).toBe(S_AXIS_PORT);
        expect(busPort.args[WorkflowDiagramMetadata.PORT_BUS_GROUP]).toBe('s_axis');
        expect(busPort.args[WorkflowDiagramMetadata.PORT_BUS_EXPANDED]).toBe(false);
        expect(busPort.args[WorkflowDiagramMetadata.PORT_BUS_MEMBERS]).toBe(3);
        expect(bus.args['wf:busMembers']).toEqual(MEMBERS);
        expect(nodeOf(model(), 'bus:wf:east:m_axis').type).toBe(WorkflowDiagramTypes.NODE_BOUNDARY_OUTPUT);
    });

    it('leaves a bundle of one as the port it is', () => {
        const irq = nodeOf(model(), 'irq');
        expect(portOf(irq).args[WorkflowDiagramMetadata.PORT_BUS_GROUP]).toBeUndefined();
        expect(irq.args['wf:busMembers']).toBeUndefined();
    });

    it('goes to its first member’s declaration', () => {
        const bus = nodeOf(model(), S_AXIS);
        expect(bus.args[WorkflowDiagramMetadata.REFERENCED_URI]).toBe('file:///w/top.sv');
        expect(bus.args[WorkflowDiagramMetadata.REFERENCED_SOURCE_RANGE].start.line).toBe(10 + 's_axis_tvalid'.length - 1);
    });

    it('joins a closed bundle at the other end by one edge, and an unbundled port by its own', () => {
        const edges = edgesOf(model());
        expect(edges.map(e => [e.sourceId, e.targetId])).toEqual([
            ['clk_port_clk', 'u_prod_port_clk'],
            [S_AXIS_PORT, 'u_prod_bus_in']
        ]);
    });

    it('keeps one edge while only one end is open', () => {
        expect(edgesOf(model({ [S_AXIS]: ['s_axis'] })).map(e => e.sourceId)).toEqual(['clk_port_clk', S_AXIS_PORT]);
        expect(edgesOf(model({ u_prod: ['in'] })).map(e => e.targetId)).toEqual(['u_prod_port_clk', 'u_prod_bus_in']);
    });
});

describe('an open bundle of the unit’s ports', () => {
    const open = { [S_AXIS]: ['s_axis'], u_prod: ['in'] };

    it('keeps its node as the header and draws its members after it', () => {
        const children = model(open);
        expect(nodeIds(children)).toEqual(['clk', S_AXIS, ...MEMBERS, 'irq', 'bus:wf:east:m_axis', 'u_prod']);
        expect(portOf(nodeOf(children, S_AXIS)).args[WorkflowDiagramMetadata.PORT_BUS_EXPANDED]).toBe(true);
        for (const member of MEMBERS) {
            expect(portOf(nodeOf(children, member)).args[WorkflowDiagramMetadata.PORT_BUS_MEMBER_OF]).toBe('s_axis');
        }
        expect(nodeOf(children, 's_axis_tready').args[WorkflowDiagramMetadata.BOUNDARY_SIDE]).toBe('WEST');
    });

    it('is joined member to member once both ends are open', () => {
        const edges = edgesOf(model(open)).map(e => [e.sourceId, e.targetId]);
        expect(edges).toEqual([
            ['clk_port_clk', 'u_prod_port_clk'],
            ['s_axis_tvalid_port_s_axis_tvalid', 'u_prod_port_in_valid'],
            ['u_prod_port_in_ready', 's_axis_tready_port_s_axis_tready'],
            ['s_axis_tdata_port_s_axis_tdata', 'u_prod_port_in_data']
        ]);
    });
});

describe('a bundle split across both margins', () => {
    it('is a bus in each margin', () => {
        const split: PyGraphDocument = {
            version: '1',
            graph: {
                id: 'root',
                nodes: [input('a_x', 'a'), input('a_y', 'a'), output('a_p', 'a'), output('a_q', 'a')],
                edges: []
            }
        };
        const children = new GraphGModelSource().transform(split).graph.children ?? [];
        expect(nodeIds(children)).toEqual(['bus:wf:west:a', 'bus:wf:east:a']);
    });
});

/** The diagram as the storage rebuilds it: positions by layout key, absolute. */
function diagram(positions: Record<string, Point>) {
    let open = new Map<string, Set<string>>();
    const state: { root?: any; index?: GModelIndex } = {};
    const build = (saved: Map<string, Point>): void => {
        const built: any = new GraphGModelSource().transform(doc, { portBuses: portBusStateOf(open) });
        const at = withBoundaryBusPositions(built.graph, saved);
        for (const element of built.graph.children ?? []) {
            const key = typeof element.type === 'string' && element.type.startsWith('node:') ? nodeLayoutKeyOf(element) : undefined;
            const saved = key ? at.get(key) : undefined;
            if (saved) {
                element.position = relativeToParent(saved, { x: 0, y: 0 });
            }
        }
        const root: any = convertToGModelRoot(built);
        restoreGroupGeometry(root, undefined);
        const index = new GModelIndex();
        index.indexRoot(root);
        state.root = root;
        state.index = index;
    };
    build(new Map(Object.entries(positions)));
    const handler = new WorkflowTogglePortBusOperationHandler();
    (handler as any).modelState = {
        get root() { return state.root; },
        get index() { return state.index; },
        get: () => ({ documentUri: 'file:///w/boundary.sv', workflowName: 'live' })
    };
    (handler as any).layoutPersistence = {
        savePortBuses: async (_file: string, _id: string, byNode: Map<string, Set<string>>) => {
            open = new Map([...byNode].map(([key, groups]) => [key, new Set(groups)]));
        }
    };
    (handler as any).sourceModelStorage = { rebuildFromLastDocument: async (current: any) => { build(current.positions); return true; } };
    (handler as any).rerouteHandler = { runReroute: async () => {} };
    (handler as any).commandStack = { commands: [], flush() {} };
    const at = (id: string): Point | undefined => collectNodePositions(state.root).get(id);
    const command = (): TogglePortBusCommand =>
        handler.createCommand({ kind: 'dialogram.togglePortBus', portId: S_AXIS_PORT } as any) as TogglePortBusCommand;
    return { at, command };
}

describe('opening a bundle of the unit’s ports', () => {
    const pitch = BoundaryPortGeometry.ROW_PITCH_PX;

    it('puts its members in the rows under it and moves what was there down, and closing undoes both', async () => {
        const d = diagram({ [S_AXIS]: { x: 0, y: 100 }, irq: { x: 0, y: 140 }, clk: { x: 0, y: 40 }, u_prod: { x: 300, y: 100 } });
        const toggle = d.command();
        await toggle.execute();
        expect(MEMBERS.map(m => d.at(m))).toEqual(MEMBERS.map((_m, k) => ({ x: 0, y: 100 + (k + 1) * pitch })));
        // irq was 12 px under the bus; it keeps that gap under the last member.
        expect(d.at('irq')).toEqual({ x: 0, y: 140 + MEMBERS.length * pitch });
        // Above it, or beside it, nothing moves.
        expect(d.at('clk')).toEqual({ x: 0, y: 40 });
        expect(d.at('u_prod')).toEqual({ x: 300, y: 100 });

        await toggle.undo();
        expect(MEMBERS.map(m => d.at(m))).toEqual([undefined, undefined, undefined]);
        expect(d.at('irq')).toEqual({ x: 0, y: 140 });

        await toggle.redo();
        expect(d.at('s_axis_tdata')).toEqual({ x: 0, y: 100 + 3 * pitch });
        expect(d.at('irq')).toEqual({ x: 0, y: 140 + MEMBERS.length * pitch });
    });
});

describe('a bus edge at a bundle of the unit’s ports', () => {
    const graph = (nodes: PyGraphNode[], edges: PyGraphEdge[]): any[] =>
        new GraphGModelSource().transform({ version: '1', graph: { id: 'root', nodes, edges } }).graph.children ?? [];
    const sink: PyGraphNode = {
        id: U, kind: 'instance', label: 'u_prod', scope: 'root',
        ports: [port('a', 'in'), port('b', 'out'), port('c', 'out')]
    };

    it('runs the way the bus’s arrow points, whichever way most of its wires run', () => {
        // Two inputs and two outputs in the west margin: an input bus. Only one
        // input is connected and both outputs are, so most wires run into it.
        const nodes = [input('x_a', 'x'), input('x_n', 'x'), output('x_b', 'x', 'west'), output('x_c', 'x', 'west'), sink];
        const edges = [
            edge('port:wf:input:x_a:out', `port:${U}:a`),
            edge(`port:${U}:b`, 'port:wf:output:x_b:in'),
            edge(`port:${U}:c`, 'port:wf:output:x_c:in')
        ];
        const children = graph(nodes, edges);
        expect(nodeOf(children, 'bus:wf:west:x').type).toBe(WorkflowDiagramTypes.NODE_BOUNDARY_INPUT);
        expect(edgesOf(children).map(e => e.sourceId)).toEqual(['bus:wf:west:x_port_x', 'bus:wf:west:x_port_x', 'bus:wf:west:x_port_x']);
    });

    it('is not drawn from a member to another member of the same closed bus', () => {
        const nodes = [input('x_valid', 'x'), output('x_ready', 'x', 'west')];
        const children = graph(nodes, [edge('port:wf:input:x_valid:out', 'port:wf:output:x_ready:in')]);
        expect(edgesOf(children)).toEqual([]);
    });
});

describe('the place of a bundle of the unit’s ports', () => {
    const graphOf = (open: Record<string, string[]> = {}) =>
        new GraphGModelSource().transform(doc, {
            portBuses: portBusStateOf(new Map(Object.entries(open).map(([k, v]) => [k, new Set(v)])))
        }).graph;
    const pitch = BoundaryPortGeometry.ROW_PITCH_PX;
    const others = { clk: { x: 0, y: 0 }, irq: { x: 0, y: 300 }, 'bus:wf:east:m_axis': { x: 600, y: 0 }, u_prod: { x: 300, y: 100 } };

    it('in a layout saved before it was one, is its topmost member’s, the others left out', () => {
        const saved = new Map(Object.entries({
            ...others, s_axis_tvalid: { x: 0, y: 140 }, s_axis_tready: { x: 0, y: 100 }, s_axis_tdata: { x: 0, y: 180 }
        }));
        const placed = withBoundaryBusPositions(graphOf(), saved);
        expect(placed.get(S_AXIS)).toEqual({ x: 0, y: 100 });
        expect(MEMBERS.map(m => placed.has(m))).toEqual([false, false, false]);
        expect(countCoincidentNodes(placed.values())).toBe(0);
        // What the layout file loaded is not changed.
        expect(saved.has(S_AXIS)).toBe(false);
    });

    it('open, and saved before it was one, is the row above its members, who keep theirs', () => {
        const saved = new Map(Object.entries({
            ...others, s_axis_tvalid: { x: 0, y: 140 }, s_axis_tready: { x: 0, y: 100 }, s_axis_tdata: { x: 0, y: 180 }
        }));
        const placed = withBoundaryBusPositions(graphOf({ [S_AXIS]: ['s_axis'] }), saved);
        expect(placed.get(S_AXIS)).toEqual({ x: 0, y: 100 - pitch });
        expect(placed.get('s_axis_tready')).toEqual({ x: 0, y: 100 });
    });

    it('gives the members just opened the rows under the bus', () => {
        const saved = new Map(Object.entries({ ...others, [S_AXIS]: { x: 0, y: 100 } }));
        const placed = withBoundaryBusPositions(graphOf({ [S_AXIS]: ['s_axis'] }), saved);
        expect(MEMBERS.map(m => placed.get(m))).toEqual(MEMBERS.map((_m, k) => ({ x: 0, y: 100 + (k + 1) * pitch })));
    });

    it('is the layout itself when nothing is missing', () => {
        const saved = new Map(Object.entries({ ...others, [S_AXIS]: { x: 0, y: 100 } }));
        expect(withBoundaryBusPositions(graphOf(), saved)).toBe(saved);
    });
});
