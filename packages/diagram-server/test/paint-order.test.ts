/**
 * Shapes paint over wires, not under them.
 *
 * SVG has no z-index: what covers what is decided by document order, which
 * comes straight from the root's child array. Edges were appended last, so a
 * wire crossing a node was drawn on top of it — most visibly over a boundary
 * port's name, since those sit at the end of the very wires that reach them.
 *
 * The same order decides hit-testing, so this also stops a wire passing behind
 * a node from taking a click meant for the node.
 */
import { describe, expect, it } from 'vitest';
import { GraphGModelSource, type PyGraphDocument } from '../src/model/graph-gmodel-source';

/** A boundary input, an entity, and an edge between them. */
const DOC: PyGraphDocument = {
    version: '1',
    graph: {
        id: 'root',
        nodes: [
            {
                id: 'wf:input:Alloc', kind: 'wf-input', label: 'Alloc', scope: 'root',
                ports: [{ id: 'pi', name: 'Alloc', direction: 'out', type: 'RobAlloc' }]
            },
            {
                id: 'node:rob', kind: 'tool', label: 'rob', scope: 'root',
                ports: [{ id: 'pn', name: 'Alloc', direction: 'in' }]
            }
        ],
        edges: [{ id: 'edge:a', from: 'pi', to: 'pn', scope: 'root' }]
    }
};

const childrenOf = (doc: PyGraphDocument): any[] =>
    (new GraphGModelSource().transform(doc).graph.children ?? []) as any[];

describe('paint order', () => {
    it('puts every edge before every shape', () => {
        const kinds = childrenOf(DOC).map(child => (String(child.type).startsWith('edge:') ? 'edge' : 'shape'));

        expect(kinds, 'the fixture produced no edge or no shape').toContain('edge');
        expect(kinds, 'the fixture produced no edge or no shape').toContain('shape');
        // No shape may precede an edge.
        expect(kinds.indexOf('shape')).toBeGreaterThan(kinds.lastIndexOf('edge'));
    });

    it('keeps the shapes in the order they were built', () => {
        const shapes = childrenOf(DOC)
            .filter(child => !String(child.type).startsWith('edge:'))
            .map(child => child.id);

        // The boundary node is created before the entity node, and reordering
        // must not disturb that — only the edge/shape split moves.
        expect(shapes.length).toBe(2);
        expect(shapes[0]).toContain('Alloc');
    });
});
