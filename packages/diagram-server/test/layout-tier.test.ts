import { describe, expect, it, vi } from 'vitest';
import { GEdge, GGraph, GNode, type GModelElement } from '@eclipse-glsp/server';
import { DefaultElementFilter } from '@eclipse-glsp/layout-elk';
import { WorkflowDiagramTypes } from '@dialogram/shared';
import {
    FAST_LAYOUT_OPTIONS,
    LAYOUT_TIER_FAST_EDGES,
    LAYOUT_TIER_FAST_NODES,
    LAYOUT_TIER_MIDDLE_EDGES,
    LAYOUT_TIER_MIDDLE_NODES,
    MIDDLE_LAYOUT_OPTIONS,
    WorkflowLayoutConfigurator,
    countLayoutElements,
    layoutTierFor
} from '../src/server/layout-configurator';
import { WorkflowElkLayoutEngine } from '../src/server/elk-layout-engine';
import { UNTANGLED_ELK_OPTIONS } from '../src/operations/layout-tuned-handler';

/**
 * The graph's size picks the ELK preset (layout-configurator.ts): the default
 * preset up to the first threshold, exactly as before; the middle preset above
 * it; the fast preset above the second. The measurements behind the thresholds
 * are in the configurator's doc comment; these tests hold the rule, on
 * synthetic graphs, without running ELK on a large one.
 */
function node(id: string, type: string = WorkflowDiagramTypes.NODE_ACTOR, children: GModelElement[] = []): GNode {
    return GNode.builder().id(id).type(type).addChildren(...children).build();
}

function edge(id: string, from: string, to: string): GEdge {
    return GEdge.builder().id(id).type(WorkflowDiagramTypes.EDGE_CONNECTION).sourceId(from).targetId(to).build();
}

/** A chain of `nodes` nodes with `edges` edges between neighbours (wrapping), each node with a header compartment node. */
function graph(nodes: number, edges: number = 0): GGraph {
    const children: GModelElement[] = [];
    for (let i = 0; i < nodes; i++) {
        children.push(node(`n${i}`, WorkflowDiagramTypes.NODE_ACTOR, [node(`n${i}-header`, WorkflowDiagramTypes.COMPARTMENT_HEADER)]));
    }
    for (let i = 0; i < edges; i++) {
        children.push(edge(`e${i}`, `n${i % Math.max(nodes, 1)}`, `n${(i + 1) % Math.max(nodes, 1)}`));
    }
    return GGraph.builder().id('g').type(WorkflowDiagramTypes.GRAPH).addChildren(...children).build();
}

const TODAY: Record<string, string> = {
    'elk.algorithm': 'layered',
    'elk.edgeRouting': 'ORTHOGONAL',
    'elk.layered.layering.strategy': 'NETWORK_SIMPLEX',
    'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
    'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
    'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    'elk.layered.thoroughness': '15',
    'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
    'elk.layered.feedbackEdges': 'true'
};

describe('countLayoutElements', () => {
    it('counts nodes at any depth, skips compartments, counts edges', () => {
        const container = node('if', WorkflowDiagramTypes.NODE_STRUCTURE_IF, [
            node('then', WorkflowDiagramTypes.NODE_STRUCTURE_IF_BRANCH, [node('a'), node('b')]),
            node('header', WorkflowDiagramTypes.COMPARTMENT_HEADER)
        ]);
        const root = GGraph.builder().id('g').type(WorkflowDiagramTypes.GRAPH)
            .addChildren(container, node('c'), edge('e1', 'a', 'c'), edge('e2', 'b', 'c')).build();
        expect(countLayoutElements(root)).toEqual({ nodes: 5, edges: 2 });
    });
});

describe('layoutTierFor', () => {
    it('is the default tier up to and including the first thresholds', () => {
        expect(layoutTierFor({ nodes: 0, edges: 0 })).toBe('default');
        expect(layoutTierFor({ nodes: LAYOUT_TIER_MIDDLE_NODES, edges: LAYOUT_TIER_MIDDLE_EDGES })).toBe('default');
    });
    it('is the middle tier above either first threshold', () => {
        expect(layoutTierFor({ nodes: LAYOUT_TIER_MIDDLE_NODES + 1, edges: 0 })).toBe('middle');
        expect(layoutTierFor({ nodes: 10, edges: LAYOUT_TIER_MIDDLE_EDGES + 1 })).toBe('middle');
        expect(layoutTierFor({ nodes: LAYOUT_TIER_FAST_NODES, edges: LAYOUT_TIER_FAST_EDGES })).toBe('middle');
    });
    it('is the fast tier above either second threshold', () => {
        expect(layoutTierFor({ nodes: LAYOUT_TIER_FAST_NODES + 1, edges: 0 })).toBe('fast');
        expect(layoutTierFor({ nodes: 10, edges: LAYOUT_TIER_FAST_EDGES + 1 })).toBe('fast');
    });
});

