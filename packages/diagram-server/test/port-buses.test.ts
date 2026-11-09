/**
 * A bundle of ports drawn as one port, a bus, and the connections between two
 * buses as one edge, until the reader opens both ends.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorkflowDiagramConstants, WorkflowDiagramCss, WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import { GraphGModelSource, type PyGraphDocument, type PyGraphEdge, type PyGraphNode } from '../src/model/graph-gmodel-source';
import { bundlePorts, portBusStateOf } from '../src/model/port-bundles';
import { LayoutPersistenceService } from '../src/services/layout-persistence-service';
import { TogglePortBusCommand, WorkflowTogglePortBusOperationHandler } from '../src/operations/toggle-port-bus-handler';

// The shape hdl-sidecar sends for a producer and a consumer joined by one
// valid/ready channel (its `handshake` golden, cut down): `ready` runs
// against the other two, and is placed with its bundle.
const P = 'node:scope:root:u_prod';
const C = 'node:scope:root:u_cons';
const port = (node: string, name: string, direction: 'in' | 'out', group?: string, side?: string) =>
    ({ id: `port:${node}:${name}`, name, direction, ...(group ? { group } : {}), ...(side ? { side } : {}) });
const edge = (from: string, to: string, meta?: Record<string, unknown>): PyGraphEdge =>
    ({ id: `edge:${from}->${to}`, from, to, scope: 'root', ...(meta ? { meta } : {}) });

const producer: PyGraphNode = {
    id: P, kind: 'instance', label: 'u_prod', scope: 'root',
    ports: [
        port(P, 'clk', 'in'),
        port(P, 'out_valid', 'out', 'out'),
        port(P, 'out_ready', 'in', 'out', 'east'),
        port(P, 'out_data', 'out', 'out')
    ]
};
const consumer: PyGraphNode = {
    id: C, kind: 'instance', label: 'u_cons', scope: 'root',
    ports: [
        port(C, 's_valid', 'in', 's'),
        port(C, 's_ready', 'out', 's', 'west'),
        port(C, 's_data', 'in', 's'),
        port(C, 'q', 'out')
    ]
};
const boundary: PyGraphNode = {
    id: 'wf:output:q', kind: 'wf-output', label: 'q', scope: 'root',
    ports: [{ id: 'port:wf:output:q:in', name: 'q', direction: 'in' }]
};
const channel = [
    edge(`port:${P}:out_data`, `port:${C}:s_data`, { signal: 'link_data', role: 'data' }),
    edge(`port:${C}:s_ready`, `port:${P}:out_ready`, { signal: 'link_ready', role: 'data' }),
    edge(`port:${P}:out_valid`, `port:${C}:s_valid`, { signal: 'link_valid', role: 'data' })
];
const doc: PyGraphDocument = {
    version: '1',
    graph: { id: 'root', nodes: [producer, consumer, boundary], edges: [...channel, edge(`port:${C}:q`, 'port:wf:output:q:in')] }
};

function model(open: Record<string, string[]> = {}): any[] {
    const state = portBusStateOf(new Map(Object.entries(open).map(([k, v]) => [k, new Set(v)])));
    return new GraphGModelSource().transform(doc, { portBuses: state }).graph.children ?? [];
}
const nodeOf = (children: any[], id: string) => children.find(c => c.id === id);
const portIds = (node: any) => node.children.filter((c: any) => String(c.type).startsWith('port')).map((c: any) => c.id);
const edgesOf = (children: any[]) => children.filter(c => typeof c.sourceId === 'string');

describe('a closed bundle', () => {
    it('is one port, named after the bundle, in place of its members', () => {
        const children = model();
        expect(portIds(nodeOf(children, 'u_prod'))).toEqual(['u_prod_port_clk', 'u_prod_bus_out']);
        expect(portIds(nodeOf(children, 'u_cons'))).toEqual(['u_cons_bus_s', 'u_cons_port_q']);
        const bus = nodeOf(children, 'u_prod').children.find((c: any) => c.id === 'u_prod_bus_out');
        expect(bus.type).toBe(WorkflowDiagramTypes.PORT_OUTPUT);
        expect(bus.layoutOptions['elk.port.side']).toBe('EAST');
        expect(bus.cssClasses).toContain(WorkflowDiagramCss.PORT_BUS);
        expect(bus.args[WorkflowDiagramMetadata.PORT_BUS_GROUP]).toBe('out');
        expect(bus.args[WorkflowDiagramMetadata.PORT_BUS_EXPANDED]).toBe(false);
        expect(bus.args[WorkflowDiagramMetadata.PORT_BUS_MEMBERS]).toBe(3);
        expect(bus.children[0].text).toBe('out');
    });

    it('leaves room in its label for the toggle in front of the name', () => {
        const children = model();
        const bus = nodeOf(children, 'u_prod').children.find((c: any) => c.id === 'u_prod_bus_out');
        const clk = nodeOf(children, 'u_prod').children.find((c: any) => c.id === 'u_prod_port_clk');
        const slot = WorkflowDiagramConstants.PORT_BUS_TOGGLE_PX + WorkflowDiagramConstants.PORT_BUS_TOGGLE_GAP_PX;
        // `out` and `clk` are as long, so the difference is the slot alone.
        expect(bus.children[0].size.width - clk.children[0].size.width).toBe(slot);
    });

    it('makes a shorter node than its members did', () => {
        const closed = nodeOf(model(), 'u_prod');
        const open = nodeOf(model({ u_prod: ['out'] }), 'u_prod');
        expect(closed.size.height).toBeLessThan(open.size.height);
    });

    it('is not made of a bundle of one', () => {
        const lone: PyGraphDocument = {
            version: '1',
            graph: { id: 'root', nodes: [{ ...consumer, ports: [port(C, 's_valid', 'in', 's'), port(C, 'q', 'out')] }], edges: [] }
        };
        expect(bundlePorts(lone)).toBe(lone);
    });

    it('becomes a bus on each side when the producer left its members on both', () => {
        const split: PyGraphDocument = {
            version: '1',
            graph: { id: 'root', nodes: [{ ...consumer, ports: [
                port(C, 'x_valid', 'in', 'x'), port(C, 'x_data', 'in', 'x'),
                port(C, 'x_ready', 'out', 'x'), port(C, 'x_last', 'out', 'x')
            ] }], edges: [] }
        };
        const children = new GraphGModelSource().transform(split).graph.children ?? [];
        expect(portIds(nodeOf(children, 'u_cons'))).toEqual(['u_cons_bus_x@west', 'u_cons_bus_x@east']);
    });
});

describe('the connections between two buses', () => {
    it('are one edge while both ends are closed, running the way most of them do', () => {
        const buses = edgesOf(model()).filter(e => e.cssClasses?.includes(WorkflowDiagramCss.EDGE_BUS));
        expect(buses).toHaveLength(1);
        // `ready` runs from the consumer; data and valid outvote it.
        expect(buses[0].sourceId).toBe('u_prod_bus_out');
        expect(buses[0].targetId).toBe('u_cons_bus_s');
        expect(buses[0].args[WorkflowDiagramMetadata.EDGE_BUS_MEMBERS]).toBe(3);
        expect(buses[0].args['wf:from']).toBe('u_prod');
        expect(buses[0].args['wf:to']).toBe('u_cons');
    });

    it('keep the facts every member states, and drop the ones they differ on', () => {
        const merged = bundlePorts(doc).graph.edges.find(e => e.bus);
        expect(merged?.meta).toEqual({ role: 'data' });
        expect(merged?.bus?.members).toEqual(channel.map(e => e.id));
    });

    it('stay one edge with one end open, drawn from the open bundle’s header', () => {
        const children = model({ u_prod: ['out'] });
        expect(portIds(nodeOf(children, 'u_prod'))).toEqual([
            'u_prod_port_clk', 'u_prod_bus_out', 'u_prod_port_out_valid', 'u_prod_port_out_ready', 'u_prod_port_out_data'
        ]);
        const member = nodeOf(children, 'u_prod').children.find((c: any) => c.id === 'u_prod_port_out_valid');
        expect(member.args[WorkflowDiagramMetadata.PORT_BUS_MEMBER_OF]).toBe('out');
        expect(member.cssClasses).toContain(WorkflowDiagramCss.PORT_BUS_MEMBER);
        const header = nodeOf(children, 'u_prod').children.find((c: any) => c.id === 'u_prod_bus_out');
        expect(header.args[WorkflowDiagramMetadata.PORT_BUS_EXPANDED]).toBe(true);

        const buses = edgesOf(children).filter(e => e.cssClasses?.includes(WorkflowDiagramCss.EDGE_BUS));
        expect(buses.map(e => [e.sourceId, e.targetId])).toEqual([['u_prod_bus_out', 'u_cons_bus_s']]);
    });

    it('are drawn member to member, as the producer sent them, once both ends are open', () => {
        const children = model({ u_prod: ['out'], u_cons: ['s'] });
        const edges = edgesOf(children);
        expect(edges.some(e => e.cssClasses?.includes(WorkflowDiagramCss.EDGE_BUS))).toBe(false);
        expect(edges.map(e => e.id)).toEqual(expect.arrayContaining(channel.map(e => e.id)));
        const ready = edges.find(e => e.id === channel[1].id);
        expect([ready.sourceId, ready.targetId]).toEqual(['u_cons_port_s_ready', 'u_prod_port_out_ready']);
    });

    it('leave an edge to a port outside any bundle alone', () => {
        const q = edgesOf(model()).find(e => e.id === `edge:port:${C}:q->port:wf:output:q:in`);
        expect(q.sourceId).toBe('u_cons_port_q');
    });
});

describe('the layout file', () => {
    async function withService(run: (service: LayoutPersistenceService, file: string) => Promise<void>): Promise<void> {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'port-buses-'));
        try {
            await run(new LayoutPersistenceService(0), path.join(dir, 'top.sv'));
        } finally {
            await fs.rm(dir, { recursive: true, force: true });
        }
    }

    it('keeps the open bundles beside the positions, and a save of positions keeps them', () => {
        return withService(async (service, file) => {
            await service.saveLayoutImmediate(file, 'top', new Map([['u_prod', { x: 1, y: 2 }]]));
            await service.setPortBusExpanded(file, 'top', 'u_prod', 'out', true);
            await service.setPortBusExpanded(file, 'top', 'u_cons', 's', true);
            await service.saveLayoutImmediate(file, 'top', new Map([['u_prod', { x: 5, y: 6 }]]));

            const open = await service.loadPortBuses(file, 'top');
            expect(open && Object.fromEntries([...open].map(([k, v]) => [k, [...v]]))).toEqual({ u_prod: ['out'], u_cons: ['s'] });
            expect(await service.loadLayout(file, 'top')).toEqual(new Map([['u_prod', { x: 5, y: 6 }]]));
        });
    });

    it('remembers closing the last bundle as a choice, and is still no layout without positions', () => {
        return withService(async (service, file) => {
            expect(await service.loadPortBuses(file, 'top')).toBeUndefined();
            await service.setPortBusExpanded(file, 'top', 'u_prod', 'out', true);
            await service.setPortBusExpanded(file, 'top', 'u_prod', 'out', false);
            expect(await service.loadPortBuses(file, 'top')).toEqual(new Map());
            // A nested view that only opened a bundle still takes its fallback's positions.
            expect(await service.loadLayout(file, 'top')).toBeUndefined();
        });
    });
});

describe('the toggle', () => {
    it('undoes by closing what it opened', async () => {
        const calls: boolean[] = [];
        const command = new TogglePortBusCommand(async open => { calls.push(open); }, true);
        await command.execute();
        await command.undo();
        await command.redo();
        expect(calls).toEqual([true, false, true]);
    });

    it('saves the bundle, rebuilds the model, then reroutes the node’s edges', async () => {
        const steps: string[] = [];
        const handler = new WorkflowTogglePortBusOperationHandler();
        (handler as any).layoutPersistence = {
            setPortBusExpanded: async (...args: unknown[]) => { steps.push(`save ${JSON.stringify(args)}`); }
        };
        (handler as any).sourceModelStorage = { rebuildFromLastDocument: async () => { steps.push('rebuild'); return true; } };
        (handler as any).rerouteHandler = { runReroute: async (op: any) => { steps.push(`reroute ${op.elementIds}`); } };
        await handler.apply({ layout: { filePath: '/w/top.sv', networkId: 'top' }, nodeId: 'u_prod', nodeKey: 'u_prod', group: 'out' }, true);
        expect(steps).toEqual(['save ["/w/top.sv","top","u_prod","out",true]', 'rebuild', 'reroute u_prod']);
    });
});
