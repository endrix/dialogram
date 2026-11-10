/**
 * Opening or closing a bus, or a node in place, lays the whole view out
 * again; undo and redo put back the layout the view had before and after,
 * without laying it out again. A product that asks for it
 * (`toggleLayout: 'make-room'`) keeps every node and pushes the ones under.
 *
 * The rebuild is the storage's, as in port-bus-room.test.ts: positions
 * carried over absolute, by layout key. The layout is a stand-in that moves
 * every node, so a laid-out view is told from one that was not.
 */
import { describe, expect, it } from 'vitest';
import { GModelIndex } from '@eclipse-glsp/server';
import { ToggleNodeOpenOperation, WorkflowDiagramMetadata } from '@dialogram/shared';
import { GraphGModelSource, type PyGraphDocument, type PyGraphNode } from '../src/model/graph-gmodel-source';
import { portBusStateOf } from '../src/model/port-bundles';
import { openFrameId, withOpenNodePositions } from '../src/model/open-nodes';
import { convertToGModelRoot } from '../src/server/gmodel-convert';
import { relativeToParent, restoreGroupGeometry } from '../src/server/group-geometry';
import { collectNodePositions, isMovableNode, nodeLayoutKeyOf } from '../src/server/layout-snapshot';
import type { StorageRuntimeOptions } from '../src/server/storage-runtime-options';
import { TogglePortBusCommand, WorkflowTogglePortBusOperationHandler } from '../src/operations/toggle-port-bus-handler';
import { WorkflowToggleNodeOpenOperationHandler } from '../src/operations/toggle-node-open-handler';

type Point = { x: number; y: number };

const port = (node: string, name: string, direction: 'in' | 'out', group?: string, side?: string) =>
    ({ id: `${node}:${name}`, name, direction, ...(group ? { group } : {}), ...(side ? { side } : {}) });

// A unit with a bus of four, and two nodes beside it.
const U = 'node:scope:root:u_prod';
const simple = (label: string): PyGraphNode => {
    const id = `node:scope:root:${label}`;
    return { id, kind: 'instance', label, scope: 'root', ports: [port(id, 'i', 'in'), port(id, 'o', 'out')] };
};
const busDoc: PyGraphDocument = {
    version: '1',
    graph: {
        id: 'root',
        nodes: [
            { id: U, kind: 'instance', label: 'u_prod', scope: 'root',
                ports: [port(U, 'clk', 'in'), ...['awaddr', 'awvalid', 'wdata', 'wvalid'].map(n => port(U, n, 'out', 'm_axi', 'east'))] },
            simple('u_cons'),
            simple('u_x')
        ],
        edges: [],
        subgraphs: []
    } as any
};

// A process that holds a graph of its own (open-nodes.test.ts).
const P = 'node:proc';
const cell = (name: string, pins: Array<[string, 'in' | 'out']>): PyGraphNode => ({
    id: `${P}/cell:${name}`, kind: 'logic', label: name, scope: 'root',
    ports: pins.map(([pin, d]) => port(`${P}/cell:${name}`, pin, d)), meta: { symbol: 'and' }
});
const procDoc: PyGraphDocument = {
    version: '1',
    graph: {
        id: 'top',
        nodes: [
            {
                id: P, kind: 'logic', label: 'y', scope: 'root',
                ports: [port(P, 'y', 'out'), port(P, 'a', 'in'), port(P, 'b', 'in')],
                meta: {
                    process: 'always',
                    inner: {
                        nodes: [cell('and', [['a', 'in'], ['b', 'in'], ['y', 'out']])],
                        edges: [
                            { from: `${P}:a`, to: `${P}/cell:and:a` },
                            { from: `${P}:b`, to: `${P}/cell:and:b` },
                            { from: `${P}/cell:and:y`, to: `${P}:y` }
                        ]
                    }
                }
            },
            simple('u_next')
        ],
        edges: [],
        subgraphs: [{ id: 'root', kind: 'root', parent: null, controlNodeId: null }]
    } as any
};
const PROC_KEY = 'y';

let session = 0;

