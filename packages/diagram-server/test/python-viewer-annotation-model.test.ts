import { describe, expect, it } from 'vitest';
import { WorkflowDiagramMetadata } from '@dialogram/shared';
import { GraphGModelSource, type PyGraphDocument } from '../src/model/graph-gmodel-source';

describe('GraphGModelSource viewer annotations', () => {
    it('preserves viewer args from meta.viewer and serializes list args for the client parser', () => {
        const doc: PyGraphDocument = {
            version: '1',
            graph: {
                id: 'root',
                nodes: [{
                    id: 'viewer-1',
                    kind: 'viewer',
                    label: 'HtmlViewer',
                    scope: 'root',
                    ports: [{
                        id: 'port-1',
                        name: 'In',
                        direction: 'in'
                    }],
                    meta: {
                        viewer: {
                            action_name: 'openWith',
                            inputs: ['In'],
                            viewType: 'livePreview.start.preview.atFile'
                        }
                    }
                }],
                edges: []
            }
        };

        const result = new GraphGModelSource().transform(doc);
        const viewerNode = result.graph.children?.find(child => child.id === 'HtmlViewer');
        const annotations = viewerNode?.args?.[WorkflowDiagramMetadata.ENTITY_DEFINITION_ANNOTATIONS] as Array<{
            name?: string;
            arguments?: Array<{ name?: string; value?: string }>;
        }> | undefined;

        expect(annotations).toBeDefined();
        expect(annotations).toHaveLength(1);
        expect(annotations?.[0]?.name).toBe('viewer');
        expect(annotations?.[0]?.arguments).toEqual(expect.arrayContaining([
            { name: 'action_name', value: 'openWith' },
            { name: 'inputs', value: '["In"]' },
            { name: 'viewType', value: 'livePreview.start.preview.atFile' }
        ]));
    });
});