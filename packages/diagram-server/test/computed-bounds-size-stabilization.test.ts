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
 * Regression coverage for the GLSP 2.7 node-size measurement race (item A).
 *
 * The old policy flipped `hasClientBounds` on the FIRST ComputedBoundsAction and
 * never shrank node sizes afterwards. Under GLSP 2.7 the first ComputedBounds can
 * arrive before web-font text measurement completes, so a slightly-wrong size was
 * frozen for the whole session and every later (correct) measurement was rejected
 * by the never-shrink freeze — nodes rendered a few px off on every open.
 *
 * New policy: keep accepting client-measured node sizes (grow AND shrink) and
 * re-request bounds until two consecutive passes report identical, valid sizes
 * (or a hard pass cap is hit). Then freeze. The >0 guard preserves the documented
 * zero-size protection: a partial/zero measurement never freezes the geometry.
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
    it('accepts grow then shrink until two consecutive equal measurements, then freezes', async () => {
        const { handler, node, meta, submitCalls } = makeHarness({ width: 100, height: 40 }, freshLayoutMeta());

        // Pass 1: client measures larger (server estimate was conservative) -> accept grow.
        const r1 = await handler.execute(bounds(130, 50));
        expect(node.size).toEqual({ width: 130, height: 50 });
        expect(meta().hasClientBounds).toBe(false);
        expect(r1[0].kind).toBe(RequestBoundsAction.KIND); // re-measure, no layout yet
        expect(submitCalls.count).toBe(0);

        // Pass 2: fonts finished loading -> correct (smaller) measurement, shrink accepted.
        const r2 = await handler.execute(bounds(118, 50));
        expect(node.size).toEqual({ width: 118, height: 50 });
        expect(meta().hasClientBounds).toBe(false);
        expect(r2[0].kind).toBe(RequestBoundsAction.KIND);
        expect(submitCalls.count).toBe(0);

        // Pass 3: identical measurement -> stabilized -> freeze + submit.
        await handler.execute(bounds(118, 50));
        expect(meta().hasClientBounds).toBe(true);
        expect(submitCalls.count).toBe(1);

        // Pass 4: after freeze a fluctuating (e.g. hover-stroke) measurement is rejected.
        await handler.execute(bounds(400, 200));
        expect(node.size).toEqual({ width: 118, height: 50 });
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
        expect(node.size).toEqual({ width: 100, height: 40 }); // never applied
        expect(meta().hasClientBounds).toBe(false); // a zero pass is not "stable"
        expect(r[0].kind).toBe(RequestBoundsAction.KIND);
    });
});
