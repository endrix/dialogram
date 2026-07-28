import { describe, expect, it } from 'vitest';
import { GEdge, GGraph, GNode, ServerLayoutKind } from '@eclipse-glsp/server';
import { WORKFLOW_LAYOUT_PERSISTENCE_KEY } from '@dialogram/shared';
import { WorkflowModelSubmissionHandler } from '../src/server/diagram-action-handlers';

/**
 * Regression guard for the GLSP 2.7 fresh-open layout degradation.
 *
 * The manual auto-layout path clears every edge's routing points before invoking
 * ELK (so pre-existing routes are not forwarded to ELK as fixed sections). The
 * INITIAL layout pass (first ComputedBounds, no persisted layout) must do the
 * same for parity — otherwise stale edge routes bias the fresh layout.
 */
describe('initial ELK layout', () => {
    it('clears edge routing points before running the initial ELK layout', async () => {
        const edge = GEdge.builder().id('e1').type('edge:connection').sourceId('n1').targetId('n2').build();
        (edge as any).routingPoints = [
            { x: 5, y: 5 },
            { x: 6, y: 6 }
        ];
        const n1 = GNode.builder().id('n1').type('node:instance').build();
        const n2 = GNode.builder().id('n2').type('node:instance').build();
        const root = GGraph.builder().id('root').addChildren(n1).addChildren(n2).addChildren(edge).build();

        // Fresh-open layout metadata that opens the initial-layout gate.
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
            index: { get: () => undefined },
            get: (key: string) => store.get(key),
            set: (key: string, value: unknown) => store.set(key, value)
        };

        // Capture whether the edge still carried routing points at the moment ELK ran.
        let routingPointsAtLayoutTime: number | undefined;
        const layoutEngine = {
            layout: async () => {
                routingPointsAtLayoutTime = (edge as any).routingPoints?.length;
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

        expect(routingPointsAtLayoutTime).toBeUndefined();
        expect((edge as any).routingPoints).toBeUndefined();
    });
});
