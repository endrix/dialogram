import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { GGraph, GNode, GPort, ServerLayoutKind } from '@eclipse-glsp/server';
import {
    WORKFLOW_LAYOUT_PERSISTENCE_KEY,
    WorkflowDiagramMetadata,
    WorkflowDiagramTypes
} from '@dialogram/shared';
import { WorkflowModelSubmissionHandler } from '../src/server/diagram-action-handlers';

/**
 * When an agent adds a node and/or connects an edge through the MCP tool surface, the tool
 * handlers raise the {@link AgentStructuralEditSignal}. On the next reload the model-submission
 * handler must run a full boundary-flow layout (so nothing is left parked at a default position)
 * INSTEAD of the park-below `placeNewNodes` path. Palette / hand-edit additions (no signal) keep
 * the park-below behaviour untouched.
 */
function buildHarness(options: {
    agentPending: boolean;
    unpositionedNodeCount: number;
    hasClientBounds?: boolean;
}) {
    const inPort = GPort.builder().id('t1.in').type(WorkflowDiagramTypes.PORT_INPUT).build();
    const t1 = GNode.builder()
        .id('t1')
        .type(WorkflowDiagramTypes.NODE_ACTOR)
        .addArg(WorkflowDiagramMetadata.ENTITY_NAME, 'inst1')
        .addChildren(inPort)
        .build();
    const root = GGraph.builder().id('root').addChildren(t1).build();

    const layoutMeta = {
        workflowFilePath: '/tmp/net.py',
        networkId: 'Net',
        hasPersistedLayout: true,
        hasPersistedEdgeRoutes: false,
        didInitialLayout: false,
        hasClientBounds: options.hasClientBounds ?? true,
        allowInitialLayoutPersistence: true,
        unpositionedNodeCount: options.unpositionedNodeCount
    };

    const store = new Map<string, unknown>();
    store.set(WORKFLOW_LAYOUT_PERSISTENCE_KEY, layoutMeta);

    const modelState = {
        root,
        index: { get: () => undefined, find: () => undefined },
        get: (key: string) => store.get(key),
        set: (key: string, value: unknown) => store.set(key, value)
    };

    let layoutCalled = 0;
    const layoutEngine = { layout: async () => { layoutCalled += 1; } };

    let loadLayoutCalled = 0;
    const layoutPersistence = {
        loadLayout: async () => { loadLayoutCalled += 1; return new Map(); },
        saveLayoutImmediate: async () => {}
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
    (handler as any).layoutPersistence = layoutPersistence;
    (handler as any).rerouteHandler = { runReroute: async () => {} };

    let consumed = 0;
    (handler as any).agentEditSignal = {
        isPending: () => options.agentPending,
        consumePending: () => { consumed += 1; return options.agentPending; },
        markPending: () => {}
    };

    return {
        handler,
        node: t1,
        layoutCalled: () => layoutCalled,
        loadLayoutCalled: () => loadLayoutCalled,
        consumed: () => consumed
    };
}

describe('auto-layout after agent structural edits', () => {
    it('runs boundary-flow (not park-below) when an agent added a node', async () => {
        const h = buildHarness({ agentPending: true, unpositionedNodeCount: 1 });
        await h.handler.submitModelDirectly();
        // Boundary-flow ran; the park-below placeNewNodes path (loadLayout) did not.
        expect(h.layoutCalled()).toBe(1);
        expect(h.loadLayoutCalled()).toBe(0);
        expect(h.consumed()).toBe(1);
    });

    it('runs boundary-flow for an agent edge-only edit (no new nodes)', async () => {
        const h = buildHarness({ agentPending: true, unpositionedNodeCount: 0 });
        await h.handler.submitModelDirectly();
        expect(h.layoutCalled()).toBe(1);
        expect(h.loadLayoutCalled()).toBe(0);
    });

    it('fires even when the reload submit never gets a fresh client-bounds round-trip', async () => {
        // Real regression: a headless MCP create rewrites the .py and the diagram reloads, but a
        // refresh of an ALREADY-OPEN diagram reuses the client's existing node sizes and may never
        // emit a fresh ComputedBounds — so hasClientBounds stays false on the reload that carries
        // the agent's new node/edge (both hasClientBounds setters live only in the ComputedBounds
        // handler). Gating the agent auto-layout on hasClientBounds blocks it forever. The diagram
        // is already measured (existing persisted layout), so boundary-flow must still run.
        const h = buildHarness({ agentPending: true, unpositionedNodeCount: 1, hasClientBounds: false });
        await h.handler.submitModelDirectly();
        expect(h.layoutCalled()).toBe(1);
        expect(h.loadLayoutCalled()).toBe(0);
        expect(h.consumed()).toBe(1);
    });

    it('keeps park-below behaviour for palette / hand-edit additions (no agent signal)', async () => {
        const h = buildHarness({ agentPending: false, unpositionedNodeCount: 1 });
        await h.handler.submitModelDirectly();
        // No boundary-flow relayout; the new node is parked below via placeNewNodes.
        expect(h.layoutCalled()).toBe(0);
        expect(h.loadLayoutCalled()).toBe(1);
        expect((h.node as any).position).toBeDefined();
    });
});
