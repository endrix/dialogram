/**
 * A wire that is some bits of a port (a producer's `fromSlice`/`toSlice`: one
 * operand of a concatenation wired straight to the port) carries them as the
 * end's index, marked to be written whatever the captions.
 */
import { describe, expect, it } from 'vitest';
import { WorkflowDiagramMetadata } from '@dialogram/shared';
import { GraphGModelSource, type PyGraphDocument } from '../src/model/graph-gmodel-source';

const node = (id: string, ports: Array<[string, 'in' | 'out']>) => ({
    id, kind: 'instance', label: id, scope: 'root', ports: ports.map(([name, direction]) => ({ id: `${id}:${name}`, name, direction }))
});
const doc: PyGraphDocument = {
    version: '1',
    graph: {
        id: 'top',
        nodes: [node('src', [['q', 'out']]), node('dst', [['din', 'in']])],
        edges: [
            { id: 'e1', from: 'src:q', to: 'dst:din', scope: 'root', meta: { signal: 'q', toSlice: '7:4' } },
            { id: 'e2', from: 'src:q', to: 'dst:din', scope: 'root', meta: { signal: 'q' } }
        ]
    }
};

describe('a wire that is some bits of a port', () => {
    it('carries them as that end’s index, to be written always', () => {
        const graph: any = new GraphGModelSource().transform(doc).graph;
        const edges = graph.children.filter((c: any) => typeof c.sourceId === 'string');
        const sliced = edges.find((e: any) => e.args?.[WorkflowDiagramMetadata.EDGE_TO_INDEX] !== undefined);
        expect(sliced.args[WorkflowDiagramMetadata.EDGE_TO_INDEX]).toBe('7:4');
        expect(sliced.args[WorkflowDiagramMetadata.EDGE_SLICE]).toBe(true);
        const plain = edges.find((e: any) => e !== sliced);
        expect(plain.args?.[WorkflowDiagramMetadata.EDGE_SLICE]).toBeUndefined();
    });
});

describe('a sliced wire across a group frame', () => {
    it('says its bits only on the piece that reaches the port', () => {
        const grouped: PyGraphDocument = {
            version: '1',
            graph: {
                id: 'top',
                nodes: [node('src', [['q', 'out']]), { ...node('dst', [['din', 'in']]), scope: 'g' }],
                edges: [{ id: 'e1', from: 'src:q', to: 'dst:din', scope: 'root', meta: { signal: 'q', toSlice: 3 } }],
                subgraphs: [{ id: 'root', kind: 'root', parent: null }, { id: 'g', kind: 'group', parent: 'root', nodes: ['dst'] }]
            }
        };
        const graph: any = new GraphGModelSource().transform(grouped).graph;
        const edges: any[] = [];
        const walk = (e: any) => { if (typeof e.sourceId === 'string') { edges.push(e); } (e.children ?? []).forEach(walk); };
        walk(graph);
        const labelled = edges.filter(e => e.args?.[WorkflowDiagramMetadata.EDGE_TO_INDEX] !== undefined);
        expect(labelled).toHaveLength(1);
        expect(labelled[0].targetId).toBe(edges.find(e => e.args?.[WorkflowDiagramMetadata.EDGE_SEGMENT] === 'target')?.targetId);
        // A number is a slice too.
        expect(labelled[0].args[WorkflowDiagramMetadata.EDGE_TO_INDEX]).toBe('3');
    });
});

describe('the bits as the producer writes them', () => {
    it('carries a VHDL label beside the index, and only for an end that has bits', () => {
        const vhdl: PyGraphDocument = {
            version: '1',
            graph: {
                id: 'top',
                nodes: [node('src', [['q', 'out']]), node('dst', [['din', 'in']])],
                edges: [
                    { id: 'e1', from: 'src:q', to: 'dst:din', scope: 'root',
                      meta: { signal: 'q', toSlice: '7:4', toSliceLabel: '(7 downto 4)', fromSliceLabel: '(9)' } }
                ]
            }
        };
        const graph: any = new GraphGModelSource().transform(vhdl).graph;
        const edge = graph.children.find((c: any) => typeof c.sourceId === 'string');
        expect(edge.args[WorkflowDiagramMetadata.EDGE_TO_INDEX]).toBe('7:4');
        expect(edge.args[WorkflowDiagramMetadata.EDGE_TO_INDEX_LABEL]).toBe('(7 downto 4)');
        // No bits at the start: no label there either.
        expect(edge.args[WorkflowDiagramMetadata.EDGE_FROM_INDEX_LABEL]).toBeUndefined();
    });
});
