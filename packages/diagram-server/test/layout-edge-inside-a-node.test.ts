/**
 * An edge whose endpoints live on the same node.
 *
 * ELK stores each edge on the lowest common ancestor of its endpoints. That is
 * the graph for an ordinary edge between two nodes — but not for an edge whose
 * source and target are ports of the SAME node, where the ancestor is that
 * node. A feedback edge is exactly that shape:
 *
 *     connect(refine.Again, refine.Back)   # the convergence-loop idiom
 *
 * Only the graph is built with an `edges` array; a transformed node gets
 * `children` and `ports` and nothing else. So the layout threw
 * `Cannot read properties of undefined (reading 'push')` and took the whole
 * diagram with it — every workflow with a feedback loop failed to lay out,
 * reported to the user as "An unknown error occurred".
 *
 * These run the real ELK against the real configurator.
 */
import { describe, expect, it } from 'vitest';
import ELK from 'elkjs/lib/elk.bundled.js';
import { GEdge, GGraph, GNode, GPort } from '@eclipse-glsp/server';
import { DefaultElementFilter } from '@eclipse-glsp/layout-elk';
import { WorkflowDiagramTypes } from '@dialogram/shared';
import { WorkflowElkLayoutEngine } from '../src/server/elk-layout-engine';
import { WorkflowLayoutConfigurator } from '../src/server/layout-configurator';

function find(element: any, id: string): any {
    if (element?.id === id) { return element; }
    for (const child of element?.children ?? []) {
        const hit = find(child, id);
        if (hit) { return hit; }
    }
    return undefined;
}

function node(id: string, inputs: string[], outputs: string[]): GNode {
    const port = (name: string, type: string): GPort =>
        GPort.builder().id(`${id}_${name}`).type(type).size(7, 7).build();
    return GNode.builder()
        .id(id)
        .type(WorkflowDiagramTypes.NODE_ACTOR)
        .size(140, 60)
        .addChildren(...inputs.map(name => port(name, WorkflowDiagramTypes.PORT_INPUT)))
        .addChildren(...outputs.map(name => port(name, WorkflowDiagramTypes.PORT_OUTPUT)))
        .build();
}

/** The shape of `examples/12_repair_loop.py`: a seeder into a node that feeds itself. */
async function layoutRepairLoop(withFeedback: boolean): Promise<GGraph> {
    const drafter = node('drafter', ['Brief'], ['Score']);
    const refine = node('refine', ['Start', 'Back'], ['Again', 'Final']);
    const edges = [
        GEdge.builder().id('e0').type(WorkflowDiagramTypes.EDGE_CONNECTION)
            .sourceId('drafter_Score').targetId('refine_Start').build(),
        ...(withFeedback
            ? [GEdge.builder().id('e1').type(WorkflowDiagramTypes.EDGE_CONNECTION)
                .sourceId('refine_Again').targetId('refine_Back').build()]
            : [])
    ];
    const root = GGraph.builder().id('root').addChildren(drafter, refine, ...edges).build();

    const modelState: any = {
        root,
        index: { get: (id: string) => find(root, id), findByClass: (id: string) => find(root, id) }
    };
    await new WorkflowElkLayoutEngine(
        () => new (ELK as any)({ algorithms: ['layered'] }),
        new DefaultElementFilter(),
        new WorkflowLayoutConfigurator(),
        modelState
    ).layout();
    return root;
}

const positionOf = (root: any, id: string) => find(root, id).position;
const edgeOf = (root: any, id: string) => (root.children ?? []).find((c: any) => c.id === id);

describe('a workflow whose node feeds itself', () => {
    it('lays out at all', async () => {
        await expect(layoutRepairLoop(true)).resolves.toBeDefined();
    });

    it('routes the feedback edge rather than dropping it', async () => {
        // Not just "did not throw": an edge the layout silently skips leaves the
        // loop invisible, which reads as a working diagram that is missing a wire.
        const root = await layoutRepairLoop(true);

        expect(edgeOf(root, 'e1').routingPoints?.length ?? 0).toBeGreaterThan(0);
    });

    it('still routes the ordinary edge beside it', async () => {
        const root = await layoutRepairLoop(true);

        expect(edgeOf(root, 'e0').routingPoints?.length ?? 0).toBeGreaterThan(0);
    });

    /**
     * The loop must not push the graph around. Feedback is a property of one
     * node, so the layer assignment it produces should be the one it produces
     * without it.
     */
    it('places the nodes where it would without the loop', async () => {
        const withLoop = await layoutRepairLoop(true);
        const without = await layoutRepairLoop(false);

        expect(positionOf(withLoop, 'drafter')).toEqual(positionOf(without, 'drafter'));
        expect(positionOf(withLoop, 'refine').y).toEqual(positionOf(without, 'refine').y);
    });

    /** The control: the plain graph has to keep working. */
    it('leaves a graph without a loop alone', async () => {
        const root = await layoutRepairLoop(false);

        expect(edgeOf(root, 'e0').routingPoints?.length ?? 0).toBeGreaterThan(0);
        expect(positionOf(root, 'drafter')).toBeDefined();
    });
});
