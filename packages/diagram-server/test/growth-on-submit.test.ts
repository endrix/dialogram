/**
 * A graph that grows, at the submit that follows its load: the nodes the load
 * gave no place are given one, and nothing that had one moves
 * (`placeUnplacedNodes` in diagram-action-handlers.ts).
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { GEdge, GGraph, GModelElement, GNode, GPort, ServerLayoutKind } from '@eclipse-glsp/server';
import { WORKFLOW_LAYOUT_PERSISTENCE_KEY, WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import { WorkflowModelSubmissionHandler } from '../src/server/diagram-action-handlers';
import { absolutePosition, relativeToParent } from '../src/server/group-geometry';
import { INCREMENTAL_GAP_X } from '../src/server/incremental-placement';
import type { LayoutPersistenceMeta } from '../src/server/layout-snapshot';
import { countCoincidentNodes, savedLayoutIsUsable } from '../src/server/source-model-storage';

type Point = { x: number; y: number };

function node(id: string, at: Point, ...children: GModelElement[]): GNode {
    return GNode.builder().id(id).type(WorkflowDiagramTypes.NODE_ACTOR).position(at.x, at.y).size(60, 40)
        .addArg(WorkflowDiagramMetadata.ENTITY_NAME, id).addChildren(...children).build();
}
const port = (id: string, type: string = WorkflowDiagramTypes.PORT_INPUT): GPort =>
    GPort.builder().id(id).type(type).position(0, 16).size(8, 8).build();
function edge(id: string, source: string, target: string, route: Point[] = []): GEdge {
    // Keyed in a layout file by where it is written, as an edge of a real document is.
    const built = GEdge.builder().id(id).type(WorkflowDiagramTypes.EDGE_CONNECTION).sourceId(source).targetId(target)
        .addArg(WorkflowDiagramMetadata.AST_PATH, `edges/${id}`).build();
    (built as any).routingPoints = route;
    return built;
}

/** The handler on a model as a load left it: `meta` is what the load noted, `own` the view's own layout file. */
function harness(root: GGraph, meta: Partial<LayoutPersistenceMeta>, own?: Map<string, Point>) {
    const layoutMeta: LayoutPersistenceMeta = {
        workflowFilePath: '/w/top.v', networkId: 'top', hasPersistedLayout: true, hasPersistedEdgeRoutes: true,
        didInitialLayout: false, hasClientBounds: true, allowInitialLayoutPersistence: true, incremental: true,
        ...meta
    };
    const store = new Map<string, unknown>([[WORKFLOW_LAYOUT_PERSISTENCE_KEY, layoutMeta]]);
    const byId = new Map<string, GModelElement>();
    const index = (element: GModelElement): void => {
        byId.set(element.id, element);
        element.children.forEach(index);
    };
    index(root);
    const saved: { positions?: Map<string, Point>; routes?: Map<string, Point[]> } = { positions: own };
    const reroutes: Array<{ elementIds?: string[]; preview?: boolean }> = [];
    const handler: any = new WorkflowModelSubmissionHandler();
    handler.layoutEngine = { layout: async () => undefined };
    handler.diagramConfiguration = { layoutKind: ServerLayoutKind.MANUAL, needsClientLayout: true, animatedUpdate: false };
    handler.modelState = {
        root, index: { get: () => undefined, find: (id: string) => byId.get(id) },
        get: (key: string) => store.get(key), set: (key: string, value: unknown) => store.set(key, value)
    };
    handler.serializer = { createSchema: () => ({}) };
    handler.commandStack = { isDirty: false };
    handler.requestModelAction = { requestId: 'r1' };
    handler.layoutPersistence = {
        loadLayout: async () => (saved.positions ? new Map(saved.positions) : undefined),
        saveLayoutImmediate: async (_file: string, _id: string, positions: Map<string, Point>, routes?: Map<string, Point[]>) => {
            saved.positions = new Map(positions);
            saved.routes = routes;
        }
    };
    handler.rerouteHandler = { runReroute: async (operation: any) => { reroutes.push(operation); } };
    handler.agentEditSignal = { isPending: () => false, consumePending: () => false, markPending: () => undefined };
    return { handler, layoutMeta, saved, reroutes };
}

