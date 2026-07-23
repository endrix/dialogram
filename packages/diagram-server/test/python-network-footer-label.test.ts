import { describe, expect, it } from 'vitest';
import { WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import { GraphGModelSource, type PyGraphDocument } from '../src/model/graph-gmodel-source';

describe('GraphGModelSource network footer type label', () => {
    it('keeps footer type label for network instances even when type matches instance label', () => {
        const doc: PyGraphDocument = {
            version: '1',
            graph: {
                id: 'root',
                nodes: [
                    {
                        id: 'node-1',
                        kind: 'workflow',
                        label: 'decoder_block',
                        type: 'decoder_block',
                        scope: 'root',
                        ports: []
                    }
                ],
                edges: []
            }
        };

        const result = new GraphGModelSource().transform(doc);
        const networkNode = result.graph.children?.find(child => child.type === WorkflowDiagramTypes.NODE_NETWORK);

        expect(networkNode?.args?.[WorkflowDiagramMetadata.IS_NETWORK_INSTANCE]).toBe(true);
        expect(networkNode?.args?.['wf:footerTypeLabel']).toBe('decoder_block');
    });

    it('keeps footer type label for network instances when type differs from instance label', () => {
        const doc: PyGraphDocument = {
            version: '1',
            graph: {
                id: 'root',
                nodes: [
                    {
                        id: 'node-1',
                        kind: 'workflow',
                        label: 'decoder_block_2',
                        type: 'decoder_block',
                        scope: 'root',
                        ports: []
                    }
                ],
                edges: []
            }
        };

        const result = new GraphGModelSource().transform(doc);
        const networkNode = result.graph.children?.find(child => child.type === WorkflowDiagramTypes.NODE_NETWORK);

        expect(networkNode?.args?.[WorkflowDiagramMetadata.IS_NETWORK_INSTANCE]).toBe(true);
        expect(networkNode?.args?.['wf:footerTypeLabel']).toBe('decoder_block');
    });

    it('omits footer type label for non-network actors when type matches label', () => {
        const doc: PyGraphDocument = {
            version: '1',
            graph: {
                id: 'root',
                nodes: [
                    {
                        id: 'node-1',
                        kind: 'actor',
                        label: 'tokenizer',
                        type: 'tokenizer',
                        scope: 'root',
                        ports: []
                    }
                ],
                edges: []
            }
        };

        const result = new GraphGModelSource().transform(doc);
        const actorNode = result.graph.children?.find(child => child.type === WorkflowDiagramTypes.NODE_ACTOR);

        expect(actorNode?.args?.[WorkflowDiagramMetadata.IS_NETWORK_INSTANCE]).toBeUndefined();
        expect(actorNode?.args?.['wf:footerTypeLabel']).toBeUndefined();
    });

    it('keeps footer type label for non-network actors when type differs from label', () => {
        const doc: PyGraphDocument = {
            version: '1',
            graph: {
                id: 'root',
                nodes: [
                    {
                        id: 'node-1',
                        kind: 'actor',
                        label: 'tokenizer_main',
                        type: 'Tokenizer',
                        scope: 'root',
                        ports: []
                    }
                ],
                edges: []
            }
        };

        const result = new GraphGModelSource().transform(doc);
        const actorNode = result.graph.children?.find(child => child.type === WorkflowDiagramTypes.NODE_ACTOR);

        expect(actorNode?.args?.[WorkflowDiagramMetadata.IS_NETWORK_INSTANCE]).toBeUndefined();
        expect(actorNode?.args?.['wf:footerTypeLabel']).toBe('Tokenizer');
    });
});
