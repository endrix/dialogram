/**
 * The layout as the layout file stores it, read off the GModel once for every
 * handler. Pins the keys (a node by AST path, an edge by its signature as the
 * reader looks it up), the selection's movable nodes, the restore of the
 * unselected part, and that a route-only save notes itself under the shared
 * model-state key.
 */
import { describe, expect, it, vi } from 'vitest';
import { GEdge, GGraph, GModelIndex, GNode, GPort } from '@eclipse-glsp/server';
import { WorkflowDiagramMetadata, WORKFLOW_LAYOUT_PERSISTENCE_KEY, WORKFLOW_NETWORK_MODEL_KEY } from '@dialogram/shared';
import {
    collectEdgeRoutes,
    collectNodePositions,
    movableNodeIdsIn,
    persistLayout,
    restoreUnselectedLayout,
    snapshotEdgeRoutesById,
    snapshotNodePositionsById
} from '../src/server/layout-snapshot';

function node(id: string, x: number, y: number, args: Record<string, unknown>, ...children: any[]) {
    const builder = GNode.builder().id(id).type('node:actor').position(x, y);
    for (const [k, v] of Object.entries(args)) {
        builder.addArg(k, v as any);
    }
    return builder.addChildren(...children).build();
}

function port(id: string, x: number, y: number) {
    return GPort.builder().id(id).type('port:output').position(x, y).size(8, 8).build();
}

function edge(id: string, sourceId: string, targetId: string, args: Record<string, unknown>, routingPoints?: Array<{ x: number; y: number }>) {
    const builder = GEdge.builder().id(id).type('edge:connection').sourceId(sourceId).targetId(targetId);
    for (const [k, v] of Object.entries(args)) {
        builder.addArg(k, v as any);
    }
    const built = builder.build();
    if (routingPoints) {
        (built as any).routingPoints = routingPoints;
    }
    return built;
}

function diagram() {
    const a = node('a', 10, 20, { [WorkflowDiagramMetadata.AST_PATH]: 'main.a' }, port('a.out', 50, 5));
    const b = node('b', 200, 20, { [WorkflowDiagramMetadata.ENTITY_NAME]: 'b' }, port('b.in', 0, 5));
    const group = GNode.builder().id('g').type('node:network').position(100, 100).addChildren(
        node('c', 5, 5, { [WorkflowDiagramMetadata.AST_PATH]: 'main.g.c' })
    ).build();
    const wire = edge('e1', 'a.out', 'b.in', { 'wf:from': 'a', 'wf:to': 'b', 'wf:outPort': 'out', 'wf:inPort': 'in', [WorkflowDiagramMetadata.AST_PATH]: 'main.e1' }, [{ x: 58, y: 29 }, { x: 200, y: 29 }]);
    const stub = edge('e2', 'a.out', 'b.in', { [WorkflowDiagramMetadata.AST_PATH]: 'main.e2' }, [{ x: 1, y: 1 }]);
    const root = GGraph.builder().id('root').addChildren(a, b, group, wire, stub).build();
    const index = new GModelIndex();
    index.indexRoot(root);
    return { root, index, a, b, group, wire };
}

describe('collectNodePositions', () => {
    it('keys each node by AST path, else name, at its absolute position', () => {
        const { root } = diagram();
        expect(collectNodePositions(root)).toEqual(new Map([
            ['main.a', { x: 10, y: 20 }],
            ['b', { x: 200, y: 20 }],
            ['main.g.c', { x: 105, y: 105 }]
        ]));
    });
});

describe('collectEdgeRoutes', () => {
    it('keys a route by the edge signature the reader looks up, and needs two points', () => {
        const { root } = diagram();
        const routes = collectEdgeRoutes(root);
        expect(Array.from(routes.keys())).toEqual(['a|out|b|in']);
        expect(routes.get('a|out|b|in')).toEqual([{ x: 58, y: 29 }, { x: 200, y: 29 }]);
    });
});

