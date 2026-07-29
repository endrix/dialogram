import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { GGraph, GNode, GPort } from '@eclipse-glsp/server';
import { WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import { resolveEndpointElementId, looksLikeNameSpec } from '../src/server/edge-endpoint-name-resolver';

/**
 * Build a two-node graph:
 *   producer  (out: port#producer.out)
 *   consumer  (in: port#consumer.in, out: port#consumer.out)
 *   duplicate (two ports both named 'p' — ambiguous)
 */
function buildRoot() {
    const producerOut = GPort.builder().id('producer.out').type(WorkflowDiagramTypes.PORT_OUTPUT)
        .addArg(WorkflowDiagramMetadata.PORT_NAME, 'out')
        .addArg(WorkflowDiagramMetadata.PORT_DIRECTION, 'out')
        .build();
    const producer = GNode.builder().id('n_producer').type(WorkflowDiagramTypes.NODE_ACTOR)
        .addArg(WorkflowDiagramMetadata.ENTITY_NAME, 'producer')
        .addChildren(producerOut)
        .build();

    const consumerIn = GPort.builder().id('consumer.in').type(WorkflowDiagramTypes.PORT_INPUT)
        .addArg(WorkflowDiagramMetadata.PORT_NAME, 'in')
        .addArg(WorkflowDiagramMetadata.PORT_DIRECTION, 'in')
        .build();
    const consumerOut = GPort.builder().id('consumer.out').type(WorkflowDiagramTypes.PORT_OUTPUT)
        .addArg(WorkflowDiagramMetadata.PORT_NAME, 'out')
        .addArg(WorkflowDiagramMetadata.PORT_DIRECTION, 'out')
        .build();
    const consumer = GNode.builder().id('n_consumer').type(WorkflowDiagramTypes.NODE_ACTOR)
        .addArg(WorkflowDiagramMetadata.ENTITY_NAME, 'consumer')
        .addChildren(consumerIn, consumerOut)
        .build();

    const dupA = GPort.builder().id('dup.p.a').type(WorkflowDiagramTypes.PORT_INPUT)
        .addArg(WorkflowDiagramMetadata.PORT_NAME, 'p').build();
    const dupB = GPort.builder().id('dup.p.b').type(WorkflowDiagramTypes.PORT_OUTPUT)
        .addArg(WorkflowDiagramMetadata.PORT_NAME, 'p').build();
    const dup = GNode.builder().id('n_dup').type(WorkflowDiagramTypes.NODE_ACTOR)
        .addArg(WorkflowDiagramMetadata.ENTITY_NAME, 'duplicate')
        .addChildren(dupA, dupB)
        .build();

    return GGraph.builder().id('root').addChildren(producer, consumer, dup).build();
}

describe('resolveEndpointElementId', () => {
    it('looksLikeNameSpec distinguishes name specs from raw ids', () => {
        expect(looksLikeNameSpec('producer.out')).toBe(true);
        expect(looksLikeNameSpec('n_producer')).toBe(false);
    });

    it('resolves nodeName.portName to the port element id (happy path)', () => {
        const root = buildRoot();
        expect(resolveEndpointElementId(root, 'producer.out')).toEqual({ ok: true, elementId: 'producer.out' });
        expect(resolveEndpointElementId(root, 'consumer.in')).toEqual({ ok: true, elementId: 'consumer.in' });
    });

    it('rejects a malformed spec with an actionable message', () => {
        const result = resolveEndpointElementId(buildRoot(), 'producer');
        expect(result.ok).toBe(false);
        expect((result as { message: string }).message).toMatch(/nodeName\.portName/);
    });

    it('names the unknown node and lists known nodes', () => {
        const result = resolveEndpointElementId(buildRoot(), 'ghost.out');
        expect(result.ok).toBe(false);
        const message = (result as { message: string }).message;
        expect(message).toMatch(/No node named 'ghost'/);
        expect(message).toContain('producer');
        expect(message).toContain('consumer');
    });

    it('names the missing port and lists the ports the node actually has', () => {
        const result = resolveEndpointElementId(buildRoot(), 'consumer.missing');
        expect(result.ok).toBe(false);
        const message = (result as { message: string }).message;
        expect(message).toMatch(/No port named 'missing' on node 'consumer'/);
        expect(message).toContain('in');
        expect(message).toContain('out');
    });

    it('reports an ambiguous match and steers to raw-id addressing', () => {
        const result = resolveEndpointElementId(buildRoot(), 'duplicate.p');
        expect(result.ok).toBe(false);
        const message = (result as { message: string }).message;
        expect(message).toMatch(/ambiguous/i);
        expect(message).toContain('dup.p.a');
        expect(message).toContain('dup.p.b');
    });
});
