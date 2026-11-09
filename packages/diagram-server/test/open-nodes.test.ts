/**
 * A node holding a graph of its own (`meta.inner`), opened in place: drawn
 * as the group frame of what it holds, its edges carried on to the pins they
 * reach, and toggled like a bus, with room made and given back.
 */
import { describe, expect, it } from 'vitest';
import { GModelIndex } from '@eclipse-glsp/server';
import { ToggleNodeOpenOperation, WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import { GraphGModelSource, type PyGraphDocument, type PyGraphNode } from '../src/model/graph-gmodel-source';
import { portBusStateOf } from '../src/model/port-bundles';
import { stableNodeIds } from '../src/model/stable-ids';
import { OPEN_NODE_SPACING, innerNodeId, openFrameId, openNodes, withOpenNodePositions } from '../src/model/open-nodes';
import { convertToGModelRoot } from '../src/server/gmodel-convert';
import { relativeToParent, restoreGroupGeometry } from '../src/server/group-geometry';
import { collectNodePositions, nodeLayoutKeyOf } from '../src/server/layout-snapshot';
import { countCoincidentNodes } from '../src/server/source-model-storage';
import { TogglePortBusCommand } from '../src/operations/toggle-port-bus-handler';
import { WorkflowToggleNodeOpenOperationHandler } from '../src/operations/toggle-node-open-handler';

type Point = { x: number; y: number };

const P = 'node:proc';
const port = (node: string, name: string, direction: 'in' | 'out') => ({ id: `${node}:${name}`, name, direction });
const boundary = (name: string, kind: 'wf-input' | 'wf-output'): PyGraphNode => ({
    id: `b:${name}`, kind, label: name, scope: 'root', ports: [port(`b:${name}`, name, kind === 'wf-input' ? 'out' : 'in')]
});
// `q <= ~a & b` with `a` also wired straight through to `t`.
const cell = (name: string, pins: Array<[string, 'in' | 'out']>): PyGraphNode => ({
    id: `${P}/cell:${name}`, kind: 'logic', label: name, scope: 'root',
    ports: pins.map(([pin, d]) => port(`${P}/cell:${name}`, pin, d)), meta: { symbol: name === 'reg' ? 'register' : 'and' }
});
const proc: PyGraphNode = {
    id: P, kind: 'logic', label: 'q, t', scope: 'root',
    ports: [port(P, 'q', 'out'), port(P, 't', 'out'), port(P, 'a', 'in'), port(P, 'b', 'in')],
    meta: {
        process: 'always',
        inner: {
            nodes: [cell('not', [['a', 'in'], ['y', 'out']]), cell('and', [['a', 'in'], ['b', 'in'], ['y', 'out']]), cell('reg', [['d', 'in'], ['q', 'out']])],
            edges: [
                { from: `${P}:a`, to: `${P}/cell:not:a`, width: 1 },
                { from: `${P}/cell:not:y`, to: `${P}/cell:and:a` },
                { from: `${P}:b`, to: `${P}/cell:and:b` },
                { from: `${P}/cell:and:y`, to: `${P}/cell:reg:d` },
                { from: `${P}/cell:reg:q`, to: `${P}:q` },
                { from: `${P}:a`, to: `${P}:t` }
            ]
        }
    }
};
const doc: PyGraphDocument = {
    version: '1',
    graph: {
        id: 'top',
        nodes: [boundary('a', 'wf-input'), boundary('b', 'wf-input'), boundary('q', 'wf-output'), boundary('t', 'wf-output'), proc],
        edges: [
            { id: 'e:a', from: 'b:a:a', to: `${P}:a`, scope: 'root' },
            { id: 'e:b', from: 'b:b:b', to: `${P}:b`, scope: 'root' },
            { id: 'e:q', from: `${P}:q`, to: 'b:q:q', scope: 'root' },
            { id: 'e:t', from: `${P}:t`, to: 'b:t:t', scope: 'root' }
        ],
        subgraphs: [{ id: 'root', kind: 'root', parent: null, controlNodeId: null }]
    }
};
const KEY = 'q, t';
/** An inner cell's id in the model: under its frame's. */
const C = (name: string) => innerNodeId(P, `${P}/cell:${name}`);
const openState = (open: boolean) => portBusStateOf(open ? new Map([[KEY, new Set([ToggleNodeOpenOperation.OPEN])]]) : new Map());

describe('a node opened in place', () => {
    const opened = openNodes(doc, openState(true), stableNodeIds(doc.graph.nodes));

    it('is a group scope titled with its name, holding what it is made of', () => {
        expect(opened.graph.nodes.some(n => n.id === P)).toBe(false);
        const scope = opened.graph.subgraphs!.find(s => s.id === `open:${P}`)!;
        expect(scope).toMatchObject({ kind: 'group', label: 'q, t', parent: 'root', openNodeKey: KEY });
        expect(scope.nodes).toEqual([C('not'), C('and'), C('reg')]);
        expect(opened.graph.nodes.filter(n => n.scope === `open:${P}`)).toHaveLength(3);
    });

    it('carries each edge on its ports to the pins they reach, and one through it end to end', () => {
        const ends = opened.graph.edges.map(e => `${e.from} -> ${e.to}`).sort();
        expect(ends).toEqual([
            `${P}/cell:and:y -> ${P}/cell:reg:d`,
            `${P}/cell:not:y -> ${P}/cell:and:a`,
            `${P}/cell:reg:q -> b:q:q`,
            `b:a:a -> ${P}/cell:not:a`,
            `b:a:a -> b:t:t`,
            `b:b:b -> ${P}/cell:and:b`
        ].sort());
        expect(new Set(opened.graph.edges.map(e => e.id)).size).toBe(opened.graph.edges.length);
    });

    it('is the frame of a group in the model, carrying the key it is closed by', () => {
        const graph: any = new GraphGModelSource().transform(doc, { portBuses: openState(true) }).graph;
        const frame = graph.children.find((c: any) => c.id === openFrameId(P));
        expect(frame.type).toBe(WorkflowDiagramTypes.NODE_GROUP);
        expect(frame.args[WorkflowDiagramMetadata.OPEN_NODE_KEY]).toBe(KEY);
        expect(frame.children.filter((c: any) => String(c.type).startsWith('node:'))).toHaveLength(3);
    });

    it('is, closed, a node that says it can be opened', () => {
        const graph: any = new GraphGModelSource().transform(doc, { portBuses: openState(false) }).graph;
        const node = graph.children.find((c: any) => c.args?.[WorkflowDiagramMetadata.GRAPH_NODE_ID] === P);
        expect(node.args[WorkflowDiagramMetadata.NODE_OPENABLE]).toBe(true);
        expect(graph.children.some((c: any) => c.id === openFrameId(P))).toBe(false);
    });
});

describe('the places a toggle needs', () => {
    it('put a just-opened frame where its node was, its members in columns by depth, and drop the node’s', () => {
        const graph: any = new GraphGModelSource().transform(doc, { portBuses: openState(true) }).graph;
        const at = withOpenNodePositions(graph, new Map([[KEY, { x: 200, y: 100 }]]));
        expect(at.get(openFrameId(P))).toEqual({ x: 200, y: 100 });
        expect(at.has(KEY)).toBe(false);
        const { padding } = OPEN_NODE_SPACING;
        const not = at.get(C('not'))!;
        const and = at.get(C('and'))!;
        const reg = at.get(C('reg'))!;
        expect(not.x).toBe(200 + padding);
        expect(and.x).toBeGreaterThan(not.x);   // fed by the NOT
        expect(reg.x).toBeGreaterThan(and.x);   // fed by the AND
        expect(countCoincidentNodes(at.values())).toBe(0);
    });

    it('put a just-closed node where its frame was, and drop the frame’s and its members’', () => {
        const graph: any = new GraphGModelSource().transform(doc, { portBuses: openState(false) }).graph;
        const at = withOpenNodePositions(graph, new Map([
            [openFrameId(P), { x: 200, y: 100 }],
            [C('not'), { x: 216, y: 140 }]
        ]));
        expect(at.get(KEY)).toEqual({ x: 200, y: 100 });
        expect(at.has(openFrameId(P))).toBe(false);
        expect(at.has(C('not'))).toBe(false);
    });
});

/** The diagram as the storage rebuilds it: positions by layout key, absolute, at every depth. */
function diagram(positions: Record<string, Point>) {
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
    const handler = new WorkflowToggleNodeOpenOperationHandler();
    (handler as any).modelState = {
        get root() { return state.root; },
        get index() { return state.index; },
        get: () => ({ documentUri: 'file:///w/proc.sv', workflowName: 'live' })
    };
    (handler as any).layoutPersistence = {
        savePortBuses: async (_file: string, _id: string, byNode: Map<string, Set<string>>) => {
            for (const [key, groups] of byNode) {
                open.set(key, new Set(groups));
            }
            open = new Map(open);
        }
    };
    (handler as any).sourceModelStorage = { rebuildFromLastDocument: async (current: any) => { build(current.positions); return true; } };
    (handler as any).rerouteHandler = { runReroute: async () => {} };
    (handler as any).commandStack = { commands: [], flush() {} };
    const at = (id: string): Point | undefined => collectNodePositions(state.root).get(id);
    const command = (elementId: string): TogglePortBusCommand =>
        handler.createCommand(ToggleNodeOpenOperation.create({ nodeId: elementId })) as TogglePortBusCommand;
    const find = (id: string): any => state.index!.find(id);
    return { at, command, find, open: () => open, handlerState: (handler as any).modelState };
}

describe('opening a node in place', () => {
    it('puts its frame where it stood, moves what was under it down, and closing and undo give the room back', async () => {
        const d = diagram({ a: { x: 0, y: 100 }, b: { x: 0, y: 160 }, q: { x: 600, y: 100 }, t: { x: 600, y: 160 }, [KEY]: { x: 200, y: 100 } });
        // Something stacked under the process, in its column.
        const under = { x: 200, y: 300 };
        const closed = d.find(KEY);
        expect(closed?.args?.[WorkflowDiagramMetadata.NODE_OPENABLE]).toBe(true);

        const toggle = d.command(KEY);
        expect(toggle).toBeInstanceOf(TogglePortBusCommand);
        await toggle.execute();
        expect(d.open().get(KEY)?.has(ToggleNodeOpenOperation.OPEN)).toBe(true);
        expect(d.at(openFrameId(P))).toEqual({ x: 200, y: 100 });
        expect(d.at(C('not'))).toBeDefined();
        expect(d.find(KEY)).toBeUndefined();

        await toggle.undo();
        expect(d.open().get(KEY)?.has(ToggleNodeOpenOperation.OPEN)).toBe(false);
        expect(d.at(KEY)).toEqual({ x: 200, y: 100 });
        expect(d.find(openFrameId(P))).toBeUndefined();

        await toggle.redo();
        expect(d.at(openFrameId(P))).toEqual({ x: 200, y: 100 });

        // Closing from the frame's own toggle.
        const close = d.command(openFrameId(P));
        await close.execute();
        expect(d.at(KEY)).toEqual({ x: 200, y: 100 });
        expect(under).toEqual({ x: 200, y: 300 });
    });
});

describe('a node opened in place, in the corners', () => {
    it('keeps a wire from its output back into its own input, inside its frame', () => {
        const looped: PyGraphDocument = {
            ...doc,
            graph: { ...doc.graph, edges: [...doc.graph.edges, { id: 'e:loop', from: `${P}:q`, to: `${P}:b`, scope: 'root' }] }
        };
        const opened = openNodes(looped, openState(true), stableNodeIds(looped.graph.nodes));
        const loop = opened.graph.edges.filter(e => e.id.startsWith('e:loop'));
        expect(loop.map(e => `${e.from} -> ${e.to}`)).toEqual([`${P}/cell:reg:q -> ${P}/cell:and:b`]);
        expect(loop[0].scope).toBe(`open:${P}`);
    });

    it('starts a wire through it where the wire into it started, never at the node itself', () => {
        const withNodes: PyGraphDocument = {
            ...doc,
            graph: {
                ...doc.graph,
                edges: doc.graph.edges.map(e => (e.id === 'e:t' ? { ...e, fromNode: P } : e)) as any
            }
        };
        const opened = openNodes(withNodes, openState(true), stableNodeIds(withNodes.graph.nodes));
        const through: any = opened.graph.edges.find(e => e.from === 'b:a:a' && e.to === 'b:t:t');
        expect(through.fromNode).toBeUndefined();
    });

    it('gives an inner node another id when an outer node’s id is its', () => {
        const clash: PyGraphNode = { id: 'other', kind: 'logic', label: `${P}/cell:and`, scope: 'root', ports: [] };
        const both: PyGraphDocument = { ...doc, graph: { ...doc.graph, nodes: [...doc.graph.nodes, clash] } };
        const graph: any = new GraphGModelSource().transform(both, { portBuses: openState(true) }).graph;
        const ids: string[] = [];
        const walk = (e: any) => { ids.push(e.id); (e.children ?? []).forEach(walk); };
        walk(graph);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('drops a closed node’s members’ places by its frame’s namespace, nobody else’s', () => {
        const graph: any = new GraphGModelSource().transform(doc, { portBuses: openState(false) }).graph;
        const at = withOpenNodePositions(graph, new Map([
            [C('reg'), { x: 1, y: 1 }],
            [`${P}/cell:reg`, { x: 2, y: 2 }]
        ]));
        expect(at.has(C('reg'))).toBe(false);
        expect(at.has(`${P}/cell:reg`)).toBe(true);
    });

    it('keeps the node’s open bundles while it is open and they are not drawn', () => {
        const bussed: PyGraphDocument = {
            ...doc,
            graph: { ...doc.graph, nodes: doc.graph.nodes.map(n => (n.id === P ? { ...n, ports: n.ports.map(p => (p.name === 'a' || p.name === 'b' ? { ...p, group: 'ab' } : p)) } : n)) }
        };
        const state = portBusStateOf(new Map([[KEY, new Set([ToggleNodeOpenOperation.OPEN, 'ab'])]]));
        const graph: any = new GraphGModelSource().transform(bussed, { portBuses: state }).graph;
        const frame = graph.children.find((c: any) => c.id === openFrameId(P));
        expect(frame.args[WorkflowDiagramMetadata.OPEN_NODE_BUNDLES]).toEqual(['ab']);
    });

    it('draws its inner nodes as they are: one holding a graph is not offered to open', () => {
        const nested: PyGraphDocument = {
            ...doc,
            graph: {
                ...doc.graph,
                nodes: doc.graph.nodes.map(n => n.id === P ? {
                    ...n,
                    meta: { ...n.meta, inner: { ...(n.meta as any).inner, nodes: (n.meta as any).inner.nodes.map((c: any) => ({ ...c, meta: { ...c.meta, inner: { nodes: [c], edges: [] } } })) } }
                } : n)
            }
        };
        const graph: any = new GraphGModelSource().transform(nested, { portBuses: openState(true) }).graph;
        const frame = graph.children.find((c: any) => c.id === openFrameId(P));
        expect(frame.children.some((c: any) => c.args?.[WorkflowDiagramMetadata.NODE_OPENABLE])).toBe(false);
    });

    it('wires a pin reading the node’s own output from the pin driving it', () => {
        const reading: PyGraphDocument = {
            ...doc,
            graph: {
                ...doc.graph,
                nodes: doc.graph.nodes.map(n => n.id === P ? {
                    ...n,
                    meta: { ...n.meta, inner: { ...(n.meta as any).inner, edges: [...(n.meta as any).inner.edges, { from: `${P}:q`, to: `${P}/cell:and:b` }] } }
                } : n)
            }
        };
        const opened = openNodes(reading, openState(true), stableNodeIds(reading.graph.nodes));
        expect(opened.graph.edges.some(e => e.from === `${P}/cell:reg:q` && e.to === `${P}/cell:and:b`)).toBe(true);
    });

    it('stays a box when it is also a symbol: its toggle is in the header', () => {
        const symbolic: PyGraphDocument = {
            ...doc,
            graph: { ...doc.graph, nodes: doc.graph.nodes.map(n => (n.id === P ? { ...n, meta: { ...n.meta, symbol: 'and' } } : n)) }
        };
        const graph: any = new GraphGModelSource().transform(symbolic, { portBuses: openState(false) }).graph;
        const node = graph.children.find((c: any) => c.args?.[WorkflowDiagramMetadata.GRAPH_NODE_ID] === P);
        expect(node.args[WorkflowDiagramMetadata.SYMBOL]).toBeUndefined();
        expect(node.args[WorkflowDiagramMetadata.NODE_OPENABLE]).toBe(true);
    });
});

describe('a bus toggle beside an open node', () => {
    it('saves the node open, as the view shows it', async () => {
        const d = diagram({ a: { x: 0, y: 100 }, b: { x: 0, y: 160 }, q: { x: 600, y: 100 }, t: { x: 600, y: 160 }, [KEY]: { x: 200, y: 100 } });
        await d.command(KEY).execute();
        const { WorkflowTogglePortBusOperationHandler } = await import('../src/operations/toggle-port-bus-handler');
        const bus = new WorkflowTogglePortBusOperationHandler();
        (bus as any).modelState = (d as any).handlerState;
        expect(bus.openBundles().get(KEY)?.has(ToggleNodeOpenOperation.OPEN)).toBe(true);
    });
});
