import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { StatusAction } from '@eclipse-glsp/protocol';
import { GEdge, GGraph, GNode, GPort, ServerLayoutKind } from '@eclipse-glsp/server';
import { WORKFLOW_LAYOUT_PERSISTENCE_KEY, WorkflowDiagramTypes, type LoadingUpdate } from '@dialogram/shared';
import { WorkflowModelSubmissionHandler, WorkflowRequestModelActionHandler } from '../src/server/diagram-action-handlers';

/**
 * The two long steps of a first open are the reading and the first layout,
 * and the second is this handler's. It says so before it starts: ELK on a few
 * hundred nodes is seconds, and "Reading top.fir" would have stood over them.
 *
 * And where the host shows what a load is doing, GLSP's own "Model loading in
 * progress" is not started: a second, vaguer notice of the same wait.
 */

function submitHarness(layoutMeta: Record<string, unknown>) {
    const port = (id: string) => GPort.builder().id(id).type(WorkflowDiagramTypes.PORT_INPUT).build();
    const node = (id: string) => GNode.builder().id(id).type(WorkflowDiagramTypes.NODE_ACTOR).addChildren(port(`${id}.p`)).build();
    const edge = GEdge.builder().id('e1').sourceId('a.p').targetId('b.p').build();
    const root = GGraph.builder().id('root').addChildren(node('a'), node('b'), node('c'), edge).build();

    const store = new Map<string, unknown>([[WORKFLOW_LAYOUT_PERSISTENCE_KEY, { workflowFilePath: '/w/top.fir', networkId: 'Top', ...layoutMeta }]]);
    const order: string[] = [];
    const told: Array<{ clientId: string; update: LoadingUpdate }> = [];

    const handler = new WorkflowModelSubmissionHandler() as any;
    handler.layoutEngine = { layout: async () => { order.push('layout'); } };
    handler.diagramConfiguration = { layoutKind: ServerLayoutKind.MANUAL, needsClientLayout: true, animatedUpdate: false };
    handler.modelState = {
        root,
        index: { get: () => undefined, find: () => undefined },
        get: (key: string) => store.get(key),
        set: (key: string, value: unknown) => store.set(key, value)
    };
    handler.serializer = { createSchema: () => ({}) };
    handler.commandStack = { isDirty: false };
    handler.requestModelAction = { requestId: 'r1' };
    handler.layoutPersistence = { loadLayout: async () => new Map(), saveLayoutImmediate: async () => {} };
    handler.rerouteHandler = { runReroute: async () => { order.push('reroute'); } };
    // The layout itself is every other suite's; here it is the step that is announced.
    handler.runBoundaryFlowAndPersist = async () => { order.push('layout'); };
    handler.clientId = 'client-7';
    handler.loadProgressSink = (clientId: string, update: LoadingUpdate) => {
        order.push('told');
        told.push({ clientId, update });
    };
    return { handler, order, told };
}

describe('the first layout of a diagram', () => {
    const firstOpen = {
        hasPersistedLayout: false,
        hasPersistedEdgeRoutes: false,
        didInitialLayout: false,
        hasClientBounds: true,
        allowInitialLayoutPersistence: true
    };

    it('is said before it runs, with how much there is to lay out', async () => {
        const { handler, order, told } = submitHarness(firstOpen);

        await handler.submitModelDirectly();

        expect(order.slice(0, 2)).toEqual(['told', 'layout']);
        expect(told).toEqual([
            { clientId: 'client-7', update: { state: 'progress', message: 'Laying out the diagram', detail: '3 nodes, 1 edge' } }
        ]);
    });

    it('is not said again for a diagram that has its layout', async () => {
        const { handler, order, told } = submitHarness({ ...firstOpen, hasPersistedLayout: true, hasPersistedEdgeRoutes: true });

        await handler.submitModelDirectly();

        expect(told).toEqual([]);
        expect(order).not.toContain('layout');
    });

    it('says the routing of a saved layout that has no routes yet', async () => {
        const { handler, order, told } = submitHarness({ ...firstOpen, hasPersistedLayout: true, hasPersistedEdgeRoutes: false });

        await handler.submitModelDirectly();

        expect(order.slice(0, 2)).toEqual(['told', 'reroute']);
        expect(told[0].update).toEqual({ state: 'progress', message: 'Routing the connections', detail: '3 nodes, 1 edge' });
    });

    it('lays out all the same on a host that shows no progress', async () => {
        const { handler, order } = submitHarness(firstOpen);
        handler.loadProgressSink = undefined;

        await handler.submitModelDirectly();

        expect(order).toEqual(['layout']);
    });
});

describe('GLSP’s own notice of a load', () => {
    function requestHarness(withSink: boolean) {
        const statuses: StatusAction[] = [];
        const handler = new WorkflowRequestModelActionHandler() as any;
        handler.logger = { debug: () => {} };
        handler.modelState = { setAll: () => {}, root: { revision: 0 } };
        handler.sourceModelStorage = { loadSourceModel: async () => {} };
        handler.actionDispatcher = {
            dispatch: (action: any) => {
                if (action?.kind === StatusAction.KIND) {
                    statuses.push(action as StatusAction);
                }
                return Promise.resolve();
            }
        };
        handler.progressService = { start: () => ({ end: () => undefined }) };
        handler.submissionHandler = { submitInitialModel: async () => [] };
        if (withSink) {
            handler.loadProgressSink = () => undefined;
        }
        return { handler, statuses };
    }

    it('is not started where the diagram says what the load is doing', async () => {
        const { handler, statuses } = requestHarness(true);

        await handler.execute({ kind: 'requestModel', requestId: 'open-1' } as any);

        expect(statuses.filter(status => status.severity === 'INFO')).toEqual([]);
    });

    it('is started as before where it does not', async () => {
        const { handler, statuses } = requestHarness(false);

        await handler.execute({ kind: 'requestModel', requestId: 'open-1' } as any);

        expect(statuses[0]?.severity).toBe('INFO');
        expect(statuses.at(-1)?.severity).toBe('NONE');
    });
});
