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

    // The diagram's own input port, as the model builder (graph-gmodel-source) makes it: a
    // boundary node whose entity name is the port's name too, its port inside.
    const textFilePort = GPort.builder().id('wf.TextFile.p').type(WorkflowDiagramTypes.PORT_OUTPUT)
        .addArg(WorkflowDiagramMetadata.PORT_NAME, 'TextFile')
        .addArg(WorkflowDiagramMetadata.PORT_DIRECTION, 'out')
        .build();
    const textFile = GNode.builder().id('wf.TextFile').type(WorkflowDiagramTypes.NODE_BOUNDARY_INPUT)
        .addArg(WorkflowDiagramMetadata.ENTITY_NAME, 'TextFile')
        .addArg(WorkflowDiagramMetadata.ENTITY_TYPE, 'Port')
        .addArg(WorkflowDiagramMetadata.PORT_NAME, 'TextFile')
        .addChildren(textFilePort)
        .build();
    // An output of the diagram, from a producer that names it by its port name only.
    const reportPort = GPort.builder().id('wf.Report.p').type(WorkflowDiagramTypes.PORT_INPUT)
        .addArg(WorkflowDiagramMetadata.PORT_DIRECTION, 'in')
        .build();
    const report = GNode.builder().id('wf.Report').type(WorkflowDiagramTypes.NODE_BOUNDARY_OUTPUT)
        .addArg(WorkflowDiagramMetadata.PORT_NAME, 'Report')
        .addChildren(reportPort)
        .build();

    // A diagram port whose names all differ: entity 'rst_label', node port 'reset', its port 'rst_n'.
    const resetPort = GPort.builder().id('wf.rst.p').type(WorkflowDiagramTypes.PORT_OUTPUT)
        .addArg(WorkflowDiagramMetadata.PORT_NAME, 'rst_n')
        .build();
    const reset = GNode.builder().id('wf.rst').type(WorkflowDiagramTypes.NODE_BOUNDARY_INPUT)
        .addArg(WorkflowDiagramMetadata.ENTITY_NAME, 'rst_label')
        .addArg(WorkflowDiagramMetadata.PORT_NAME, 'reset')
        .addChildren(resetPort)
        .build();

    return GGraph.builder().id('root').addChildren(producer, consumer, dup, textFile, report, reset).build();
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

    it("resolves a bare name to one of the diagram's own ports", () => {
        const root = buildRoot();
        expect(resolveEndpointElementId(root, 'TextFile')).toEqual({ ok: true, elementId: 'wf.TextFile.p' });
    });

    it("refuses a bare name that is no diagram port, naming the diagram's ports", () => {
        const result = resolveEndpointElementId(buildRoot(), 'producer');
        expect(result.ok).toBe(false);
        expect(result.message).toContain("No diagram port named 'producer'");
        expect(result.message).toContain('TextFile');
        expect(result.message).toContain('Report');
    });

    // The builder gives a workflow's input node the port's name as its entity name; taken for an
    // ordinary node, it was never found by name, and create-edges said the diagram had no ports.
    it("resolves a diagram port whose node carries an entity name, and one named by its port name only", () => {
        const root = buildRoot();
        expect(resolveEndpointElementId(root, 'TextFile')).toEqual({ ok: true, elementId: 'wf.TextFile.p' });
        expect(resolveEndpointElementId(root, 'Report')).toEqual({ ok: true, elementId: 'wf.Report.p' });
    });

    it("finds a diagram port by its port name, and by its entity name in a dotted spec", () => {
        const root = buildRoot();
        expect(resolveEndpointElementId(root, 'reset')).toEqual({ ok: true, elementId: 'wf.rst.p' });
        // Only the node's name: a name its inner port has would make others ambiguous.
        expect(resolveEndpointElementId(root, 'rst_n').ok).toBe(false);
        expect(resolveEndpointElementId(root, 'rst_label.rst_n')).toEqual({ ok: true, elementId: 'wf.rst.p' });
        expect(resolveEndpointElementId(root, 'TextFile.TextFile')).toEqual({ ok: true, elementId: 'wf.TextFile.p' });
        // And the names it accepts are the names it lists.
        expect(resolveEndpointElementId(root, 'nobody.x').message).toContain('rst_label');
    });
});
