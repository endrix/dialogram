import { describe, expect, it } from 'vitest';
import { WorkflowDiagramMetadata } from '@dialogram/shared';
import { GraphGModelSource, type PyGraphDocument } from '../src/model/graph-gmodel-source';

describe('GraphGModelSource source uri normalization', () => {
    it('normalizes raw source file paths into file uris for navigation metadata', () => {
        const doc: PyGraphDocument = {
            version: '1',
            graph: {
                id: 'root',
                nodes: [{
                    id: 'node-1',
                    kind: 'workflow',
                    label: 'Main',
                    scope: 'root',
                    ports: [],
                    meta: {
                        source: {
                            file: '/Users/endrix/git/streamblocks/streamblocks-mlir/examples/python/qwen/layer.py',
                            line: 12
                        }
                    }
                }],
                edges: []
            }
        };

        const result = new GraphGModelSource().transform(doc);
        const workflowNode = result.graph.children?.find(child => child.id === 'Main');

        expect(workflowNode?.args?.[WorkflowDiagramMetadata.REFERENCED_URI]).toBe(
            'file:///Users/endrix/git/streamblocks/streamblocks-mlir/examples/python/qwen/layer.py'
        );
    });
});