describe('WorkflowLayoutConfigurator.graphOptions by graph size', () => {
    const configurator = new WorkflowLayoutConfigurator();

    it('gives a small graph the default preset, unchanged', () => {
        const options = configurator.apply(graph(40, 106))!;
        expect(options).toMatchObject(TODAY);
        expect(options).toEqual(configurator.apply(graph(0)));
        for (const key of Object.keys(FAST_LAYOUT_OPTIONS)) {
            expect(options[key]).not.toBe(FAST_LAYOUT_OPTIONS[key]);
        }
    });

    it('gives a graph at the first threshold the default preset still', () => {
        expect(configurator.apply(graph(LAYOUT_TIER_MIDDLE_NODES, LAYOUT_TIER_MIDDLE_EDGES))).toMatchObject(TODAY);
    });

    it('gives a graph above the first threshold the middle preset', () => {
        const options = configurator.apply(graph(LAYOUT_TIER_MIDDLE_NODES + 1))!;
        expect(options).toMatchObject(MIDDLE_LAYOUT_OPTIONS);
        expect(options['elk.layered.crossingMinimization.strategy']).toBe('LAYER_SWEEP');
        expect(options['elk.edgeRouting']).toBe('ORTHOGONAL');
        expect(options['elk.layered.layering.strategy']).toBe('NETWORK_SIMPLEX');
    });

    it('picks the middle preset on the edge count alone', () => {
        expect(configurator.apply(graph(20, LAYOUT_TIER_MIDDLE_EDGES + 1))).toMatchObject(MIDDLE_LAYOUT_OPTIONS);
    });

    it('gives a graph above the second threshold the fast preset, with polyline routing', () => {
        const options = configurator.apply(graph(LAYOUT_TIER_FAST_NODES + 1))!;
        expect(options).toMatchObject(FAST_LAYOUT_OPTIONS);
        expect(options['elk.layered.crossingMinimization.strategy']).toBe('NONE');
        expect(options['elk.layered.nodePlacement.strategy']).toBe('SIMPLE');
        expect(options['elk.edgeRouting']).toBe('POLYLINE');
    });

    it('leaves the fixed (post-drag) configuration alone whatever the size', () => {
        const root = graph(LAYOUT_TIER_FAST_NODES + 1);
        (root as any).layoutOptions = { 'elk.algorithm': 'fixed' };
        const options = configurator.apply(root)!;
        expect(options['elk.algorithm']).toBe('fixed');
        expect(options['elk.layered.nodePlacement.strategy']).toBeUndefined();
    });
});

describe('WorkflowElkLayoutEngine and the tier', () => {
    function engineFor(root: GGraph, dispatcher?: { dispatch: (a: any) => Promise<void> }): WorkflowElkLayoutEngine {
        const modelState: any = { root, index: { get: () => undefined } };
        return new WorkflowElkLayoutEngine(() => ({}) as any, new DefaultElementFilter(), new WorkflowLayoutConfigurator(), modelState, dispatcher as any);
    }

    function elkRootOptions(engine: WorkflowElkLayoutEngine, root: GGraph): Record<string, string> {
        (engine as any).elkEdges = [];
        (engine as any).idToElkElement = new Map();
        return (engine as any).transformGraph(root).layoutOptions;
    }

    it('lets Untangled override the preset in the middle tier', () => {
        const root = graph(LAYOUT_TIER_MIDDLE_NODES + 1);
        (root as any).layoutOptions = { ...UNTANGLED_ELK_OPTIONS };
        expect(elkRootOptions(engineFor(root), root)).toMatchObject(UNTANGLED_ELK_OPTIONS);
    });

    it('re-asserts the fast preset over Untangled in the fast tier', () => {
        const root = graph(LAYOUT_TIER_FAST_NODES + 1);
        (root as any).layoutOptions = { ...UNTANGLED_ELK_OPTIONS };
        const options = elkRootOptions(engineFor(root), root);
        expect(options).toMatchObject(FAST_LAYOUT_OPTIONS);
        expect(options['elk.layered.crossingMinimization.greedySwitchHierarchical.type']).toBe('TWO_SIDED');
    });

    it('logs the tier per layout and tells the user about a rough layout only in the fast tier', async () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        try {
            for (const [nodes, tier] of [[3, 'default'], [LAYOUT_TIER_FAST_NODES + 1, 'fast']] as const) {
                const dispatched: any[] = [];
                const root = graph(nodes);
                const engine = engineFor(root, { dispatch: async a => { dispatched.push(a); } });
                (engine as any).elk = { layout: async (g: any) => g };
                await engine.layout();
                expect(log).toHaveBeenCalledWith(`[dialogram perf] layout g: tier=${tier} nodes=${nodes} edges=0`);
                if (tier === 'fast') {
                    expect(dispatched).toHaveLength(1);
                    expect(dispatched[0].kind).toBe('status');
                    expect(dispatched[0].message).toBe(`${nodes} nodes: laid out roughly. Run Layout for the full layout.`);
                } else {
                    expect(dispatched).toHaveLength(0);
                }
            }
        } finally {
            log.mockRestore();
        }
    });
});