function diagram<H extends WorkflowTogglePortBusOperationHandler>(
    doc: PyGraphDocument,
    handler: H,
    positions: Record<string, Point>,
    options?: StorageRuntimeOptions
) {
    let open = new Map<string, Set<string>>();
    const state: { root?: any; index?: GModelIndex } = {};
    const place = (element: any, at: Map<string, Point>, parentAt: Point): void => {
        const key = typeof element.type === 'string' && element.type.startsWith('node:') ? nodeLayoutKeyOf(element) : undefined;
        const saved = key ? at.get(key) : undefined;
        let here = parentAt;
        if (saved) {
            element.position = relativeToParent(saved, parentAt);
            here = saved;
        }
        for (const child of element.children ?? []) {
            place(child, at, here);
        }
    };
    const rebuilds: Array<Map<string, Point>> = [];
    const build = (saved: Map<string, Point>): void => {
        const built: any = new GraphGModelSource().transform(doc, { portBuses: portBusStateOf(open) });
        const at = withOpenNodePositions(built.graph, saved);
        for (const element of built.graph.children ?? []) {
            place(element, at, { x: 0, y: 0 });
        }
        const root: any = convertToGModelRoot(built);
        restoreGroupGeometry(root, undefined);
        const index = new GModelIndex();
        index.indexRoot(root);
        state.root = root;
        state.index = index;
    };
    build(new Map(Object.entries(positions)));
    const uri = `file:///w/relayout${++session}.sv`;
    // The layout meta and the view's model are one object here: what the
    // handler reads of either is there.
    const shared: any = { documentUri: uri, workflowName: 'live', didInitialLayout: false };
    (handler as any).modelState = {
        get root() { return state.root; },
        get index() { return state.index; },
        get: () => shared,
        set: () => {}
    };
    const saved: Array<Map<string, Point>> = [];
    (handler as any).layoutPersistence = {
        savePortBuses: async (_file: string, _id: string, byNode: Map<string, Set<string>>) => {
            open = new Map([...byNode].map(([key, groups]) => [key, new Set(groups)]));
        },
        saveLayoutImmediate: async (_file: string, _id: string, at: Map<string, Point>) => {
            saved.push(new Map(at));
        }
    };
    // As the storage's rebuild: the layout meta made anew, judging the
    // positions it was given against the nodes the model has.
    (handler as any).sourceModelStorage = {
        rebuildFromLastDocument: async (current: any) => {
            rebuilds.push(new Map(current.positions));
            build(current.positions);
            let unpositioned = 0;
            const count = (element: any): void => {
                const key = typeof element.type === 'string' && element.type.startsWith('node:') ? nodeLayoutKeyOf(element) : undefined;
                if (key && !current.positions.has(key)) {
                    unpositioned++;
                }
                (element.children ?? []).forEach(count);
            };
            count(state.root);
            Object.assign(shared, { hasPersistedLayout: unpositioned === 0, unpositionedNodeCount: unpositioned, didInitialLayout: false });
            return true;
        }
    };
    const layouts: unknown[] = [];
    let failing = false;
    // A layout: every top-level node 1000 to the right.
    (handler as any).layoutHandler = {
        runLayout: async (operation: unknown) => {
            layouts.push(operation);
            if (failing) {
                throw new Error('elk timed out');
            }
            for (const child of state.root.children ?? []) {
                if (isMovableNode(child) && child.position) {
                    child.position = { x: child.position.x + 1000, y: child.position.y };
                }
            }
        }
    };
    const rerouted: unknown[] = [];
    (handler as any).rerouteHandler = { runReroute: async (op: unknown) => { rerouted.push(op); } };
    (handler as any).commandStack = { commands: [], flush() {} };
    (handler as any).storageOptions = options;
    const at = (id: string): Point | undefined => collectNodePositions(state.root).get(id);
    const find = (id: string): any => state.index!.find(id);
    const failLayout = (): void => { failing = true; };
    return { handler, at, find, layouts, rebuilds, saved, rerouted, shared, failLayout, open: () => open };
}

const busDiagram = (options?: StorageRuntimeOptions, doc: PyGraphDocument = busDoc) => {
    const d = diagram(doc, new WorkflowTogglePortBusOperationHandler(), {
        u_prod: { x: 0, y: 0 }, u_cons: { x: 0, y: 200 }, u_x: { x: 300, y: 0 }
    }, options);
    const command = (): TogglePortBusCommand =>
        d.handler.createCommand({ kind: 'dialogram.togglePortBus', portId: 'u_prod_bus_m_axi' } as any) as TogglePortBusCommand;
    const expanded = (): boolean => d.find('u_prod_bus_m_axi')?.args?.[WorkflowDiagramMetadata.PORT_BUS_EXPANDED] === true;
    return { ...d, command, expanded };
};

