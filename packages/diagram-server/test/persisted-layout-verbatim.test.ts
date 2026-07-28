import { describe, expect, it } from 'vitest';
import { GNode, GPort } from '@eclipse-glsp/server';
import { RequestBoundsAction } from '@eclipse-glsp/protocol';
import type { ComputedBoundsAction } from '@eclipse-glsp/protocol';
import { WORKFLOW_LAYOUT_PERSISTENCE_KEY, WorkflowDiagramTypes, WorkflowDiagramMetadata } from '@dialogram/shared';
import { WorkflowComputedBoundsActionHandler } from '../src/server/diagram-action-handlers';

/**
 * End-to-end characterization of the "persisted layouts render verbatim" contract.
 *
 * When a saved layout with node positions exists, opening the diagram must reproduce the
 * persisted geometry EXACTLY and byte-stable across opens (the pre-2.7 behavior): no node
 * movement, no node-size change, no port re-anchor, no extra RequestBounds round-trip, and
 * exactly one model submit. The size-settling machinery (record client reports, converge,
 * COMMIT settled sizes, re-anchor ports to the committed width) is a FRESH-OPEN concern only.
 *
 * Running settle on a persisted open is what produced the user-visible regression: it commits
 * client-measured node sizes that differ from the deterministic server estimate by a few px and
 * re-anchors the ports to the new width — AFTER the load path already snapped each edge endpoint
 * to the (pre-reanchor) port anchor. Nothing re-snaps the endpoints, so the edge start detaches
 * from its source port (a small gap) and every node jiggles a few px on each open.
 *
 * These tests drive the real WorkflowComputedBoundsActionHandler with a mock client that echoes
 * the assigned size plus a small delta (exactly what a GLSP 2.7 client reports). On the buggy
 * code they are RED (node resized, port moved, an extra RequestBounds emitted); with the
 * persisted-verbatim short-circuit they are GREEN.
 */

type LayoutMeta = {
    workflowFilePath: string;
    networkId: string;
    hasPersistedLayout: boolean;
    hasPersistedEdgeRoutes: boolean;
    didInitialLayout: boolean;
    hasClientBounds: boolean;
    allowInitialLayoutPersistence: boolean;
    sizeMeasurePassCount?: number;
};

function persistedLayoutMeta(): LayoutMeta {
    return {
        workflowFilePath: '/tmp/net.py',
        networkId: 'Net',
        hasPersistedLayout: true,
        hasPersistedEdgeRoutes: true,
        didInitialLayout: false,
        hasClientBounds: false,
        allowInitialLayoutPersistence: true
    };
}

/**
 * Build a node that carries a persisted size and position plus a single output port anchored
 * to the node's right border — the exact shape that would drift if the settle/commit/reanchor
 * path ran on a persisted open.
 */
function makeHarness(layoutMeta: LayoutMeta) {
    const persistedNodeSize = { width: 100, height: 40 };
    const persistedNodePosition = { x: 300, y: 120 };
    // Output port sitting flush against the node's right border (x = node width).
    const persistedPortPosition = { x: 100, y: 16 };

    const port: any = GPort.builder().id('n1.out').type(WorkflowDiagramTypes.PORT_OUTPUT).build();
    port.size = { width: 8, height: 8 };
    port.position = { ...persistedPortPosition };
    port.args = { [WorkflowDiagramMetadata.PORT_DIRECTION]: 'output' };

    const node: any = GNode.builder().id('n1').type(WorkflowDiagramTypes.NODE_ACTOR).build();
    node.size = { ...persistedNodeSize };
    node.position = { ...persistedNodePosition };
    node.children = [port];
    port.parent = node;

    const root: any = { id: 'root', revision: 0, children: [node] };
    node.parent = root;

    const byId: Record<string, any> = { n1: node, 'n1.out': port };
    const index = { get: (id: string) => byId[id] };
    const store = new Map<string, unknown>();
    store.set(WORKFLOW_LAYOUT_PERSISTENCE_KEY, layoutMeta);

    const modelState = {
        root,
        index,
        get: (key: string) => store.get(key),
        set: (key: string, value: unknown) => store.set(key, value)
    };

    const submitCalls = { count: 0 };
    const submissionHandler = {
        submitModelDirectly: async () => {
            submitCalls.count++;
            return [{ kind: 'setModel' }];
        }
    };

    const handler = new WorkflowComputedBoundsActionHandler();
    (handler as any).modelState = modelState;
    (handler as any).submissionHandler = submissionHandler;
    (handler as any).serializer = { createSchema: () => ({ id: 'root', revision: 0 }) };

    const meta = () => store.get(WORKFLOW_LAYOUT_PERSISTENCE_KEY) as LayoutMeta;
    return { handler, node, port, meta, submitCalls, persistedNodeSize, persistedNodePosition, persistedPortPosition };
}

// A GLSP 2.7 client reports getBBox() = assigned model size + a constant overhang.
const echoBounds = (node: any, overhang = 18): ComputedBoundsAction =>
    ({
        kind: 'computedBounds',
        revision: 0,
        bounds: [{ elementId: 'n1', newSize: { width: node.size.width + overhang, height: node.size.height + overhang } }]
    } as any);

describe('Persisted layout renders verbatim (no settle on reopen)', () => {
    it('commits nothing: node size/position unchanged, ports not re-anchored, one submit, no RequestBounds', async () => {
        const { handler, node, port, meta, submitCalls, persistedNodeSize, persistedNodePosition, persistedPortPosition } =
            makeHarness(persistedLayoutMeta());

        // Feed two client reports (an echo of the assigned size + overhang). On the buggy code the
        // first would emit a RequestBounds re-request and the second would converge and COMMIT the
        // client size + re-anchor the port. On the fixed code the very first pass freezes verbatim.
        const first = await handler.execute(echoBounds(node));

        // No RequestBounds re-request: the persisted geometry is trusted, not re-measured.
        expect(first[0]?.kind).not.toBe(RequestBoundsAction.KIND);
        // Exactly one submit for the open.
        expect(submitCalls.count).toBe(1);
        // Sizes are frozen immediately.
        expect(meta().hasClientBounds).toBe(true);

        // Zero node movement, zero size change.
        expect(node.size).toEqual(persistedNodeSize);
        expect(node.position).toEqual(persistedNodePosition);
        // Ports NOT re-anchored — the edge endpoint snapped at load still touches the port.
        expect(port.position).toEqual(persistedPortPosition);

        // A second (still-fluctuating) report changes nothing further and adds no round-trip.
        const second = await handler.execute(echoBounds(node));
        expect(second[0]?.kind).not.toBe(RequestBoundsAction.KIND);
        expect(node.size).toEqual(persistedNodeSize);
        expect(port.position).toEqual(persistedPortPosition);
        expect(submitCalls.count).toBe(2); // one submit per computed-bounds, never a re-measure
    });
});
