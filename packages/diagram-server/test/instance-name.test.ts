/**
 * The name a node navigates as, said by the producer.
 *
 * A drill-down names the crumb, and the outline finds its row, by the node's
 * instance name, which has always been its label. A producer whose node is
 * drawn under one name and navigates under another (a clause of document B
 * drawn at the edge of document A, which drills into B) gives the navigating
 * name on `meta.instanceName`. The label, and the entity name rename and
 * lookups use, do not move.
 */
import { describe, expect, it } from 'vitest';
import { WorkflowDiagramMetadata } from '@dialogram/shared';
import { GraphGModelSource, type PyGraphDocument } from '../src/model/graph-gmodel-source';

function docWith(meta?: Record<string, unknown>): PyGraphDocument {
    return {
        version: '1',
        graph: {
            id: 'root',
            nodes: [{
                id: 'node:a',
                kind: 'requirement',
                label: 'Admission buffer depth',
                type: 'PRM-BUF-001',
                scope: 'root',
                meta,
                ports: [{ id: 'p', name: 'in', direction: 'in' }]
            }],
            edges: []
        }
    };
}

const nodeFor = (meta?: Record<string, unknown>): any =>
    new GraphGModelSource().transform(docWith(meta)).graph.children
        ?.find((child: any) => child.id === 'Admission buffer depth');

describe('a producer’s instance name', () => {
    it('is the label unless the producer says otherwise', () => {
        const node = nodeFor({ networkInstance: true, referencedEntityName: 'DOC-OPTIONS' });
        expect(node.args['wf:entityInstanceName']).toBe('Admission buffer depth');
        expect(node.args[WorkflowDiagramMetadata.ENTITY_NAME]).toBe('Admission buffer depth');
    });

    it('becomes meta.instanceName, trimmed, and leaves the label and entity name alone', () => {
        const node = nodeFor({ networkInstance: true, referencedEntityName: 'DOC-OPTIONS', instanceName: ' DOC-OPTIONS ' });
        expect(node.args['wf:entityInstanceName']).toBe('DOC-OPTIONS');
        expect(node.args[WorkflowDiagramMetadata.ENTITY_NAME]).toBe('Admission buffer depth');
        expect(node.args[WorkflowDiagramMetadata.REFERENCED_ENTITY_NAME]).toBe('DOC-OPTIONS');
    });

    it('ignores a value that is not a non-empty string', () => {
        expect(nodeFor({ instanceName: '' }).args['wf:entityInstanceName']).toBe('Admission buffer depth');
        expect(nodeFor({ instanceName: 42 }).args['wf:entityInstanceName']).toBe('Admission buffer depth');
        expect(nodeFor({ instanceName: ['x'] }).args['wf:entityInstanceName']).toBe('Admission buffer depth');
    });
});