describe('a bus toggle lays the whole view out again', () => {
    it('once, as Layout Diagram does, from the positions drawn now', async () => {
        const d = busDiagram();
        const toggle = d.command();
        await toggle.execute();
        expect(d.expanded()).toBe(true);
        expect(d.layouts).toHaveLength(1);
        // The whole view: no selection to lay out alone.
        expect((d.layouts[0] as any).elementIds).toBeUndefined();
        expect(d.rebuilds[0].get('u_cons')).toEqual({ x: 0, y: 200 });
        expect(d.at('u_cons')).toEqual({ x: 1000, y: 200 });
        expect(d.at('u_x')).toEqual({ x: 1300, y: 0 });
        // Nothing of the room-making path ran.
        expect(d.rerouted).toHaveLength(0);
        // Laid out: the bounds round trip that follows neither lays it out nor parks a node.
        expect(d.shared.didInitialLayout).toBe(true);
    });

    it('closing lays it out again too', async () => {
        const d = busDiagram();
        await d.command().execute();
        await d.command().execute();
        expect(d.expanded()).toBe(false);
        expect(d.layouts).toHaveLength(2);
        expect(d.at('u_cons')).toEqual({ x: 2000, y: 200 });
    });

    it('undo puts back the layout the view had, and redo the one the toggle made, laying out nothing', async () => {
        const d = busDiagram();
        const toggle = d.command();
        await toggle.execute();
        const laidOut = { cons: d.at('u_cons'), x: d.at('u_x'), prod: d.at('u_prod') };

        await toggle.undo();
        expect(d.expanded()).toBe(false);
        expect([d.at('u_prod'), d.at('u_cons'), d.at('u_x')]).toEqual([{ x: 0, y: 0 }, { x: 0, y: 200 }, { x: 300, y: 0 }]);
        // Saved as it is drawn.
        expect(d.saved.at(-1)?.get('u_cons')).toEqual({ x: 0, y: 200 });

        await toggle.redo();
        expect(d.expanded()).toBe(true);
        expect({ cons: d.at('u_cons'), x: d.at('u_x'), prod: d.at('u_prod') }).toEqual(laidOut);
        expect(d.saved.at(-1)?.get('u_cons')).toEqual(laidOut.cons);
        expect(d.layouts).toHaveLength(1);
    });

    it('undo lays the view out instead when the layout it had no longer places every node', async () => {
        // A source edit after the toggle adds a node the layout before it never had.
        const doc = structuredClone(busDoc);
        const d = busDiagram(undefined, doc);
        const toggle = d.command();
        await toggle.execute();
        doc.graph.nodes.push(simple('u_new'));
        await toggle.undo();
        expect(d.expanded()).toBe(false);
        expect(d.layouts).toHaveLength(2);
        expect(d.shared.didInitialLayout).toBe(true);
    });

    it('a layout that fails leaves the view built again, with room made, and nothing thrown', async () => {
        const d = busDiagram();
        d.failLayout();
        const under = { x: 0, y: d.find('u_prod').size.height + 20 };
        d.find('u_cons').position = { ...under };
        await d.command().execute();
        expect(d.expanded()).toBe(true);
        expect(d.layouts).toHaveLength(1);
        // Built again from the positions drawn before, and the column under the bus pushed.
        expect(d.rebuilds).toHaveLength(2);
        expect(d.at('u_x')).toEqual({ x: 300, y: 0 });
        expect(d.at('u_cons')!.y).toBeGreaterThan(under.y);
        expect(d.rerouted).toHaveLength(1);
    });

    it('a product that asks to make room keeps every node and pushes the ones under it', async () => {
        const d = busDiagram({ settingsNamespace: 'x', operationPrefix: 'x', toggleLayout: 'make-room' });
        // Stacked right under the unit, in the growth's reach.
        const under = { x: 0, y: d.find('u_prod').size.height + 20 };
        d.find('u_cons').position = { ...under };
        const toggle = d.command();
        await toggle.execute();
        expect(d.expanded()).toBe(true);
        expect(d.layouts).toHaveLength(0);
        expect(d.at('u_x')).toEqual({ x: 300, y: 0 });
        expect(d.at('u_cons')!.x).toBe(0);
        expect(d.at('u_cons')!.y).toBeGreaterThan(under.y);
        expect(d.rerouted).toHaveLength(1);

        await toggle.undo();
        expect(d.at('u_cons')).toEqual(under);
        expect(d.layouts).toHaveLength(0);
    });
});

describe('a node opened in place lays the whole view out again', () => {
    const procDiagram = () => {
        const d = diagram(procDoc, new WorkflowToggleNodeOpenOperationHandler(), {
            [PROC_KEY]: { x: 200, y: 100 }, u_next: { x: 200, y: 300 }
        });
        const command = (id: string): TogglePortBusCommand =>
            d.handler.createCommand(ToggleNodeOpenOperation.create({ nodeId: id })) as TogglePortBusCommand;
        return { ...d, command };
    };

    it('opening and closing, and undo puts the node back where it stood', async () => {
        const d = procDiagram();
        const toggle = d.command(PROC_KEY);
        await toggle.execute();
        expect(d.find(openFrameId(P))).toBeDefined();
        expect(d.layouts).toHaveLength(1);
        expect(d.at(openFrameId(P))).toEqual({ x: 1200, y: 100 });
        expect(d.at('u_next')).toEqual({ x: 1200, y: 300 });

        await toggle.undo();
        expect(d.find(openFrameId(P))).toBeUndefined();
        expect(d.at(PROC_KEY)).toEqual({ x: 200, y: 100 });
        expect(d.at('u_next')).toEqual({ x: 200, y: 300 });
        expect(d.layouts).toHaveLength(1);

        await toggle.redo();
        expect(d.at(openFrameId(P))).toEqual({ x: 1200, y: 100 });

        // Closed from the frame's own toggle: laid out again.
        await d.command(openFrameId(P)).execute();
        expect(d.find(openFrameId(P))).toBeUndefined();
        expect(d.layouts).toHaveLength(2);
        expect(d.at(PROC_KEY)).toEqual({ x: 2200, y: 100 });
    });
});
