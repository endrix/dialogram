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
