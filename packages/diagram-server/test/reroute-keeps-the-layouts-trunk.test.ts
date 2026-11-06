/**
 * After a node moves, its edges keep the routes the layout gave them and
 * only their ends follow the ports. ELK routes edges together, so edges into
 * one port share a trunk; routing a moved node's edges anew, one at a time,
 * turned that trunk into a comb of parallel lines, and a move of a few
 * pixels scrambled the picture. The router runs only for an edge whose kept
 * route would not do, and that router is libavoid, which routes the edges
 * on one port as one shared path.
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { GEdge, GGraph, GModelIndex, GNode, GPort } from '@eclipse-glsp/server';
import { WorkflowDiagramTypes } from '@dialogram/shared';
import {
    isOrthogonalPolyline,
    WorkflowRerouteEdgesAvoidOverlapsOperationHandler
} from '../src/operations/reroute-edges-avoid-overlaps-handler';

type Point = { x: number; y: number };

/** A 140x60 node at (x, y) with a 7x7 input port on its left and an output port on its right, both at mid height. */
function node(id: string, x: number, y: number): GNode {
    const port = (name: string, type: string, px: number): GPort =>
        GPort.builder().id(`${id}.${name}`).type(type).position(px, 26).size(7, 7).build();
    return GNode.builder()
        .id(id)
        .type(WorkflowDiagramTypes.NODE_ACTOR)
        .position(x, y)
        .size(140, 60)
        .addChildren(port('in', WorkflowDiagramTypes.PORT_INPUT, 0), port('out', WorkflowDiagramTypes.PORT_OUTPUT, 133))
        .build();
}

function edge(id: string, from: string, to: string, route: Point[]): GEdge {
    const built = GEdge.builder().id(id).type('edge:connection').sourceId(`${from}.out`).targetId(`${to}.in`).build();
    (built as any).routingPoints = route.map(p => ({ ...p }));
    return built;
}

function graph(...elements: Array<GNode | GEdge>): { root: GGraph; handler: any; find: (id: string) => any } {
    const root = GGraph.builder().id('root').addChildren(...elements).build();
    const setParents = (element: any): void => {
        for (const child of element.children ?? []) { child.parent = element; setParents(child); }
    };
    setParents(root);
    const index = new GModelIndex();
    index.indexRoot(root);
    const store = new Map<string, unknown>();
    const handler: any = new (WorkflowRerouteEdgesAvoidOverlapsOperationHandler as any)();
    handler.modelState = { root, index, get: (k: string) => store.get(k), set: (k: string, v: unknown) => store.set(k, v) };
    handler.layoutPersistence = { saveLayoutImmediate: async () => undefined, saveLayout: () => undefined };
    return { root, handler, find: id => index.find(id) };
}

/** Moves the node, reroutes the edges, and says which router drew the routes the slide refused. */
async function moveAndReroute(g: ReturnType<typeof graph>, nodeId: string, to: Point, edgeIds: string[]): Promise<string> {
    g.find(nodeId).position = to;
    const timing = { router: 'none' };
    await g.handler.executeOperation({
        kind: 'dialogram.rerouteEdgesAvoidOverlaps', isOperation: true, elementIds: edgeIds, preview: false, source: 'changeBounds'
    }, timing);
    return timing.router;
}

const routeOf = (g: ReturnType<typeof graph>, id: string): Point[] => g.find(id).routingPoints;

// The layout's picture: a and b feed t through one trunk at x = 270. Port
// anchors: an output port's anchor is its right edge, (140, 29.5) for a node
// at the origin; an input port's its left edge.
const A_OUT = { x: 140, y: 29.5 };
const B_OUT = { x: 140, y: 229.5 };
const T_IN = { x: 400, y: 129.5 };
const trunk = (from: Point, to: Point): Point[] => [from, { x: 270, y: from.y }, { x: 270, y: to.y }, to];

function fanIn(): ReturnType<typeof graph> {
    return graph(
        node('a', 0, 0), node('b', 0, 200), node('t', 400, 100),
        edge('a-t', 'a', 't', trunk(A_OUT, T_IN)),
        edge('b-t', 'b', 't', trunk(B_OUT, T_IN))
    );
}

