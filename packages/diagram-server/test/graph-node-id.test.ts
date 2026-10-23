/**
 * A node keeps the id the producer gave it.
 *
 * The diagram names a node after its label (`adder`, `The eight CPU states`),
 * not after the id in the graph document (`node:scope:root:PIPE-FSM-001`).
 * Whatever the producer says about a node later says it by that id: a
 * published node state names `nodeId` as the producer's graph does. Without
 * the id on the node, such a state matched nothing and the diagram stayed
 * unpainted, with nothing reported. `wf:graphNodeId` carries it, on every
 * kind of node.
 */
import { describe, expect, it } from 'vitest';
import { WorkflowDiagramMetadata } from '@dialogram/shared';
import { GraphGModelSource, type PyGraphDocument } from '../src/model/graph-gmodel-source';

const doc: PyGraphDocument = {
    version: '1',
    graph: {
        id: 'root',
        nodes: [
            { id: 'node:scope:root:PIPE-FSM-001', kind: 'requirement', label: 'The eight CPU states', scope: 'root', ports: [] },
            { id: 'node:scope:root:EXT-001', kind: 'source', label: 'A source', scope: 'root', meta: { external: true }, ports: [] }
        ],
        edges: []
    }
};

describe('the producer’s id on a node', () => {
    const children = (new GraphGModelSource({} as any).transform(doc).graph.children ?? []) as any[];

    it('is kept beside the label the diagram names the node by', () => {
        const node = children.find(child => child.id === 'The eight CPU states');

        expect(node?.args?.[WorkflowDiagramMetadata.GRAPH_NODE_ID]).toBe('node:scope:root:PIPE-FSM-001');
    });

    it('is kept on an external node too', () => {
        const node = children.find(child => child.args?.[WorkflowDiagramMetadata.GRAPH_NODE_ID] === 'node:scope:root:EXT-001');

        expect(node?.id).toBe('A source');
    });
});
