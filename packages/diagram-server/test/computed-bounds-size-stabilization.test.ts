import { describe, expect, it } from 'vitest';
import { GNode } from '@eclipse-glsp/server';
import { RequestBoundsAction } from '@eclipse-glsp/protocol';
import type { ComputedBoundsAction } from '@eclipse-glsp/protocol';
import { WORKFLOW_LAYOUT_PERSISTENCE_KEY, WorkflowDiagramTypes } from '@dialogram/shared';
import {
    WorkflowComputedBoundsActionHandler,
    MAX_SIZE_MEASURE_PASSES
} from '../src/server/diagram-action-handlers';

/**
 * Node sizes are server-authoritative: the client's measurement is never written into the
 * model, on any path.
 *
 * A GLSP 2.7 client renders a node's <rect> at its assigned size and reports getBBox() =
 * that size + the port and type-footer overhang. Applying such a report inflates the node
 * past the deterministic server estimate (the footer alone is routinely wider than the node),
 * and applying it repeatedly grows the node without bound. Worse, only FRESH opens ever did
 * so — a persisted reopen renders the server estimate verbatim — so the two paths disagreed
 * and a layout saved from a fresh open recorded port anchors no reopen could reproduce.
 *
 * The settle loop below is retained purely as the font-load gate: it re-requests bounds until
 * two consecutive CLIENT reports agree (or a hard cap is hit), which is when web fonts have
 * loaded and the port-label sizes recorded by applyBounds are trustworthy — ELK places labels
 * from those. Only then does `hasClientBounds` flip, releasing the initial ELK layout. The >0
 * guard preserves the zero-size protection: a partial/zero measurement never counts as stable.
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

function freshLayoutMeta(): LayoutMeta {
    return {
        workflowFilePath: '/tmp/net.py',
        networkId: 'Net',
        hasPersistedLayout: false,
        hasPersistedEdgeRoutes: false,
        didInitialLayout: false,
        hasClientBounds: false,
        allowInitialLayoutPersistence: true
    };
}

function makeHarness(initialSize: { width: number; height: number }, layoutMeta: LayoutMeta) {
    const node: any = GNode.builder().id('n1').type(WorkflowDiagramTypes.NODE_ACTOR).build();
    node.size = { ...initialSize };

    const root: any = { id: 'root', revision: 0, children: [node] };
    const index = { get: (id: string) => (id === 'n1' ? node : undefined) };
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
    return { handler, node, meta, submitCalls };
}

const bounds = (width: number, height: number): ComputedBoundsAction =>
    ({ kind: 'computedBounds', revision: 0, bounds: [{ elementId: 'n1', newSize: { width, height } }] } as any);

describe('ComputedBounds node-size stabilization (GLSP 2.7)', () => {
    it('re-measures until two consecutive equal CLIENT reports, then freezes without resizing', async () => {
        const { handler, node, meta, submitCalls } = makeHarness({ width: 100, height: 40 }, freshLayoutMeta());

        // Pass 1: client measures larger (rect + port/footer overhang). The report is RECORDED
        // but never baked into the model — the node stays at its server estimate.
        const r1 = await handler.execute(bounds(130, 50));
        expect(node.size).toEqual({ width: 100, height: 40 });
        expect(meta().hasClientBounds).toBe(false);
        expect(r1[0].kind).toBe(RequestBoundsAction.KIND); // re-measure, no layout yet
        expect(submitCalls.count).toBe(0);

        // Pass 2: fonts finished loading -> different report. Still differs from pass 1, so
        // re-measure again.
        const r2 = await handler.execute(bounds(118, 50));
        expect(node.size).toEqual({ width: 100, height: 40 });
        expect(meta().hasClientBounds).toBe(false);
        expect(r2[0].kind).toBe(RequestBoundsAction.KIND);
        expect(submitCalls.count).toBe(0);

        // Pass 3: identical to pass 2 -> fonts have settled -> release the layout and submit.
        // The node is STILL at the server estimate; the reports only timed the gate.
        await handler.execute(bounds(118, 50));
        expect(node.size).toEqual({ width: 100, height: 40 });
        expect(meta().hasClientBounds).toBe(true);
        expect(submitCalls.count).toBe(1);

        // Pass 4: after freeze a fluctuating (e.g. hover-stroke) measurement changes nothing.
        await handler.execute(bounds(400, 200));
        expect(node.size).toEqual({ width: 100, height: 40 });
    });

    it('keeps a fresh open at the same node size a persisted reopen would render', async () => {
        // The two paths must agree: this is what makes a layout saved from a fresh open
        // reproducible on reopen (port anchors derive from node.size).
        const fresh = makeHarness({ width: 100, height: 40 }, freshLayoutMeta());
        let guard = 0;
        while (!fresh.meta().hasClientBounds && guard++ < 10) {
            // Client reports getBBox() = assigned size + overhang (ports + type footer).
            await fresh.handler.execute(bounds(fresh.node.size.width + 47, fresh.node.size.height + 18));
        }

        const persisted = makeHarness(
            { width: 100, height: 40 },
            { ...freshLayoutMeta(), hasPersistedLayout: true }
        );
        await persisted.handler.execute(bounds(147, 58));

        expect(fresh.meta().hasClientBounds).toBe(true);
        expect(persisted.meta().hasClientBounds).toBe(true);
        expect(fresh.node.size).toEqual(persisted.node.size);
        expect(fresh.node.size).toEqual({ width: 100, height: 40 });
        // The overhang echo is constant against a fixed baseline, so it converges immediately.
        expect(guard).toBeLessThan(MAX_SIZE_MEASURE_PASSES);
    });

    it('freezes after the hard pass cap even if measurements never converge', async () => {
        const { handler, meta } = makeHarness({ width: 100, height: 40 }, freshLayoutMeta());

        let w = 100;
        for (let i = 1; i < MAX_SIZE_MEASURE_PASSES; i++) {
            w += 20; // always changing -> never "stable"
            const r = await handler.execute(bounds(w, 40));
            expect(meta().hasClientBounds).toBe(false);
            expect(r[0].kind).toBe(RequestBoundsAction.KIND);
        }

        // The cap-th changing pass forces a freeze so the diagram always lays out.
        w += 20;
        await handler.execute(bounds(w, 40));
        expect(meta().hasClientBounds).toBe(true);
    });

    it('never freezes on a zero/partial measurement (zero-size protection) and re-requests', async () => {
        const { handler, node, meta } = makeHarness({ width: 100, height: 40 }, freshLayoutMeta());

        const r = await handler.execute(bounds(0, 0));
        expect(node.size).toEqual({ width: 100, height: 40 });
        expect(meta().hasClientBounds).toBe(false); // a zero pass is not "stable"
        expect(r[0].kind).toBe(RequestBoundsAction.KIND);
    });
});
