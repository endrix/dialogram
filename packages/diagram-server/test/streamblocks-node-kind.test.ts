/**
 * A `streamblocks` node must render as an external actor — and the reason is
 * not cosmetic.
 *
 * `isExternalNodeKind` decides two things at once. Besides the look, it is what
 * gives a node the `NODE_EXTERNAL_ACTOR` type, and `viewer-mouse-listener`
 * refuses to read a node's annotations unless it has exactly that type:
 *
 *     if (node.type !== WorkflowDiagramTypes.NODE_EXTERNAL_ACTOR) return [];
 *
 * Leave the kind out of that predicate and the double-click silently does
 * nothing — no error, nothing in a log, just a node that will not open. That is
 * what this pins.
 */
import { describe, expect, it } from 'vitest';
import { WorkflowDiagramTypes } from '@dialogram/shared';
import { GraphGModelSource, type PyGraphDocument } from '../src/model/graph-gmodel-source';

function docWithKind(kind: string): PyGraphDocument {
    return {
        version: '1',
        graph: {
            id: 'root',
            nodes: [{
                id: 'node:adder',
                kind,
                label: 'adder',
                scope: 'root',
                ports: [{ id: 'p', name: 'stimulus', direction: 'in' }]
            }],
            edges: []
        }
    };
}

const nodeFor = (kind: string): any =>
    new GraphGModelSource().transform(docWithKind(kind)).graph.children
        ?.find((child: any) => child.id === 'adder');

describe('the streamblocks node kind', () => {
    it('is typed as an external actor, so its annotations are read at all', () => {
        expect(nodeFor('streamblocks').type).toBe(WorkflowDiagramTypes.NODE_EXTERNAL_ACTOR);
    });

    it('is marked external, like the kinds it sits beside', () => {
        // The control: an ordinary task is NOT, so this is not asserting that
        // everything comes back external.
        expect(nodeFor('tool').type).toBe(WorkflowDiagramTypes.NODE_EXTERNAL_ACTOR);
        expect(nodeFor('internal').type).toBe(WorkflowDiagramTypes.NODE_ACTOR);
    });

    it('carries a class of its own, so it can be coloured apart', () => {
        const classes: string[] = nodeFor('streamblocks').cssClasses ?? [];

        expect(classes).toContain('external-actor-node');
        // Its own hook too: it now shares a shape with tool, agent and viewer,
        // and a colour needs something to key on that they do not have.
        expect(classes).toContain('streamblocks-node');
        expect(nodeFor('tool').cssClasses ?? []).not.toContain('streamblocks-node');
    });
});