describe('movableNodeIdsIn', () => {
    it('names the node of each selected element and both ends of a selected edge', () => {
        const { index } = diagram();
        expect(movableNodeIdsIn(index, ['a.out'])).toEqual(new Set(['a']));
        expect(movableNodeIdsIn(index, ['e1'])).toEqual(new Set(['a', 'b']));
        expect(movableNodeIdsIn(index, ['c'])).toEqual(new Set(['c']));
        expect(movableNodeIdsIn(index, undefined)).toEqual(new Set());
    });
});

describe('restoreUnselectedLayout', () => {
    it('puts the nodes and edges outside the selection back where the snapshots had them', () => {
        const { root, index, a, b, group, wire } = diagram();
        const positions = snapshotNodePositionsById(root);
        const routes = snapshotEdgeRoutesById(root);
        a.position = { x: 999, y: 999 };
        b.position = { x: 888, y: 888 };
        group.position = { x: 777, y: 777 };
        (wire as any).routingPoints = [{ x: 0, y: 0 }, { x: 1, y: 1 }];

        restoreUnselectedLayout(index, root, new Set(['a']), positions, routes);

        expect(a.position).toEqual({ x: 999, y: 999 });
        expect(b.position).toEqual({ x: 200, y: 20 });
        expect(group.position).toEqual({ x: 100, y: 100 });
        // The wire ends on the selected node, so its new route stands.
        expect((wire as any).routingPoints).toEqual([{ x: 0, y: 0 }, { x: 1, y: 1 }]);
    });
});

describe('persistLayout', () => {
    function modelStateFor(root: any, meta: Record<string, unknown> | undefined) {
        const state = new Map<string, unknown>([[WORKFLOW_NETWORK_MODEL_KEY, { documentUri: 'file:///wf/flow.py', workflowName: 'main' }]]);
        if (meta) {
            state.set(WORKFLOW_LAYOUT_PERSISTENCE_KEY, meta);
        }
        return { root, get: (key: string) => state.get(key), set: (key: string, value: unknown) => state.set(key, value) } as any;
    }

    it('saves the model positions and routes and marks the layout persisted', async () => {
        const { root } = diagram();
        const meta = { hasPersistedLayout: false, hasPersistedEdgeRoutes: false };
        const persistence = { loadLayout: vi.fn(), saveLayoutImmediate: vi.fn(async () => undefined) } as any;

        await persistLayout(modelStateFor(root, meta), persistence, { layoutPerformed: true });

        expect(persistence.loadLayout).not.toHaveBeenCalled();
        const [, , positions, routes] = persistence.saveLayoutImmediate.mock.calls[0];
        expect(positions.get('main.a')).toEqual({ x: 10, y: 20 });
        expect(routes.size).toBe(1);
        expect(meta).toEqual({ hasPersistedLayout: true, hasPersistedEdgeRoutes: true });
    });

    it('keeps the positions already on disk for a route-only change, and notes the routes under the shared key', async () => {
        const { root } = diagram();
        const meta = { hasPersistedLayout: true, hasPersistedEdgeRoutes: false };
        const onDisk = new Map([['main.a', { x: 1, y: 2 }]]);
        const persistence = { loadLayout: vi.fn(async () => onDisk), saveLayoutImmediate: vi.fn(async () => undefined) } as any;

        await persistLayout(modelStateFor(root, meta), persistence, { keepPersistedPositions: true });

        const [, , positions] = persistence.saveLayoutImmediate.mock.calls[0];
        expect(positions).toBe(onDisk);
        expect(meta).toEqual({ hasPersistedLayout: true, hasPersistedEdgeRoutes: true });
    });

    it('does nothing for a model without a diagram', async () => {
        const persistence = { loadLayout: vi.fn(), saveLayoutImmediate: vi.fn() } as any;
        await persistLayout({ root: {}, get: () => undefined, set: () => undefined } as any, persistence);
        expect(persistence.saveLayoutImmediate).not.toHaveBeenCalled();
    });
});
