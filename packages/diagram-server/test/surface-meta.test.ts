/**
 * A diagram surface's data, passed through and never read.
 *
 * `graph.meta.surface` is the producer's message to its own webview surface
 * (diagram-client `diagram-surface.ts`): where to fetch what it draws, a
 * revision, a unit. The root carries it as `wf:surface`, as sent; and a graph
 * with no nodes at all, which is what a product whose surface draws
 * everything sends, still makes a root that carries it.
 */
import { describe, expect, it } from 'vitest';
import { WorkflowDiagramMetadata } from '@dialogram/shared';
import { GraphGModelSource, type PyGraphDocument } from '../src/model/graph-gmodel-source';

function docWith(graphMeta?: Record<string, unknown>, nodes: unknown[] = []): PyGraphDocument {
    return {
        version: '1',
        graph: { id: 'root', meta: graphMeta, nodes, edges: [] }
    } as PyGraphDocument;
}

const transform = (doc: PyGraphDocument) => new GraphGModelSource({} as any).transform(doc).graph;

describe('the surface data of a graph', () => {
    it('reaches the root’s args as the producer sent it', () => {
        const surface = { design: 'top', revision: 7, extent: { x: 0, y: 0, width: 120.5, height: 80 }, nested: [1, 'two'] };
        const graph: any = transform(docWith({ surface }));
        expect(graph.args?.[WorkflowDiagramMetadata.SURFACE]).toEqual(surface);
    });

    it('is absent when the graph sends none', () => {
        const graph: any = transform(docWith({ facts: [{ label: 'Top', value: 'yes' }] }));
        expect(graph.args).toBeDefined();
        expect(graph.args?.[WorkflowDiagramMetadata.SURFACE]).toBeUndefined();
    });

    it('rides on a graph with no nodes, whose root has no children', () => {
        const graph: any = transform(docWith({ surface: { revision: 1 } }));
        expect(graph.children ?? []).toEqual([]);
        expect(graph.args?.[WorkflowDiagramMetadata.SURFACE]).toEqual({ revision: 1 });
    });
});
