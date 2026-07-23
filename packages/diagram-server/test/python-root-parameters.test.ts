import { describe, expect, it } from 'vitest';
import { WorkflowDiagramMetadata } from '@dialogram/shared';
import { GraphGModelSource, type PyGraphDocument } from '../src/model/graph-gmodel-source';

describe('GraphGModelSource root parameters', () => {
    it('preserves root-level network parameters from graph metadata', () => {
        const doc: PyGraphDocument = {
            version: '1',
            graph: {
                id: 'wf:decoder',
                meta: {
                    factoryName: 'make_decoder',
                    parameters: [
                        { name: 'ACCODED', type: 'int', value: '3' },
                        { name: 'ACPRED', type: 'int', value: '1' },
                        { name: 'FCODE_MASK', type: 'int', value: '0x7' }
                    ]
                },
                nodes: [{
                    id: 'workflow',
                    kind: 'workflow',
                    label: 'decoder',
                    scope: 'scope:root',
                    ports: [],
                    meta: {
                        source: { file: '/tmp/decoder.py', line: 1 }
                    }
                }],
                edges: []
            }
        };

        const result = new GraphGModelSource().transform(doc);

        expect(result.graph.args?.[WorkflowDiagramMetadata.NETWORK_FACTORY_NAME]).toBe('make_decoder');
        expect(result.graph.args?.[WorkflowDiagramMetadata.NETWORK_PARAMETERS]).toEqual([
            { name: 'ACCODED', type: 'int', value: '3' },
            { name: 'ACPRED', type: 'int', value: '1' },
            { name: 'FCODE_MASK', type: 'int', value: '0x7' }
        ]);
    });

    it('preserves partial graph errors and marks errored nodes', () => {
        const doc: PyGraphDocument = {
            version: '1',
            partial: true,
            errors: [
                { message: 'syntax error', file: '/tmp/broken.py', line: 4, column: 1 }
            ],
            graph: {
                id: 'wf:broken',
                nodes: [{
                    id: '__graph_export_error__',
                    kind: 'task',
                    label: 'Graph export failed',
                    scope: '',
                    ports: [],
                    meta: {
                        isErrored: true,
                        errorMessage: 'syntax error'
                    }
                }],
                edges: []
            }
        };

        const result = new GraphGModelSource().transform(doc);
        const errorNode = (result.graph.children ?? []).find((child: any) => child.id === 'Graph export failed') as any;

        expect(result.graph.args?.['wf:partial']).toBe(true);
        expect(result.graph.args?.['wf:errors']).toEqual([
            { message: 'syntax error', file: '/tmp/broken.py', line: 4, column: 1 }
        ]);
        // Static graph-export errors use the durable cal-node-graph-error class (not the
        // run-execution cal-node-error / IS_ERRORED, which the overlay glow cleanup strips).
        expect(errorNode?.cssClasses).toContain('cal-node-graph-error');
    });
});