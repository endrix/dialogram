/**
 * A node holding a graph of its own (`meta.inner`), opened in place: drawn
 * as the group frame of what it holds, its edges carried on to the pins they
 * reach, and toggled like a bus, with room made and given back.
 */
import { describe, expect, it } from 'vitest';
import ELK from 'elkjs/lib/elk.bundled.js';
import { DefaultElementFilter } from '@eclipse-glsp/layout-elk';
import { GModelIndex } from '@eclipse-glsp/server';
import { ToggleNodeOpenOperation, WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import { GraphGModelSource, type PyGraphDocument, type PyGraphNode } from '../src/model/graph-gmodel-source';
import { portBusStateOf } from '../src/model/port-bundles';
import { stableNodeIds } from '../src/model/stable-ids';
import { MAX_OPEN_DEPTH, OPEN_NODE_SPACING, canOpen, innerNodeId, isOpenIn, nestedIds, openFrameId, openNodes, withOpenNodePositions } from '../src/model/open-nodes';
import { convertToGModelRoot } from '../src/server/gmodel-convert';
import { relativeToParent, restoreGroupGeometry } from '../src/server/group-geometry';
import { collectEdgeRoutes, collectNodePositions, nodeLayoutKeyOf } from '../src/server/layout-snapshot';
import { WorkflowElkLayoutEngine } from '../src/server/elk-layout-engine';
import { WorkflowLayoutConfigurator } from '../src/server/layout-configurator';
import { idOfNamedNode } from '../src/server/mcp-named-elements';
import { applyBoundaryFlowLayerConstraints } from '../src/operations/boundary-flow-layout';
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
function diagram(positions: Record<string, Point>, source: PyGraphDocument = doc) {
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
        const built: any = new GraphGModelSource().transform(source, { portBuses: portBusStateOf(open) });
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
    return { at, command, find, open: () => open, handlerState: (handler as any).modelState, shownOpen: (): Map<string, Set<string>> => (handler as any).openBundles() };
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

    it('offers an inner node holding a graph of its own to open, closed until the reader opens it', () => {
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
        expect(frame.children.filter((c: any) => c.args?.[WorkflowDiagramMetadata.NODE_OPENABLE] === true)).toHaveLength(3);
        expect(frame.children.some((c: any) => c.type === WorkflowDiagramTypes.NODE_GROUP)).toBe(false);
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

describe('what an inner wire says', () => {
    // `q <= a[3:0] & b`: the bits of `a` the gate takes are written where the wire reaches it.
    const sliced = (pins: boolean): PyGraphDocument => {
        const inner = structuredClone(proc.meta!['inner']) as any;
        inner.pins = pins;
        inner.edges = inner.edges.map((e: any) => e.to === `${P}/cell:and:a`
            ? { ...e, meta: { toSlice: 'not[3:0]', toSliceLabel: 'not[3:0]' } }
            : e.to === `${P}/cell:and:b` ? { ...e, meta: { toSlice: 'b[3:0]', toSliceLabel: 'b[3:0]' } } : e);
        return { ...doc, graph: { ...doc.graph, nodes: doc.graph.nodes.map(n => (n.id === P ? { ...proc, meta: { ...proc.meta, inner } } : n)) } };
    };
    const said = (opened: PyGraphDocument, to: string) => opened.graph.edges.filter(e => e.to === to).map(e => e.meta?.['toSliceLabel']);

    it('is said by the edge drawn for it, between two inner nodes and from a pin of the frame', () => {
        const opened = openNodes(sliced(true), openState(true), stableNodeIds(doc.graph.nodes));
        expect(said(opened, `${P}/cell:and:a`)).toEqual(['not[3:0]']);
        expect(said(opened, `${P}/cell:and:b`)).toEqual(['b[3:0]']);
    });

    it('is said by the wire from outside carried on to the pin it reaches, where the frame keeps no pins', () => {
        const opened = openNodes(sliced(false), openState(true), stableNodeIds(doc.graph.nodes));
        const into = opened.graph.edges.filter(e => e.to === `${P}/cell:and:b`);
        expect(into.map(e => e.from)).toEqual(['b:b:b']);
        expect(into.map(e => e.meta?.['toSliceLabel'])).toEqual(['b[3:0]']);
        // And reaches the model as the bits written at that end.
        const root: any = new GraphGModelSource().transform(sliced(false), { portBuses: openState(true) }).graph;
        const edges: any[] = [];
        const walk = (e: any) => { if (String(e.type).startsWith('edge')) { edges.push(e); } (e.children ?? []).forEach(walk); };
        walk(root);
        // (Cut where it crosses the frame: the piece that reaches the gate.)
        const carried = edges.filter(e => String(e.targetId).endsWith('/cell:and_port_b') && !String(e.targetId).includes('::in::'));
        expect(carried.map(e => e.args?.[WorkflowDiagramMetadata.EDGE_TO_INDEX_LABEL])).toEqual(['b[3:0]']);
    });
});

describe('what inner wires with the same ends, and a moved end, say', () => {
    // proc(a[7:0]) -> y, inside `y = {a[3:0], a[7:4]}`: two wires from `a` to the cell `r`'s pin.
    const Q = 'node:q';
    const pin = (node: string, name: string, direction: 'in' | 'out') => ({ id: `${node}:${name}`, name, direction });
    const reg = (name: string): PyGraphNode => ({
        id: `${Q}/cell:${name}`, kind: 'logic', label: name, scope: 'root', ports: [pin(`${Q}/cell:${name}`, 'd', 'in'), pin(`${Q}/cell:${name}`, 'q', 'out')]
    });
    const state = portBusStateOf(new Map([['q', new Set([ToggleNodeOpenOperation.OPEN])]]));
    const made = (pins: boolean, inner: any[], outer: { into?: Record<string, unknown>; outOf?: Record<string, unknown> } = {}): PyGraphDocument => ({
        version: '1',
        graph: {
            id: 'top',
            nodes: [boundary('a', 'wf-input'), boundary('y', 'wf-output'), {
                id: Q, kind: 'logic', label: 'q', scope: 'root', ports: [pin(Q, 'a', 'in'), pin(Q, 'y', 'out')],
                meta: { inner: { ...(pins ? { pins: true } : {}), nodes: [reg('r'), reg('s')], edges: inner } }
            }],
            edges: [
                { id: 'e:a', from: 'b:a:a', to: `${Q}:a`, scope: 'root', ...(outer.into ? { meta: outer.into } : {}) },
                { id: 'e:y', from: `${Q}:y`, to: 'b:y:y', scope: 'root', ...(outer.outOf ? { meta: outer.outOf } : {}) }
            ],
            subgraphs: [{ id: 'root', kind: 'root', parent: null, controlNodeId: null }]
        }
    });
    const open = (d: PyGraphDocument) => openNodes(d, state, stableNodeIds(d.graph.nodes));
    const slices = (d: PyGraphDocument, to: string) => d.graph.edges.filter(e => e.to === to)
        .map(e => `${e.meta?.['fromSlice'] ?? '-'}>${e.meta?.['toSlice'] ?? '-'}`).sort();
    const swap = [
        { from: `${Q}:a`, to: `${Q}/cell:r:d`, meta: { fromSlice: '3:0', toSlice: '7:4' } },
        { from: `${Q}:a`, to: `${Q}/cell:r:d`, meta: { fromSlice: '7:4', toSlice: '3:0' } },
        { from: `${Q}/cell:r:q`, to: `${Q}:y` }
    ];

    it('is each wire’s own, from a pin of the frame and carried on from outside', () => {
        expect(slices(open(made(true, swap)), `${Q}/cell:r:d`)).toEqual(['3:0>7:4', '7:4>3:0']);
        // Carried on, its start is outside: only the bits it reaches are the inner wire's to say.
        expect(slices(open(made(false, swap)), `${Q}/cell:r:d`)).toEqual(['->3:0', '->7:4']);
    });

    it('is nothing for a wire between inner nodes that says nothing, beside one that does', () => {
        const inner = [
            { from: `${Q}:a`, to: `${Q}/cell:r:d` },
            { from: `${Q}/cell:r:q`, to: `${Q}/cell:s:d`, meta: { toSlice: '7:4' } },
            { from: `${Q}/cell:r:q`, to: `${Q}/cell:s:d` },
            { from: `${Q}/cell:s:q`, to: `${Q}:y` }
        ];
        expect(slices(open(made(true, inner)), `${Q}/cell:s:d`)).toEqual(['->-', '->7:4']);
    });

    it('of a moved end is the inner wire’s where that one says which bits it takes, else the outer’s', () => {
        // The outer wire drives a[7:4]; the inner one takes a[7:4] whole into r.d: r.d is driven whole.
        const taken = made(false, [{ from: `${Q}:a`, to: `${Q}/cell:r:d`, meta: { fromSlice: '7:4' } }, { from: `${Q}/cell:r:q`, to: `${Q}:y` }],
            { into: { toSlice: '7:4' } });
        expect(slices(open(taken), `${Q}/cell:r:d`)).toEqual(['->-']);
        // `a` wired on whole: the bits of the port the outer wire drives are those of the pin.
        const whole = made(false, [{ from: `${Q}:a`, to: `${Q}/cell:r:d` }, { from: `${Q}/cell:r:q`, to: `${Q}:y` }], { into: { toSlice: '7:4' } });
        expect(slices(open(whole), `${Q}/cell:r:d`)).toEqual(['->7:4']);
    });

    it('of the whole wire is the outer wire’s, going in and coming out alike', () => {
        const inner = [
            { from: `${Q}:a`, to: `${Q}/cell:r:d`, meta: { label: 'inner-in', toSlice: '3:0' } },
            { from: `${Q}/cell:r:q`, to: `${Q}:y`, meta: { label: 'inner-out', fromSlice: '1:0' } }
        ];
        const opened = open(made(false, inner, { into: { label: 'outer-in', tone: 'warm' }, outOf: { label: 'outer-out' } }));
        const into = opened.graph.edges.find(e => e.to === `${Q}/cell:r:d`)!;
        const outOf = opened.graph.edges.find(e => e.from === `${Q}/cell:r:q`)!;
        expect(into.meta).toEqual({ label: 'outer-in', tone: 'warm', toSlice: '3:0' });
        expect(outOf.meta).toEqual({ label: 'outer-out', fromSlice: '1:0' });
    });

    it('of a wire reading the node’s own output starts where the pin driving it says', () => {
        const inner = [
            { from: `${Q}/cell:r:q`, to: `${Q}:y`, meta: { fromSlice: '3:0' } },
            { from: `${Q}:y`, to: `${Q}/cell:s:d`, meta: { fromSlice: '7:4', toSlice: '1:0' } },
            { from: `${Q}:a`, to: `${Q}/cell:r:d` }
        ];
        expect(slices(open(made(true, inner)), `${Q}/cell:s:d`)).toEqual(['3:0>1:0']);
    });
});

describe('a frame that holds a wire alone', () => {
    // `else y = t`: a branch whose one statement passes a value on as it is, no node of its own.
    const R = 'node:r';
    const pin = (node: string, name: string, direction: 'in' | 'out') => ({ id: `${node}:${name}`, name, direction });
    const made = (pins: boolean): PyGraphDocument => ({
        version: '1',
        graph: {
            id: 'top',
            nodes: [boundary('t', 'wf-input'), boundary('y', 'wf-output'), {
                id: R, kind: 'logic', label: 'else', scope: 'root', ports: [pin(R, 't', 'in'), pin(R, 'y', 'out')],
                meta: { inner: { open: true, ...(pins ? { pins: true } : {}), nodes: [], edges: [{ from: `${R}:t`, to: `${R}:y`, meta: { role: 'blocking' } }] } }
            }],
            edges: [
                { id: 'e:t', from: 'b:t:t', to: `${R}:t`, scope: 'root' },
                { id: 'e:y', from: `${R}:y`, to: 'b:y:y', scope: 'root' }
            ],
            subgraphs: [{ id: 'root', kind: 'root', parent: null, controlNodeId: null }]
        }
    });

    it('opens where it keeps its pins: the wire across it, from pin to pin, saying what it says', () => {
        const d = made(true);
        expect(canOpen(d.graph.nodes[2], d.graph.subgraphs)).toBe(true);
        const opened = openNodes(d, portBusStateOf(new Map()), stableNodeIds(d.graph.nodes));
        const across = opened.graph.edges.filter(e => e.from === `${R}:t` && e.to === `${R}:y`);
        expect(across.map(e => e.meta?.['role'])).toEqual(['blocking']);
    });

    it('is a node, as before, where its pins would go: there is nothing to put in its place', () => {
        const d = made(false);
        expect(canOpen(d.graph.nodes[2], d.graph.subgraphs)).toBe(false);
    });

    it('is a node, as before, when its wires name pins it does not have: they are no wires', () => {
        const d = made(true);
        const frame = d.graph.nodes[2];
        (frame.meta!['inner'] as { edges: unknown[] }).edges = [{ from: `${R}:t`, to: `${R}:gone` }, { from: 'node:elsewhere:a', to: `${R}:y` }];
        expect(canOpen(frame, d.graph.subgraphs)).toBe(false);
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


/**
 * The same block as a producer of designs draws an always block: with a
 * clock among its ports, something the property panel sets, and what it
 * says of its inside (`open`, `pins`).
 */
const block = (inner: Record<string, unknown>): PyGraphNode => ({
    ...proc,
    type: 'always_ff @(posedge clk)',
    ports: [...proc.ports, { ...port(P, 'clk', 'in'), role: 'clock' }],
    meta: {
        ...proc.meta,
        parameters: [{ name: 'kind', value: 'always_ff', editable: true }],
        inner: { ...(proc.meta!['inner'] as object), ...inner }
    }
});
const withBlock = (node: PyGraphNode): PyGraphDocument =>
    ({ ...doc, graph: { ...doc.graph, nodes: doc.graph.nodes.map(n => (n.id === P ? node : n)) } });
const places = { a: { x: 0, y: 100 }, b: { x: 0, y: 160 }, q: { x: 600, y: 100 }, t: { x: 600, y: 160 }, [KEY]: { x: 200, y: 100 } };

describe('a node its producer draws open', () => {
    const open = withBlock(block({ open: true }));
    const nothing = portBusStateOf(new Map());
    const closedByReader = portBusStateOf(new Map([[KEY, new Set([ToggleNodeOpenOperation.CLOSED])]]));

    it('is open with nothing saved, and with no layout state at all', () => {
        for (const state of [nothing, undefined]) {
            const drawn = openNodes(open, state, stableNodeIds(open.graph.nodes));
            expect(drawn.graph.subgraphs!.some(scope => scope.id === `open:${P}`)).toBe(true);
        }
        expect(isOpenIn(nothing, KEY, block({ open: true }))).toBe(true);
        // Any other node is closed until the reader opens it, and that is listed as before.
        expect(isOpenIn(nothing, KEY, proc)).toBe(false);
        expect(isOpenIn(openState(true), KEY, proc)).toBe(true);
    });

    it('stays closed once the reader closed it, node and frame saying that closing is what to keep', () => {
        const closed: any = new GraphGModelSource().transform(open, { portBuses: closedByReader }).graph;
        const node = closed.children.find((c: any) => c.args?.[WorkflowDiagramMetadata.NODE_OPENABLE] === true);
        expect(node.args[WorkflowDiagramMetadata.NODE_STARTS_OPEN]).toBe(true);
        expect(closed.children.some((c: any) => c.id === openFrameId(P))).toBe(false);
        const shown: any = new GraphGModelSource().transform(open, { portBuses: nothing }).graph;
        expect(shown.children.find((c: any) => c.id === openFrameId(P)).args[WorkflowDiagramMetadata.NODE_STARTS_OPEN]).toBe(true);
        // A node that starts closed says neither.
        const plain: any = new GraphGModelSource().transform(doc, { portBuses: nothing }).graph;
        expect(plain.children.find((c: any) => c.args?.[WorkflowDiagramMetadata.NODE_OPENABLE] === true).args[WorkflowDiagramMetadata.NODE_STARTS_OPEN]).toBeUndefined();
    });

    it('is closed and opened again by its toggle, the layout keeping which', async () => {
        const d = diagram(places, open);
        expect(d.find(openFrameId(P))).toBeDefined();
        await d.command(openFrameId(P)).execute();
        expect(d.open().get(KEY)).toEqual(new Set([ToggleNodeOpenOperation.CLOSED]));
        expect(d.find(openFrameId(P))).toBeUndefined();
        expect(d.at(KEY)).toEqual({ x: 200, y: 100 });
        await d.command(KEY).execute();
        expect(d.open().get(KEY)?.has(ToggleNodeOpenOperation.CLOSED)).toBe(false);
        expect(d.find(openFrameId(P))).toBeDefined();
    });

    it('stays closed through a toggle of something else, which saves what every node shows', async () => {
        const d = diagram(places, open);
        // Open, nothing is listed for it: that is how it starts.
        expect(d.shownOpen().get(KEY)?.has(ToggleNodeOpenOperation.CLOSED) ?? false).toBe(false);
        await d.command(openFrameId(P)).execute();
        // Closed by the reader: what a bus toggle elsewhere saves for it says so again.
        expect(d.shownOpen().get(KEY)).toEqual(new Set([ToggleNodeOpenOperation.CLOSED]));
    });
});

/**
 * An always block whose inside is its statement (`if (a) q <= b;`): the block
 * holds the branch, the branch holds the assignment. Both draw open, their
 * ports on their frames.
 */
const B = `${P}/if:0`;
const A = `${B}/assign:0`;
const branch: PyGraphNode = {
    id: B, kind: 'logic', label: 'if (a)', scope: 'root',
    ports: [port(B, 'a', 'in'), port(B, 'b', 'in'), port(B, 'q', 'out')],
    meta: {
        inner: {
            open: true, pins: true,
            nodes: [{ id: A, kind: 'logic', label: 'q <= b', scope: 'root', ports: [port(A, 'b', 'in'), port(A, 'q', 'out')] }],
            edges: [{ from: `${B}:b`, to: `${A}:b` }, { from: `${A}:q`, to: `${B}:q` }]
        }
    }
};
const statement: PyGraphDocument = {
    ...doc,
    graph: {
        ...doc.graph,
        nodes: [boundary('a', 'wf-input'), boundary('b', 'wf-input'), boundary('q', 'wf-output'), {
            ...proc,
            ports: [port(P, 'q', 'out'), port(P, 'a', 'in'), port(P, 'b', 'in')],
            meta: {
                process: 'always',
                inner: {
                    open: true, pins: true, nodes: [branch],
                    edges: [{ from: `${P}:a`, to: `${B}:a` }, { from: `${P}:b`, to: `${B}:b` }, { from: `${B}:q`, to: `${P}:q` }]
                }
            }
        }],
        edges: doc.graph.edges.filter(e => e.id !== 'e:t')
    }
};
/** The branch's id in the model, under the block's frame, and the key it is saved by. */
const BI = innerNodeId(P, B);
/** The assignment's, under the branch's frame: by what its id adds to the branch's. */
const AI = `${openFrameId(BI)}/assign:0`;

describe('a node opened inside an open node', () => {
    const nothing = portBusStateOf(new Map());

    it('opens in turn, its frame in its parent’s, the wires running pin to pin through both', () => {
        const opened = openNodes(statement, nothing, stableNodeIds(statement.graph.nodes));
        const outer = opened.graph.subgraphs!.find(s => s.id === `open:${P}`)!;
        const inner = opened.graph.subgraphs!.find(s => s.id === `open:${BI}`)!;
        expect(outer).toMatchObject({ parent: 'root' });
        expect(inner).toMatchObject({ kind: 'group', label: 'if (a)', parent: `open:${P}`, openNodeKey: BI });
        expect(inner.pins!.map(pin => pin.name)).toEqual(['a', 'b', 'q']);
        expect(opened.graph.nodes.map(n => n.id).filter(id => id === P || id === BI)).toEqual([]);
        expect(opened.graph.nodes.find(n => n.id === AI)?.scope).toBe(`open:${BI}`);
        expect(opened.graph.edges.map(e => `${e.from} -> ${e.to}`).sort()).toEqual([
            `b:a:a -> ${P}:a`, `b:b:b -> ${P}:b`, `${P}:q -> b:q:q`,
            `${P}:a -> ${B}:a`, `${P}:b -> ${B}:b`, `${B}:q -> ${P}:q`,
            `${B}:b -> ${A}:b`, `${A}:q -> ${B}:q`
        ].sort());
        expect(new Set(opened.graph.edges.map(e => e.id)).size).toBe(opened.graph.edges.length);
    });

    it('is a frame in a frame in the model, which closes on its own, its parent staying open', () => {
        const frames = (state: ReturnType<typeof portBusStateOf>) => {
            const graph: any = new GraphGModelSource().transform(statement, { portBuses: state }).graph;
            const outer = graph.children.find((c: any) => c.id === openFrameId(P));
            return { graph, outer, inner: outer?.children.find((c: any) => c.id === openFrameId(BI)) };
        };
        const open = frames(nothing);
        expect(open.inner.type).toBe(WorkflowDiagramTypes.NODE_GROUP);
        expect(open.inner.args[WorkflowDiagramMetadata.OPEN_NODE_KEY]).toBe(BI);
        const closed = frames(portBusStateOf(new Map([[BI, new Set([ToggleNodeOpenOperation.CLOSED])]])));
        expect(closed.inner).toBeUndefined();
        const node = closed.outer.children.find((c: any) => c.args?.[WorkflowDiagramMetadata.GRAPH_NODE_ID] === BI);
        expect(node.args[WorkflowDiagramMetadata.NODE_OPENABLE]).toBe(true);
        // Closing the block closes all of it: the branch is not drawn, open or not.
        const shut = frames(portBusStateOf(new Map([[KEY, new Set([ToggleNodeOpenOperation.CLOSED])]])));
        expect(shut.outer).toBeUndefined();
        expect(shut.graph.children.find((c: any) => c.args?.[WorkflowDiagramMetadata.GRAPH_NODE_ID] === P)
            .args[WorkflowDiagramMetadata.NODE_OPENABLE]).toBe(true);
    });

    it('is named by what its id adds to its parent’s, the ids growing with the depth, not its square', () => {
        const opened = openNodes(statement, nothing, stableNodeIds(statement.graph.nodes));
        // The branch, held in a node of the document's own graph, keeps its id as ever (layouts are saved by it).
        expect(BI).toBe(`${openFrameId(P)}/${B}`);
        expect(opened.graph.nodes.map(n => n.id)).toEqual(expect.arrayContaining([AI]));
        expect(opened.graph.subgraphs!.map(s => s.id)).toEqual(expect.arrayContaining([`open:${P}`, `open:${BI}`]));
    });

    it('keeps the ids of what an inner node holds where one of them does not start with the node’s', () => {
        expect(nestedIds('h', ['h/x', 'h/y'])).toEqual(['x', 'y']);
        // `h/x` and `x` would be one, `h` and `h/h` too.
        expect(nestedIds('h', ['h/x', 'x'])).toEqual(['h/x', 'x']);
        expect(nestedIds('h', ['h', 'h/h'])).toEqual(['h', 'h/h']);
        const cell = (id: string): any => ({ id, kind: 'logic', label: id, scope: 'root', ports: [] });
        const holder: any = { ...cell('h'), meta: { inner: { open: true, nodes: [cell('h/x'), cell('x')], edges: [] } } };
        const doc: PyGraphDocument = {
            ...statement,
            graph: { ...statement.graph, nodes: statement.graph.nodes.map(n => (n.id === P ? { ...n, meta: { ...n.meta, inner: { open: true, nodes: [holder], edges: [] } } } : n)) }
        };
        const ids = openNodes(doc, nothing, stableNodeIds(doc.graph.nodes)).graph.nodes.map(n => n.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('ends, opened in a graph that holds itself', () => {
        const again: any = { id: B, kind: 'logic', label: 'again', scope: 'root', ports: [], meta: { inner: { open: true, nodes: [], edges: [] } } };
        again.meta.inner.nodes.push(again);
        const looped: PyGraphDocument = {
            ...statement,
            graph: { ...statement.graph, nodes: statement.graph.nodes.map(n => (n.id === P ? { ...n, meta: { ...n.meta, inner: { open: true, nodes: [again], edges: [] } } } : n)) }
        };
        const opened = openNodes(looped, nothing, stableNodeIds(looped.graph.nodes));
        expect(opened.graph.subgraphs!.filter(s => s.id.startsWith('open:'))).toHaveLength(MAX_OPEN_DEPTH);
    });

    it('opened with its parent and never laid out, is left for the layout to place, with what it holds', () => {
        const graph: any = new GraphGModelSource().transform(statement, { portBuses: nothing }).graph;
        const at = withOpenNodePositions(graph, new Map([[KEY, { x: 200, y: 100 }]]));
        expect(at.get(openFrameId(P))).toEqual({ x: 200, y: 100 });
        // Without a size, the members below it would be stacked over it: the view is laid out again.
        expect(at.has(openFrameId(BI))).toBe(false);
        expect(at.has(AI)).toBe(false);
    });

    it('opened with its parent and of a known size, has a place, and so has what it holds', () => {
        const graph: any = new GraphGModelSource().transform(statement, { portBuses: nothing }).graph;
        const find = (element: any): any => element.id === openFrameId(BI) ? element : (element.children ?? []).map(find).find(Boolean);
        find(graph).size = { width: 220, height: 120 };
        const at = withOpenNodePositions(graph, new Map([[KEY, { x: 200, y: 100 }]]));
        expect(at.has(openFrameId(BI))).toBe(true);
        // From its own frame's place, which its parent's gave it just now.
        expect(at.get(AI)!.x).toBeGreaterThan(at.get(openFrameId(BI))!.x);
        expect(countCoincidentNodes(at.values())).toBe(0);
    });

    it('closed with its parent, has its places dropped with the parent’s', () => {
        const graph: any = new GraphGModelSource().transform(statement, { portBuses: portBusStateOf(new Map([[KEY, new Set([ToggleNodeOpenOperation.CLOSED])]])) }).graph;
        const at = withOpenNodePositions(graph, new Map([
            [openFrameId(P), { x: 200, y: 100 }], [openFrameId(BI), { x: 216, y: 140 }], [AI, { x: 232, y: 180 }]
        ]));
        expect(at.get(KEY)).toEqual({ x: 200, y: 100 });
        expect([...at.keys()]).toEqual([KEY]);
    });

    it('drawn open by its producer, saved by a layout that never had it open, is left for the layout to place', () => {
        const graph: any = new GraphGModelSource().transform(statement, { portBuses: nothing }).graph;
        const at = withOpenNodePositions(graph, new Map([[openFrameId(P), { x: 200, y: 100 }]]), true);
        // As a frame of the diagram's own is: the view is laid out again, not opened over its neighbours.
        expect(at.has(openFrameId(BI))).toBe(false);
        expect(at.has(AI)).toBe(false);
    });

    it('is closed and opened again by its toggle, the layout keeping which', async () => {
        const d = diagram(places, statement);
        expect(d.find(openFrameId(BI))).toBeDefined();
        await d.command(openFrameId(BI)).execute();
        expect(d.open().get(BI)).toEqual(new Set([ToggleNodeOpenOperation.CLOSED]));
        expect(d.find(openFrameId(BI))).toBeUndefined();
        expect(d.find(openFrameId(P))).toBeDefined();
        await d.command(BI).execute();
        expect(d.open().get(BI)?.has(ToggleNodeOpenOperation.CLOSED)).toBe(false);
        expect(d.find(openFrameId(BI))).toBeDefined();
    });
});

describe('an open node that keeps its ports on its frame', () => {
    const pinned = withBlock(block({ pins: true }));
    const frameOf = (): any =>
        (new GraphGModelSource().transform(pinned, { portBuses: openState(true) }).graph as any);

    it('ends each edge on the port it was on, and wires the inside from and to those ports', () => {
        const opened = openNodes(pinned, openState(true), stableNodeIds(pinned.graph.nodes));
        const ends = opened.graph.edges.map(e => `${e.from} -> ${e.to}`).sort();
        expect(ends).toEqual([
            // From outside, to the frame's pins and from them.
            `b:a:a -> ${P}:a`, `b:b:b -> ${P}:b`, `${P}:q -> b:q:q`, `${P}:t -> b:t:t`,
            // Inside, from a pin to what it feeds and to a pin from what drives it,
            // and across the frame where an input is wired straight to an output.
            `${P}:a -> ${P}/cell:not:a`, `${P}:b -> ${P}/cell:and:b`, `${P}/cell:reg:q -> ${P}:q`, `${P}:a -> ${P}:t`,
            `${P}/cell:and:y -> ${P}/cell:reg:d`, `${P}/cell:not:y -> ${P}/cell:and:a`
        ].sort());
        expect(new Set(opened.graph.edges.map(e => e.id)).size).toBe(opened.graph.edges.length);
        // An edge that ends on a pin is the edge it was, under its own id.
        expect(opened.graph.edges.filter(e => e.scope === 'root').map(e => e.id).sort()).toEqual(['e:a', 'e:b', 'e:q', 'e:t']);
        const scope = opened.graph.subgraphs!.find(s => s.id === `open:${P}`)!;
        expect(scope.pins!.map(pin => pin.name)).toEqual(['q', 't', 'a', 'b', 'clk']);
        // (A node opened without them has none, and its edges run on to the inner pins.)
        expect(openNodes(doc, openState(true), stableNodeIds(doc.graph.nodes)).graph.subgraphs!.find(s => s.id === `open:${P}`)!.pins).toBeUndefined();
    });

    it('gives its frame those ports as pins: named, the clock marked, there whether wired or not', () => {
        const graph = frameOf();
        const frame = graph.children.find((c: any) => c.id === openFrameId(P));
        const pins = frame.children.filter((c: any) => c.args?.[WorkflowDiagramMetadata.FRAME_PIN] === true);
        expect(pins.map((pin: any) => [pin.args[WorkflowDiagramMetadata.PORT_NAME], pin.args[WorkflowDiagramMetadata.PORT_DIRECTION], pin.args[WorkflowDiagramMetadata.PORT_ROLE]]))
            .toEqual([['q', 'output', undefined], ['t', 'output', undefined], ['a', 'input', undefined], ['b', 'input', undefined], ['clk', 'input', 'clock']]);
        // As a port of the node says them, which is how the panel lists them; and a pin is no node of that name.
        expect(pins.map((pin: any) => pin.args[WorkflowDiagramMetadata.IS_INPUT_PORT])).toEqual([false, false, true, true, true]);
        // Its role, as a closed node's port says it, for the producer's stylesheet.
        expect(pins.map((pin: any) => pin.cssClasses.filter((c: string) => c.startsWith('port-role-'))))
            .toEqual([[], [], [], [], ['port-role-clock']]);
        expect(pins.every((pin: any) => pin.args[WorkflowDiagramMetadata.ENTITY_NAME] === undefined)).toBe(true);
        expect(pins.every((pin: any) => pin.type === WorkflowDiagramTypes.PORT_GROUP_BOUNDARY)).toBe(true);
        // Nothing crosses the frame anywhere else: no other boundary port, no edge cut in pieces.
        expect(frame.children.filter((c: any) => c.type === WorkflowDiagramTypes.PORT_GROUP_BOUNDARY)).toHaveLength(5);
        const edges = graph.children.filter((c: any) => typeof c.sourceId === 'string');
        expect(edges.every((edge: any) => !String(edge.id).endsWith('::piece'))).toBe(true);
        const pinId = (name: string): string => pins.find((pin: any) => pin.args[WorkflowDiagramMetadata.PORT_NAME] === name).id;
        const members = new Set(frame.children.filter((c: any) => String(c.type).startsWith('node:')).flatMap((m: any) => (m.children ?? []).map((c: any) => c.id)));
        // The wire from outside ends on the pin; the wire inside starts on it and ends on a member's pin.
        expect(edges.filter((edge: any) => edge.targetId === pinId('a')).map((edge: any) => members.has(edge.sourceId))).toEqual([false]);
        // (`a` also runs straight across the frame to the pin `t`.)
        expect(edges.filter((edge: any) => edge.sourceId === pinId('a')).map((edge: any) => members.has(edge.targetId) || edge.targetId).sort()).toEqual([pinId('t'), true].sort());
        expect(edges.filter((edge: any) => edge.targetId === pinId('q')).map((edge: any) => members.has(edge.sourceId))).toEqual([true]);
        // The clock's net is not drawn: its pin is on the frame all the same, with no wire,
        // and says so: the frame places it, not the layout.
        expect(edges.some((edge: any) => edge.sourceId === pinId('clk') || edge.targetId === pinId('clk'))).toBe(false);
        expect(pins.filter((pin: any) => pin.args[WorkflowDiagramMetadata.FRAME_PIN_UNWIRED] === true).map((pin: any) => pin.args[WorkflowDiagramMetadata.PORT_NAME])).toEqual(['clk']);
        // An edge on a pin names its ends as it did on the node: what a saved route, a delete and the panel go by.
        const named = (from: any[], id: string) => { const a = from.find((edge: any) => edge.id === id).args; return [a['wf:from'], a['wf:outPort'], a['wf:to'], a['wf:inPort']]; };
        const closedEdges = (new GraphGModelSource().transform(pinned, { portBuses: openState(false) }).graph as any).children.filter((c: any) => typeof c.sourceId === 'string');
        for (const id of ['e:a', 'e:b', 'e:q', 'e:t']) {
            expect(named(edges, id), id).toEqual(named(closedEdges, id));
            expect(named(edges, id).every(part => typeof part === 'string' && part !== ''), id).toBe(true);
        }
    });

    it('is still the node when it is selected: its name, its type, what can be set of it, its id', () => {
        const frame = frameOf().children.find((c: any) => c.id === openFrameId(P));
        expect(frame.args[WorkflowDiagramMetadata.ENTITY_NAME]).toBe('q, t');
        expect(frame.args[WorkflowDiagramMetadata.ENTITY_TYPE]).toBe('always_ff @(posedge clk)');
        expect(frame.args[WorkflowDiagramMetadata.GRAPH_NODE_ID]).toBe(P);
        const meta = frame.args[WorkflowDiagramMetadata.NODE_META];
        expect(meta.parameters).toEqual([{ name: 'kind', value: 'always_ff', editable: true }]);
        // What the property panel reads: the fields it sets, as on the node closed.
        expect(frame.args[WorkflowDiagramMetadata.ENTITY_PARAMETERS]).toEqual(meta.parameters);
        // What it holds is drawn, not carried again.
        expect(meta.inner).toBeUndefined();
        // A node that says neither of its inside is opened as before: its frame is a group's.
        const plain: any = new GraphGModelSource().transform(doc, { portBuses: openState(true) }).graph;
        const group = plain.children.find((c: any) => c.id === openFrameId(P));
        for (const key of [WorkflowDiagramMetadata.GRAPH_NODE_ID, WorkflowDiagramMetadata.ENTITY_NAME, WorkflowDiagramMetadata.NODE_META, WorkflowDiagramMetadata.FRAME_ROOM]) {
            expect(group.args[key]).toBeUndefined();
        }
    });

    it('is still the node to go to: its place in the source, its views, an error in it, and its own key', () => {
        const located = withBlock({
            ...block({ pins: true }),
            meta: {
                ...block({ pins: true }).meta,
                source: { file: '/w/top.sv', line: 12 },
                views: [{ id: 'synth', label: 'RTL Schematic' }],
                facts: [{ label: 'Clock', value: 'clk' }],
                diagnostics: [{ severity: 'error', message: 'q is driven twice' }]
            }
        });
        const build = (open: boolean): any => new GraphGModelSource().transform(located, { portBuses: openState(open) }).graph;
        const closed = build(false).children.find((c: any) => c.args?.[WorkflowDiagramMetadata.NODE_OPENABLE] === true);
        const frame = build(true).children.find((c: any) => c.id === openFrameId(P));
        // Everything the node carries closed, the frame carries: nothing is listed to be forgotten.
        for (const key of Object.keys(closed.args)) {
            if (key !== WorkflowDiagramMetadata.NODE_OPENABLE && key !== WorkflowDiagramMetadata.AST_PATH && key !== WorkflowDiagramMetadata.NODE_META) {
                expect(frame.args[key], key).toEqual(closed.args[key]);
            }
        }
        expect(frame.args[WorkflowDiagramMetadata.SOURCE_RANGE]).toEqual({ start: { line: 11, character: 0 }, end: { line: 11, character: 0 } });
        expect(String(frame.args[WorkflowDiagramMetadata.REFERENCED_URI])).toContain('top.sv');
        expect(frame.args[WorkflowDiagramMetadata.VIEWS]).toBeDefined();
        expect(frame.args['wf:errorMessage']).toBe('q is driven twice');
        // The error marks the frame, with a class of its own: the node's would paint every member.
        expect(frame.cssClasses).toContain('workflow-group-source-error');
        expect(frame.cssClasses).not.toContain('cal-node-graph-error');
        // Its own: the key its place is saved under, and that it is open.
        expect(frame.args[WorkflowDiagramMetadata.AST_PATH]).toBe(openFrameId(P));
        expect(frame.args[WorkflowDiagramMetadata.NODE_OPENABLE]).toBeUndefined();
        // And it is the one node of that name, whatever it holds is called.
        const sameName = withBlock({ ...block({ pins: true }), label: 'reg' });
        const root = convertToGModelRoot(new GraphGModelSource().transform(sameName, { portBuses: portBusStateOf(new Map([['reg', new Set([ToggleNodeOpenOperation.OPEN])]])) }) as any);
        expect(idOfNamedNode(root as any, 'reg')).toBe(openFrameId(P));
    });

    it('is titled as its producer says, where its name alone does not say what it is', () => {
        const titled = withBlock(block({ pins: true, title: 'q, t: always_ff @(posedge clk)' }));
        const scope = (document: PyGraphDocument) =>
            openNodes(document, openState(true), stableNodeIds(document.graph.nodes)).graph.subgraphs!.find(s => s.id === `open:${P}`)!;
        expect(scope(titled).label).toBe('q, t: always_ff @(posedge clk)');
        expect(scope(pinned).label).toBe('q, t');
        // Drawn as written (a group's name is set in capitals), in a frame at least as wide as it.
        const frame = (document: PyGraphDocument): any =>
            (new GraphGModelSource().transform(document, { portBuses: openState(true) }).graph as any).children.find((c: any) => c.id === openFrameId(P));
        expect(frame(titled).cssClasses).toContain('workflow-group-titled');
        expect(frame(pinned).cssClasses).not.toContain('workflow-group-titled');
        const least = (f: any): number => Number(/^\((\d+),/.exec(String(f.layoutOptions['elk.nodeSize.minimum']))![1]);
        expect(least(frame(titled))).toBeGreaterThan(least(frame(pinned)));
        expect(frame(titled).args[WorkflowDiagramMetadata.FRAME_ROOM].width).toBe(least(frame(titled)));
    });

    it('makes room inside the frame for the names of its pins', () => {
        const frame = frameOf().children.find((c: any) => c.id === openFrameId(P));
        const padding = String(frame.layoutOptions['elk.padding']);
        const side = (name: string): number => Number(new RegExp(`${name}=(\\d+)`).exec(padding)![1]);
        // `clk` on the left, one letter on the right, over the frame's own margin;
        // and under the members a row for the pin no edge ends on.
        expect(side('left')).toBeGreaterThan(side('right'));
        expect(side('right')).toBeGreaterThan(14);
        expect(side('bottom')).toBe(14 + 22);
        expect(frame.args[WorkflowDiagramMetadata.FRAME_ROOM]).toMatchObject({ left: side('left') - 14, right: side('right') - 14, bottom: 22 });
    });

    it('keeps a connection through a node opened without pins, from a pin and to one', () => {
        // A (pins) -> B.j, B wires j straight to t, B.t -> C (pins).
        const through = (id: string, pins: boolean): PyGraphNode => ({
            id, kind: 'logic', label: id, scope: 'root',
            ports: [port(id, 'j', 'in'), port(id, 't', 'out')],
            meta: { inner: {
                nodes: [{ id: `${id}/buf`, kind: 'logic', label: 'buf', scope: 'root', ports: [port(`${id}/buf`, 'a', 'in'), port(`${id}/buf`, 'y', 'out')] }],
                edges: pins
                    ? [{ from: `${id}:j`, to: `${id}/buf:a` }, { from: `${id}/buf:y`, to: `${id}:t` }]
                    : [{ from: `${id}:j`, to: `${id}:t` }],
                ...(pins ? { pins: true } : {})
            } }
        });
        const chain: PyGraphDocument = { version: '1', graph: {
            id: 'top', nodes: [through('A', true), through('B', false), through('C', true)],
            edges: [{ id: 'ab', from: 'A:t', to: 'B:j', scope: 'root' }, { id: 'bc', from: 'B:t', to: 'C:j', scope: 'root' }],
            subgraphs: [{ id: 'root', kind: 'root', parent: null, controlNodeId: null }]
        } };
        const all = portBusStateOf(new Map(['A', 'B', 'C'].map(key => [key, new Set([ToggleNodeOpenOperation.OPEN])])));
        const opened = openNodes(chain, all, stableNodeIds(chain.graph.nodes));
        expect(opened.graph.edges.filter(e => e.scope === 'root').map(e => `${e.from} -> ${e.to}`)).toEqual(['A:t -> C:j']);
        // In the model nothing dangles: every edge ends on something drawn.
        const graph: any = new GraphGModelSource().transform(chain, { portBuses: all }).graph;
        const ids = new Set<string>();
        const edges: any[] = [];
        const walk = (element: any): void => {
            ids.add(element.id);
            if (typeof element.sourceId === 'string') { edges.push(element); }
            (element.children ?? []).forEach(walk);
        };
        walk(graph);
        expect(edges.length).toBeGreaterThan(0);
        expect(edges.filter(edge => !ids.has(edge.sourceId) || !ids.has(edge.targetId))).toEqual([]);
    });

    it('is cut at a group it is in, not at its own frame, where an edge comes to a pin from outside the group', () => {
        // The block in a producer's group, `a` and `q` outside it.
        const grouped: PyGraphDocument = {
            ...pinned,
            graph: {
                ...pinned.graph,
                nodes: pinned.graph.nodes.map(n => (n.id === P ? { ...n, scope: 'stage' } : n)),
                subgraphs: [...pinned.graph.subgraphs!, { id: 'stage', kind: 'group', label: 'Stage', parent: 'root', controlNodeId: null }]
            }
        };
        const graph: any = new GraphGModelSource().transform(grouped, { portBuses: openState(true) }).graph;
        const all: any[] = [];
        const walk = (element: any): void => { all.push(element); (element.children ?? []).forEach(walk); };
        walk(graph);
        const ids = new Set(all.map(element => element.id));
        const edges = all.filter(element => typeof element.sourceId === 'string');
        expect(edges.filter(edge => !ids.has(edge.sourceId) || !ids.has(edge.targetId))).toEqual([]);
        const stage = all.find(element => element.id === 'scope:stage');
        const frame = all.find(element => element.id === openFrameId(P));
        expect(stage.children).toContain(frame);
        const crossings = (group: any): any[] => group.children.filter((c: any) => c.type === WorkflowDiagramTypes.PORT_GROUP_BOUNDARY);
        // The frame has its five pins and nothing else: no edge is cut at it.
        expect(crossings(frame).every((c: any) => c.args[WorkflowDiagramMetadata.FRAME_PIN] === true)).toBe(true);
        expect(crossings(frame)).toHaveLength(5);
        // The group is crossed four times (a, b in; q, t out), each piece inside ending on a pin.
        expect(crossings(stage)).toHaveLength(4);
        const pinIds = new Set(crossings(frame).map((c: any) => c.id));
        for (const crossing of crossings(stage)) {
            const inside = edges.filter(edge => edge.sourceId === crossing.id || edge.targetId === crossing.id)
                .filter(edge => pinIds.has(edge.sourceId) || pinIds.has(edge.targetId));
            expect(inside, crossing.id).toHaveLength(1);
        }
    });

    it('is laid out again when its layout was saved while it was drawn closed', () => {
        // Saved before its producer drew it open: a place for the node, none for its frame.
        const startsOpen: any = new GraphGModelSource().transform(withBlock(block({ open: true, pins: true })), { portBuses: portBusStateOf(new Map()) }).graph;
        const saved = new Map(Object.entries(places));
        const loaded = withOpenNodePositions(startsOpen, saved, true);
        expect(loaded.has(openFrameId(P))).toBe(false);
        expect(loaded.has(C('reg'))).toBe(false);
        // Opened by the reader, in the diagram as it is drawn now, the frame takes its node's place as before.
        expect(withOpenNodePositions(startsOpen, saved).get(openFrameId(P))).toEqual(places[KEY]);
        // And a layout saved with it open is the layout.
        const savedOpen = new Map([...saved, [openFrameId(P), { x: 200, y: 100 }], [C('not'), { x: 250, y: 150 }], [C('and'), { x: 350, y: 150 }], [C('reg'), { x: 450, y: 150 }]]);
        savedOpen.delete(KEY);
        expect(withOpenNodePositions(startsOpen, savedOpen, true)).toBe(savedOpen);
    });

    it('is where it was laid out when its saved layout is opened again: its size, and every pin, wired or not', async () => {
        const two = withBlock({ ...block({ open: true, pins: true, title: 'q, t: always_ff @(posedge clk or negedge rst_n)' }),
            ports: [...block({}).ports, { ...port(P, 'rst_n', 'in') }] });
        const build = (): any => new GraphGModelSource().transform(two, { portBuses: portBusStateOf(new Map()) });
        const index = (element: any, map = new Map<string, any>()): Map<string, any> => {
            map.set(element.id, element);
            (element.children ?? []).forEach((child: any) => index(child, map));
            return map;
        };
        const root: any = convertToGModelRoot(build());
        const byId = index(root);
        const modelState: any = { root, index: { get: (id: string) => byId.get(id), findByClass: (id: string) => byId.get(id) } };
        applyBoundaryFlowLayerConstraints(root, new Set(), false);
        await new WorkflowElkLayoutEngine(() => new (ELK as any)({ algorithms: ['layered'] }), new DefaultElementFilter(), new WorkflowLayoutConfigurator(), modelState).layout();
        const positions = collectNodePositions(root);
        const routes = collectEdgeRoutes(root);
        // Opened again: built anew, the saved places put back, no layout run.
        const built = build();
        const at = withOpenNodePositions(built.graph, positions, true);
        const place = (element: any, parentAt: Point): void => {
            const key = String(element.type).startsWith('node:') ? nodeLayoutKeyOf(element) : undefined;
            const saved = key ? at.get(key) : undefined;
            if (saved) { element.position = relativeToParent(saved, parentAt); }
            (element.children ?? []).forEach((child: any) => place(child, saved ?? parentAt));
        };
        (built.graph.children ?? []).forEach((element: any) => place(element, { x: 0, y: 0 }));
        const reopened: any = convertToGModelRoot(built);
        restoreGroupGeometry(reopened, routes);
        const again = index(reopened);
        const frame = byId.get(openFrameId(P));
        expect(again.get(openFrameId(P)).size).toEqual(frame.size);
        const pins = frame.children.filter((c: any) => c.args?.[WorkflowDiagramMetadata.FRAME_PIN] === true);
        expect(pins).toHaveLength(6);
        for (const pin of pins) {
            expect(again.get(pin.id).position, String(pin.args[WorkflowDiagramMetadata.PORT_NAME])).toEqual(pin.position);
        }
        // The two no edge ends on are under the members, one under the other, inside the frame.
        const y = (name: string): number => pins.find((pin: any) => pin.args[WorkflowDiagramMetadata.PORT_NAME] === name).position.y;
        const members = frame.children.filter((c: any) => String(c.type).startsWith('node:'));
        const under = Math.max(...members.map((m: any) => m.position.y + m.size.height));
        expect(y('clk')).toBeGreaterThan(under);
        expect(y('rst_n') - y('clk')).toBe(22);
        expect(y('rst_n')).toBeLessThan(frame.size.height - 14);
        // And no pin an edge ends on is in their room, or on another.
        const wired = pins.filter((pin: any) => pin.args[WorkflowDiagramMetadata.FRAME_PIN_UNWIRED] !== true);
        expect(wired.every((pin: any) => pin.position.y < y('clk') - 8)).toBe(true);
        expect(new Set(pins.map((pin: any) => `${pin.position.x},${pin.position.y}`)).size).toBe(6);
    });
});