describe('reroute after a move keeps the layout\'s routes', () => {
    it('slides the ends onto the ports and keeps the trunk, at any distance', async () => {
        const g = fanIn();
        expect(await moveAndReroute(g, 't', { x: 400, y: 160 }, ['a-t', 'b-t'])).toBe('slide');
        const movedIn = { x: 400, y: 189.5 };
        expect(routeOf(g, 'a-t')).toEqual(trunk(A_OUT, movedIn));
        expect(routeOf(g, 'b-t')).toEqual(trunk(B_OUT, movedIn));
    });

    it('leaves an edge beside the far end of a moved edge alone', async () => {
        // c→d runs down x = 150, within the router's padding of a and b, which
        // did not move: it is not covered by anything and keeps its route.
        const g = graph(
            node('a', 0, 0), node('b', 0, 200), node('t', 400, 100),
            node('c', 0, -200), node('d', 400, 300),
            edge('a-t', 'a', 't', trunk(A_OUT, T_IN)),
            edge('b-t', 'b', 't', trunk(B_OUT, T_IN)),
            edge('c-d', 'c', 'd', [{ x: 140, y: -170.5 }, { x: 150, y: -170.5 }, { x: 150, y: 329.5 }, { x: 400, y: 329.5 }])
        );
        const before = routeOf(g, 'c-d');
        await moveAndReroute(g, 't', { x: 400, y: 160 }, ['a-t', 'b-t']);
        expect(routeOf(g, 'c-d')).toEqual(before);
    });

    it('routes anew an edge whose kept route would run through a node', async () => {
        const g = graph(
            node('a', 0, 0), node('b', 0, 200), node('t', 400, 100), node('x', 230, 240),
            edge('a-t', 'a', 't', trunk(A_OUT, T_IN)),
            edge('b-t', 'b', 't', trunk(B_OUT, T_IN))
        );
        expect(await moveAndReroute(g, 't', { x: 400, y: 250 }, ['a-t', 'b-t'])).toBe('libavoid');
        const xBox = { id: 'x', x: 230, y: 240, r: 370, b: 300 };
        for (const id of ['a-t', 'b-t']) {
            const route = routeOf(g, id);
            expect(route).not.toEqual(trunk(id === 'a-t' ? A_OUT : B_OUT, { x: 400, y: 279.5 }));
            expect(isOrthogonalPolyline(route)).toBe(true);
            for (let i = 0; i < route.length - 1; i++) {
                expect(g.handler.segmentHitsBox(route[i], route[i + 1], xBox)).toBe(false);
            }
        }
    });

    it('routes anew an edge whose stub would turn back through its node', async () => {
        const g = fanIn();
        // t now stands left of the trunk: a kept route would enter it from behind.
        expect(await moveAndReroute(g, 't', { x: 200, y: 100 }, ['a-t', 'b-t'])).toBe('libavoid');
        for (const id of ['a-t', 'b-t']) {
            const route = routeOf(g, id);
            expect(route[route.length - 1]).toEqual({ x: 200, y: 129.5 });
            expect(isOrthogonalPolyline(route)).toBe(true);
            expect(route.some(p => p.x === 270)).toBe(false);
        }
    });

    it('routes anew an edge whose stub would shrink to nothing', async () => {
        const g = fanIn();
        // t stands one pixel right of the trunk: the kept route would leave
        // its port on a 1 px stub, a vertical to the eye.
        expect(await moveAndReroute(g, 't', { x: 271, y: 100 }, ['a-t', 'b-t'])).toBe('libavoid');
        for (const id of ['a-t', 'b-t']) {
            const route = routeOf(g, id);
            const [bend, end] = route.slice(-2);
            expect(end).toEqual({ x: 271, y: 129.5 });
            expect(bend.y).toBe(end.y);
            expect(end.x - bend.x).toBeGreaterThanOrEqual(8);
            expect(isOrthogonalPolyline(route)).toBe(true);
        }
    });

    it('routes anew a straight edge, which has no bend to carry', async () => {
        const g = graph(node('c', 0, 0), node('d', 400, 0), edge('c-d', 'c', 'd', [{ x: 140, y: 29.5 }, { x: 400, y: 29.5 }]));
        expect(await moveAndReroute(g, 'd', { x: 400, y: 60 }, ['c-d'])).toBe('libavoid');
        const route = routeOf(g, 'c-d');
        expect(route.length).toBeGreaterThanOrEqual(4);
        expect(isOrthogonalPolyline(route)).toBe(true);
        expect(route[route.length - 1]).toEqual({ x: 400, y: 89.5 });
    });
});
