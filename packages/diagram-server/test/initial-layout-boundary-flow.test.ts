import { describe, expect, it } from 'vitest';
import { GGraph, GNode, GPort, ServerLayoutKind } from '@eclipse-glsp/server';
import { WORKFLOW_LAYOUT_PERSISTENCE_KEY, WorkflowDiagramTypes } from '@dialogram/shared';
import { WorkflowModelSubmissionHandler } from '../src/server/diagram-action-handlers';

/**
 * The manual auto-layout UI dispatches `dialogram.layoutBoundaryFlow`, which applies
 * boundary-flow layer constraints (one-sided task nodes are pinned to FIRST_SEPARATE /
 * LAST_SEPARATE outer layers) before running ELK. The INITIAL layout pass on a fresh
 * open must run the SAME routine — otherwise the first render (plain ELK) diverges from
 * every subsequent manual layout (blank areas, stray sink nodes).
 */
describe('initial ELK layout uses the boundary-flow routine', () => {
    it('applies boundary-flow layer constraints on one-sided task nodes before ELK, then restores them', async () => {
        // A source task node: has an output port but no input port -> one-sided.
        const outPort = GPort.builder().id('t1.out').type(WorkflowDiagramTypes.PORT_OUTPUT).build();
        const t1 = GNode.builder().id('t1').type(WorkflowDiagramTypes.NODE_ACTOR).addChildren(outPort).build();
        const root = GGraph.builder().id('root').addChildren(t1).build();

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

        // Capture the layer constraint on the one-sided node at the moment ELK ran.
        let constraintAtLayoutTime: unknown;
        const layoutEngine = {
            layout: async () => {
                constraintAtLayoutTime = (t1 as any).layoutOptions?.['elk.layered.layering.layerConstraint'];
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

        // Boundary-flow routine pinned the input-less node to the first separate layer during layout.
        expect(constraintAtLayoutTime).toBe('FIRST_SEPARATE');
        // ...and restored the original (absent) layout options afterwards.
        expect((t1 as any).layoutOptions?.['elk.layered.layering.layerConstraint']).toBeUndefined();
    });
});