describe('a graph that grows, at the submit after its load', () => {
    it('keeps every node the load placed where it is when the places were its fallback’s, and places only the new one', async () => {
        // A view shown in place on the layout of the unit it is an instance of: it has no layout file of its own.
        const A = node('A', { x: 400, y: 200 }, port('A.q', WorkflowDiagramTypes.PORT_OUTPUT));
        const B = node('B', { x: 900, y: 700 }, port('B.d'));
        const C = node('C', { x: 0, y: 0 }, port('C.d'));
        // A's old wire to B, down and across: nowhere near where the new node goes.
        const kept = [{ x: 460, y: 220 }, { x: 460, y: 720 }, { x: 900, y: 720 }];
        const root = GGraph.builder().id('root').addChildren(A, B, C, edge('e0', 'A.q', 'B.d', kept), edge('e1', 'A.q', 'C.d')).build();
        const applied = new Map<string, Point>([['A', { x: 400, y: 200 }], ['B', { x: 900, y: 700 }]]);
        expect(savedLayoutIsUsable(true, 1, 0, 2)).toBe(true);
        const { handler, layoutMeta, saved, reroutes } = harness(root, {
            unpositionedNodeCount: 1, totalNodeCount: 3, appliedPositions: applied, layoutIsFallback: true,
            unroutedEdgeIds: ['e1'], unroutedEdgesUnsaved: true
        });

        await handler.submitModelDirectly();

        // What had a place has it still; the new node is to the right of the pin that drives it, the wire straight.
        expect([A.position, B.position]).toEqual([{ x: 400, y: 200 }, { x: 900, y: 700 }]);
        expect(C.position).toEqual({ x: 400 + 60 + INCREMENTAL_GAP_X, y: 200 });
        // The view has a layout of its own now: the fallback's places, the new node's, and the old wire's route.
        expect([...saved.positions!]).toEqual([['A', { x: 400, y: 200 }], ['B', { x: 900, y: 700 }], ['C', C.position]]);
        expect([...saved.routes!]).toEqual([['edges/e0', kept]]);
        // Only the new wire is routed, and its route is saved with the layout it now belongs to.
        expect(reroutes.map(r => [r.elementIds, r.preview])).toEqual([[['e1'], false]]);
        expect((root.children[3] as any).routingPoints).toEqual(kept);
        expect([layoutMeta.layoutIsFallback, layoutMeta.unroutedEdgesUnsaved]).toEqual([false, false]);
    });

    it('places among the nodes of its own layout as before, and saves no routes with the places', async () => {
        const A = node('A', { x: 400, y: 200 }, port('A.q', WorkflowDiagramTypes.PORT_OUTPUT));
        const C = node('C', { x: 0, y: 0 }, port('C.d'));
        const root = GGraph.builder().id('root').addChildren(A, C, edge('e1', 'A.q', 'C.d')).build();
        const own = new Map<string, Point>([['A', { x: 400, y: 200 }]]);
        const { handler, saved } = harness(root, { unpositionedNodeCount: 1, appliedPositions: own }, own);
        await handler.submitModelDirectly();
        expect([...saved.positions!]).toEqual([['A', { x: 400, y: 200 }], ['C', { x: 530, y: 200 }]]);
        // The routes the file has stand: the save names none.
        expect(saved.routes).toBeUndefined();
    });

    it('drops the place of a node that is gone, so the next node parked is not put on it', async () => {
        // I1 was parked under the diagram, then taken back; its place is still in the layout.
        const A = node('A', { x: 0, y: 0 });
        const I2 = node('I2', { x: 0, y: 0 });
        const root = GGraph.builder().id('root').addChildren(A, I2).build();
        const applied = new Map<string, Point>([['A', { x: 0, y: 0 }], ['I1', { x: 0, y: 94 }]]);
        const { handler, saved } = harness(root, { unpositionedNodeCount: 1, appliedPositions: applied }, applied);
        await handler.submitModelDirectly();
        // Parked where I1 was: the one place there, since I1's went with it.
        expect(I2.position).toEqual({ x: 0, y: 94 });
        expect([...saved.positions!.keys()]).toEqual(['A', 'I2']);
        expect(countCoincidentNodes(saved.positions!.values())).toBe(0);
        expect(savedLayoutIsUsable(true, 0, countCoincidentNodes(saved.positions!.values()), 2)).toBe(true);
    });

    it('keeps the places of nodes not drawn in a graph that does not grow', async () => {
        // Any other graph's layout may hold places for what is not drawn now (the members of a bundle that is closed).
        const A = node('A', { x: 0, y: 0 });
        const N = node('N', { x: 0, y: 0 });
        const root = GGraph.builder().id('root').addChildren(A, N).build();
        const applied = new Map<string, Point>([['A', { x: 0, y: 0 }], ['closed', { x: 300, y: 0 }]]);
        const { handler, saved } = harness(root, { incremental: false, unpositionedNodeCount: 1, appliedPositions: applied }, applied);
        await handler.submitModelDirectly();
        expect([...saved.positions!.keys()]).toEqual(['A', 'closed', 'N']);
        // Under the diagram, not beside anything.
        expect(N.position).toEqual({ x: 0, y: 40 + 80 });
    });

    it('puts a new member of a group under the group’s members, and saves it where it is drawn', async () => {
        const M = node('M', { x: 20, y: 40 }, port('M.q', WorkflowDiagramTypes.PORT_OUTPUT));
        const N = node('N', { x: 0, y: 0 }, port('N.d'));
        const east = GPort.builder().id('G.out').type(WorkflowDiagramTypes.PORT_GROUP_BOUNDARY).position(196, 50).size(8, 8)
            .addArg(WorkflowDiagramMetadata.PORT_SIDE, 'EAST').build();
        const G = GNode.builder().id('G').type(WorkflowDiagramTypes.NODE_GROUP).position(500, 300).size(200, 100)
            .addArg(WorkflowDiagramMetadata.ENTITY_NAME, 'G').addChildren(M, N, east, edge('inside', 'M.q', 'N.d')).build();
        const R = node('R', { x: 0, y: 0 }, port('R.d'));
        const across = edge('across', 'G.out', 'R.d', [{ x: 700, y: 354 }, { x: 900, y: 354 }]);
        const root = GGraph.builder().id('root').addChildren(G, R, across).build();
        const applied = new Map<string, Point>([['G', { x: 500, y: 300 }], ['M', { x: 520, y: 340 }], ['R', { x: 900, y: 334 }]]);
        R.position = { x: 900, y: 334 };
        const { handler, saved, reroutes } = harness(root, { unpositionedNodeCount: 1, appliedPositions: applied }, applied);

        await handler.submitModelDirectly();

        // In the group's own coordinates, under M: not the root's, which would draw it far outside the frame.
        expect(N.position).toEqual({ x: 20, y: 40 + 40 + 3 * 18 });
        expect([M.position, G.position]).toEqual([{ x: 20, y: 40 }, { x: 500, y: 300 }]);
        // The frame grew to hold it, downwards only; the port on its right kept to its edge.
        expect(G.size.height).toBeGreaterThanOrEqual(N.position.y + 40);
        expect(G.size.width).toBe(200);
        // Saved where it is drawn, from the root's corner.
        expect(saved.positions!.get('N')).toEqual({ x: 520, y: 434 });
        expect(saved.positions!.get('N')).toEqual(absolutePosition(N));
        // A reload gives it the same place: what the load makes of the saved one, inside the group as saved.
        expect(relativeToParent(saved.positions!.get('N')!, saved.positions!.get('G')!)).toEqual(N.position);
        // The wire to the new member is routed, and the wire that leaves by a port on the frame that grew.
        expect(reroutes.map(r => [...(r.elementIds ?? [])].sort())).toEqual([['across', 'inside']]);
    });
});
