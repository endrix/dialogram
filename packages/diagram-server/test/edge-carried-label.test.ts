/**
 * What a connection carries, made visible.
 *
 * The server half of it: `meta.label` and `meta.width` reaching the model as
 * args the edge view can draw. The view's own choice between them is asserted
 * here too, because it is a rule about the DATA — a label and a width describe
 * the same thing at different resolutions, so exactly one of them should ever
 * reach a reader.
 */

import { describe, expect, it } from 'vitest';
import { WorkflowDiagramMetadata } from '@dialogram/shared';
import { GraphGModelSource, type PyGraphDocument, type PyGraphEdge } from '../src/model/graph-gmodel-source';

function edgeWith(meta: Record<string, unknown> | undefined): any {
    const edges: PyGraphEdge[] = [
        { id: 'e', from: 'p:a:out', to: 'p:b:in', scope: 'root', ...(meta ? { meta } : {}) }
    ];
    const doc: PyGraphDocument = {
        version: '1',
        graph: {
            id: 'root',
            nodes: [
                {
                    id: 'node:a',
                    kind: 'actor',
                    label: 'a',
                    scope: 'root',
                    ports: [{ id: 'p:a:out', name: 'out', direction: 'out' }]
                },
                {
                    id: 'node:b',
                    kind: 'actor',
                    label: 'b',
                    scope: 'root',
                    ports: [{ id: 'p:b:in', name: 'in', direction: 'in' }]
                }
            ],
            edges
        }
    };
    return new GraphGModelSource().transform(doc).graph.children?.find((child: any) => child.id === 'e');
}

describe('what a connection carries', () => {
    it('reaches the model as text the producer formatted', () => {
        // Displayed verbatim, for the same reason a port's type is: the
        // platform re-deriving it from anything structural would drift from how
        // the language writes it, and differ between products.
        const edge = edgeWith({ label: 'Decoupled<UInt<32>>' });

        expect(edge.args[WorkflowDiagramMetadata.EDGE_LABEL]).toBe('Decoupled<UInt<32>>');
    });

    it('reaches the model as a width when that is all the producer has', () => {
        const edge = edgeWith({ width: 32 });

        expect(edge.args[WorkflowDiagramMetadata.EDGE_WIDTH]).toBe(32);
        expect(edge.args[WorkflowDiagramMetadata.EDGE_LABEL]).toBeUndefined();
    });

    it('carries both when the producer states both, and lets the view choose', () => {
        // The precedence rule lives in the view, because it is a question about
        // what to draw rather than about what is true. Both facts survive, so a
        // property panel can still show the width of a labelled channel.
        const edge = edgeWith({ label: 'Decoupled<UInt<32>>', width: 32 });

        expect(edge.args[WorkflowDiagramMetadata.EDGE_LABEL]).toBe('Decoupled<UInt<32>>');
        expect(edge.args[WorkflowDiagramMetadata.EDGE_WIDTH]).toBe(32);
    });

    it('ignores a label that is only whitespace', () => {
        // An empty caption is worse than none: it reserves space above the line
        // and says nothing.
        const edge = edgeWith({ label: '   ' });

        expect(edge.args[WorkflowDiagramMetadata.EDGE_LABEL]).toBeUndefined();
    });

    it('says nothing when the producer says nothing', () => {
        const edge = edgeWith(undefined);

        expect(edge.args[WorkflowDiagramMetadata.EDGE_LABEL]).toBeUndefined();
        expect(edge.args[WorkflowDiagramMetadata.EDGE_WIDTH]).toBeUndefined();
    });
});
