import { describe, expect, it } from 'vitest';
import { GEdge, GGraph, GNode, GPort, ServerLayoutKind } from '@eclipse-glsp/server';
import { WORKFLOW_LAYOUT_PERSISTENCE_KEY, WorkflowDiagramTypes } from '@dialogram/shared';
import { WorkflowModelSubmissionHandler } from '../src/server/diagram-action-handlers';

/**
 * Characterization for the 2-node smoke fixture (IntSource -> PrintSink).
 *
 * Attribution question (session-init-race investigation, item 4): could the
 * persistent fresh-open misalignment be caused by the pre-init dropped action,
 * or is it inherent to the ELK + boundary-flow routine?
 *
 * Two facts pin it to the layout routine, NOT the dropped action:
 *  1. The initial ELK layout only runs when `layoutMeta.hasClientBounds` is true
 *     (see WorkflowModelSubmissionHandler.submitModelDirectly). `hasClientBounds`
 *     is set exclusively inside WorkflowComputedBoundsActionHandler, i.e. AFTER
 *     the RequestModel → RequestBounds → ComputedBounds round-trip, which happens
 *     well after the client session is initialized. A pre-init dropped action
 *     therefore cannot influence the geometry of the initial layout.
 *  2. For the source→sink fixture the boundary-flow routine is symmetric: the
 *     input-less source is pinned to FIRST_SEPARATE and the output-less sink to
 *     LAST_SEPARATE at layout time. This test locks that both constraints are
 *     applied simultaneously (and restored afterwards), so the layer assignment
 *     is deterministic and independent of any client/session action.
 */
describe('initial ELK layout: 2-node source -> sink boundary-flow', () => {
    it('pins the source to FIRST_SEPARATE and the sink to LAST_SEPARATE at layout time (both applied), then restores', async () => {
        // Source task node: output port only -> one-sided (no input).
        const sourceOut = GPort.builder().id('source.out').type(WorkflowDiagramTypes.PORT_OUTPUT).build();
        const source = GNode.builder().id('source').type(WorkflowDiagramTypes.NODE_ACTOR).addChildren(sourceOut).build();

        // Sink task node: input port only -> one-sided (no output).
        const sinkIn = GPort.builder().id('sink.in').type(WorkflowDiagramTypes.PORT_INPUT).build();
        const sink = GNode.builder().id('sink').type(WorkflowDiagramTypes.NODE_ACTOR).addChildren(sinkIn).build();

        const edge = GEdge.builder().id('e0').type('edge:connection').sourceId('source.out').targetId('sink.in').build();

        const root = GGraph.builder().id('root').addChildren(source).addChildren(sink).addChildren(edge).build();

        const layoutMeta = {
            workflowFilePath: '/tmp/net.py',
            networkId: 'Net',
            hasPersistedLayout: false,
            hasPersistedEdgeRoutes: false,
            didInitialLayout: false,
            hasClientBounds: true,
            allowInitialLayoutPersistence: true
        };

        const store = new Map<string, unknown>();
        store.set(WORKFLOW_LAYOUT_PERSISTENCE_KEY, layoutMeta);

        const modelState = {
            root,
            index: { get: () => undefined, find: () => undefined },
            get: (key: string) => store.get(key),
            set: (key: string, value: unknown) => store.set(key, value)
        };

        // Capture both nodes' layer constraints at the exact moment ELK ran.
        let sourceConstraintAtLayout: unknown;
        let sinkConstraintAtLayout: unknown;
        const layoutEngine = {
            layout: async () => {
                sourceConstraintAtLayout = (source as any).layoutOptions?.['elk.layered.layering.layerConstraint'];
                sinkConstraintAtLayout = (sink as any).layoutOptions?.['elk.layered.layering.layerConstraint'];
            }
        };

        const handler = new WorkflowModelSubmissionHandler();
        (handler as any).layoutEngine = layoutEngine;
        (handler as any).diagramConfiguration = {
            layoutKind: ServerLayoutKind.MANUAL,
            needsClientLayout: true,
            animatedUpdate: false
        };
        (handler as any).modelState = modelState;
        (handler as any).serializer = { createSchema: () => ({}) };
        (handler as any).commandStack = { isDirty: false };
        (handler as any).requestModelAction = { requestId: 'r1' };
        (handler as any).layoutPersistence = { saveLayoutImmediate: async () => {} };

        await handler.submitModelDirectly();

        // Both one-sided task nodes were pinned to their dedicated outer layers.
        expect(sourceConstraintAtLayout).toBe('FIRST_SEPARATE');
        expect(sinkConstraintAtLayout).toBe('LAST_SEPARATE');

        // ...and both temporary constraints were restored to their original (absent) value.
        expect((source as any).layoutOptions?.['elk.layered.layering.layerConstraint']).toBeUndefined();
        expect((sink as any).layoutOptions?.['elk.layered.layering.layerConstraint']).toBeUndefined();
    });
});
