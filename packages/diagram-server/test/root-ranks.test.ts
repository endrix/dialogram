/**
 * The root laid out in ranks.
 *
 * A producer may rank the root's members (`meta.rank` on a node, `rank` on a
 * group scope): a document's clauses in one frame per refinement layer, the
 * layers in order along the flow. Edges run between the ranks either way.
 * These tests pin what the transform hands the layout, then run the real ELK
 * and check where the frames end up.
 */
import { describe, expect, it } from 'vitest';
import ELK from 'elkjs/lib/elk.bundled.js';
import { GGraph, GNode } from '@eclipse-glsp/server';
import { DefaultElementFilter } from '@eclipse-glsp/layout-elk';
import { WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import { GraphGModelSource, type PyGraphDocument } from '../src/model/graph-gmodel-source';
import { rootRankOptions } from '../src/model/group-edges';
import { applyBoundaryFlowLayerConstraints } from '../src/operations/boundary-flow-layout';
import { WorkflowElkLayoutEngine } from '../src/server/elk-layout-engine';
import { WorkflowLayoutConfigurator } from '../src/server/layout-configurator';
import { convertToGModelRoot } from '../src/server/gmodel-convert';

type Element = { id: string; type: string; args?: Record<string, any>; layoutOptions?: Record<string, string>; children?: Element[] };

/** A clause with an input and an output, in a frame. */
function clause(name: string, scope: string, meta?: Record<string, unknown>) {
    return {
        id: `node:${name}`,
        kind: 'requirement',
        label: name,
        scope,
        ports: [
            { id: `port:node:${name}:in`, name: 'in', direction: 'in' as const },
            { id: `port:node:${name}:out`, name: 'out', direction: 'out' as const }
        ],
        ...(meta ? { meta } : {})
    };
}

const edge = (from: string, to: string) => ({ id: `e:${from}->${to}`, from: `port:node:${from}:out`, to: `port:node:${to}:in`, scope: 'scope:root' });

/**
 * Three layers, given out of order: L0 to L1 along the ranks, and L2 to L1
 * against them (a refinement drawn from the refiner), which on its own
 * pulls L2 before L1.
 */
function ladder(ranks: Record<string, unknown> = { L0: 0, L1: 1, L2: 2 }): PyGraphDocument {
    return {
        version: '1',
        graph: {
            id: 'root',
            nodes: [
                clause('mechanism', 'scope:L2'),
                clause('intent', 'scope:L0'),
                clause('contract', 'scope:L1'),
                clause('other', 'scope:L1')
            ] as any,
            edges: [edge('intent', 'contract'), edge('mechanism', 'other')],
            subgraphs: (['L2', 'L0', 'L1'] as const).map(layer => ({
                id: `scope:${layer}`,
                kind: 'group',
                label: layer,
                ...(ranks[layer] !== undefined ? { rank: ranks[layer] } : {})
            })) as any
        }
    };
}

const find = (elements: Element[] | undefined, id: string): Element | undefined => {
    for (const element of elements ?? []) {
        if (element.id === id) {
            return element;
        }
        const hit = find(element.children, id);
        if (hit) {
            return hit;
        }
    }
    return undefined;
};

const frame = (layer: string) => `scope:scope:${layer}`;

describe('a root whose members carry a rank', () => {
    it('turns the ranks on for the root and puts each member in its rank, after a unit\'s inputs', () => {
        const { graph } = new GraphGModelSource().transform(ladder());
        expect(graph.layoutOptions).toEqual({
            'elk.partitioning.activate': 'true',
            'elk.separateConnectedComponents': 'false'
        });
        for (const [layer, rank] of [['L0', 0], ['L1', 1], ['L2', 2]] as const) {
            const group = find(graph.children as Element[], frame(layer))!;
            expect(group.args?.[WorkflowDiagramMetadata.RANK], layer).toBe(rank);
            expect(group.layoutOptions?.['elk.partitioning.partition'], layer).toBe(String(rank + 1));
        }
        // Inside a frame, nothing changes: the frame lays out its members on its own.
        expect(find(graph.children as Element[], 'contract')!.layoutOptions?.['elk.partitioning.partition']).toBeUndefined();
        expect(find(graph.children as Element[], frame('L1'))!.layoutOptions?.['elk.partitioning.activate']).toBeUndefined();
    });

    it('ranks a node of the root by its meta, and puts what has no rank after the last', () => {
        const doc = ladder({ L0: 0, L1: 1 });
        doc.graph.nodes.push(clause('loose', 'scope:root', { rank: 1 }) as any, clause('unranked', 'scope:root') as any);
        const children = new GraphGModelSource().transform(doc).graph.children as Element[];
        expect(find(children, 'loose')!.args?.[WorkflowDiagramMetadata.RANK]).toBe(1);
        expect(find(children, 'loose')!.layoutOptions?.['elk.partitioning.partition']).toBe('2');
        for (const id of ['unranked', frame('L2')]) {
            expect(find(children, id)!.layoutOptions?.['elk.partitioning.partition'], id).toBe('3');
        }
    });

    it('takes only a whole number from zero as a rank, and leaves a root with none as it was', () => {
        for (const rank of [-1, 1.5, '1', 3000000000]) {
            const { graph } = new GraphGModelSource().transform(ladder({ L0: rank, L1: rank, L2: rank }));
            expect(graph.layoutOptions, String(rank)).toBeUndefined();
            expect(find(graph.children as Element[], frame('L1'))!.args?.[WorkflowDiagramMetadata.RANK], String(rank)).toBeUndefined();
            expect(find(graph.children as Element[], frame('L1'))!.layoutOptions?.['elk.partitioning.partition'], String(rank)).toBeUndefined();
        }
    });

    it('stands a unit\'s inputs before the first rank', () => {
        const input = { id: 'in', type: WorkflowDiagramTypes.NODE_BOUNDARY_INPUT, children: [] } as any;
        const ranked = { id: 'ranked', type: WorkflowDiagramTypes.NODE_GROUP, args: { [WorkflowDiagramMetadata.RANK]: 0 }, children: [] } as any;
        const output = { id: 'out', type: WorkflowDiagramTypes.NODE_BOUNDARY_OUTPUT, children: [] } as any;
        expect(rootRankOptions([input, ranked, output])).toBeDefined();
        expect(input.layoutOptions['elk.partitioning.partition']).toBe('0');
        expect(ranked.layoutOptions['elk.partitioning.partition']).toBe('1');
        expect(output.layoutOptions['elk.partitioning.partition']).toBe('2');
    });
});

function index(element: any, into = new Map<string, any>()): Map<string, any> {
    into.set(element.id, element);
    for (const child of element.children ?? []) {
        index(child, into);
    }
    return into;
}

async function laidOut(doc: PyGraphDocument): Promise<Map<string, any>> {
    const root = convertToGModelRoot(new GraphGModelSource().transform(doc) as any) as unknown as GGraph;
    const byId = index(root);
    const modelState: any = { root, index: { get: (id: string) => byId.get(id), findByClass: (id: string) => byId.get(id) } };
    applyBoundaryFlowLayerConstraints(root, new Set(), false);
    await new WorkflowElkLayoutEngine(
        () => new (ELK as any)({ algorithms: ['layered'] }),
        new DefaultElementFilter(),
        new WorkflowLayoutConfigurator(),
        modelState
    ).layout();
    return byId;
}

describe('the layout of a root in ranks', () => {
    it('stands the frames in rank order along the flow, an edge against the ranks included', async () => {
        const byId = await laidOut(ladder());
        const at = (layer: string): GNode => byId.get(frame(layer)) as GNode;
        const right = (layer: string): number => at(layer).position.x + at(layer).size.width;
        expect(right('L0')).toBeLessThanOrEqual(at('L1').position.x);
        expect(right('L1')).toBeLessThanOrEqual(at('L2').position.x);
    });

    it('lets the edges pull the frames where nothing is ranked', async () => {
        // Without ranks, the edge from L2 back to L1 makes the layout put L2
        // first: the order the ranks are there to keep.
        const byId = await laidOut(ladder({}));
        const at = (layer: string): GNode => byId.get(frame(layer)) as GNode;
        expect(at('L2').position.x + at('L2').size.width).toBeLessThanOrEqual(at('L1').position.x + 1);
    });
});
