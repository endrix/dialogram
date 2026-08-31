/**
 * The compact layout differs from the boundary-flow one by exactly this: the
 * network's input and output pills are released from their first/last columns,
 * so ELK can put them beside whatever they connect to. Measured on the
 * reference network that is 16% fewer crossings and 15% less edge length, at
 * the cost of the interface no longer reading down the two edges of the diagram.
 *
 * The pins belong to the model, not to one layout run, so they must come back
 * afterwards — otherwise the compact layout would quietly change what every
 * later boundary-flow layout produces.
 */
import { describe, expect, it } from 'vitest';
import { GNode } from '@eclipse-glsp/server';
import { WorkflowDiagramTypes } from '@dialogram/shared';
import {
    releaseBoundaryNodeConstraints,
    restoreNodeLayoutOptions
} from '../src/operations/boundary-flow-layout';

const CONSTRAINT = 'elk.layered.layering.layerConstraint';

function boundary(id: string, type: string, constraint: string): GNode {
    return Object.assign(new GNode(), {
        id, type,
        layoutOptions: { 'elk.portConstraints': 'FIXED_POS', [CONSTRAINT]: constraint }
    });
}
function actor(id: string): GNode {
    return Object.assign(new GNode(), {
        id, type: WorkflowDiagramTypes.NODE_ACTOR,
        layoutOptions: { 'elk.portConstraints': 'FIXED_POS' }
    });
}
const graph = (children: any[]) => ({ id: 'root', children });

describe('releaseBoundaryNodeConstraints', () => {
    it('frees input and output pills from their first/last columns', () => {
        const g = graph([
            boundary('in1', WorkflowDiagramTypes.NODE_BOUNDARY_INPUT, 'FIRST_SEPARATE'),
            boundary('out1', WorkflowDiagramTypes.NODE_BOUNDARY_OUTPUT, 'LAST_SEPARATE'),
            actor('middle')
        ]);
        releaseBoundaryNodeConstraints(g);

        const by = (id: string) => g.children.find(c => c.id === id) as any;
        expect(by('in1').layoutOptions[CONSTRAINT]).toBe('NONE');
        expect(by('out1').layoutOptions[CONSTRAINT]).toBe('NONE');
        // The long-form id is set too: the engine forwards a node's own options
        // over the configurator's, and ELK accepts either spelling.
        expect(by('in1').layoutOptions['org.eclipse.elk.layered.layering.layerConstraint']).toBe('NONE');
    });

    it('leaves everything that is not a boundary pill alone', () => {
        const g = graph([actor('a'), boundary('in1', WorkflowDiagramTypes.NODE_BOUNDARY_INPUT, 'FIRST_SEPARATE')]);
        const before = { ...(g.children[0] as any).layoutOptions };
        releaseBoundaryNodeConstraints(g);
        expect((g.children[0] as any).layoutOptions).toEqual(before);
    });

    it('keeps the other layout options on a released node', () => {
        const g = graph([boundary('in1', WorkflowDiagramTypes.NODE_BOUNDARY_INPUT, 'FIRST_SEPARATE')]);
        releaseBoundaryNodeConstraints(g);
        expect((g.children[0] as any).layoutOptions['elk.portConstraints']).toBe('FIXED_POS');
    });

    it('restores the pins, so a later boundary-flow layout is unaffected', () => {
        const g = graph([
            boundary('in1', WorkflowDiagramTypes.NODE_BOUNDARY_INPUT, 'FIRST_SEPARATE'),
            boundary('out1', WorkflowDiagramTypes.NODE_BOUNDARY_OUTPUT, 'LAST_SEPARATE')
        ]);
        const previous = releaseBoundaryNodeConstraints(g);
        restoreNodeLayoutOptions(g, previous);

        const by = (id: string) => g.children.find(c => c.id === id) as any;
        expect(by('in1').layoutOptions[CONSTRAINT]).toBe('FIRST_SEPARATE');
        expect(by('out1').layoutOptions[CONSTRAINT]).toBe('LAST_SEPARATE');
    });

    it('reaches pills nested below the root', () => {
        const inner = boundary('deep', WorkflowDiagramTypes.NODE_BOUNDARY_INPUT, 'FIRST_SEPARATE');
        const g = graph([Object.assign(new GNode(), {
            id: 'container', type: WorkflowDiagramTypes.NODE_ACTOR, children: [inner]
        })]);
        releaseBoundaryNodeConstraints(g);
        expect((inner as any).layoutOptions[CONSTRAINT]).toBe('NONE');
    });
});
