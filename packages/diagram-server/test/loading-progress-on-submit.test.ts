import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { StatusAction } from '@eclipse-glsp/protocol';
import { GEdge, GGraph, GNode, GPort, ServerLayoutKind } from '@eclipse-glsp/server';
import { WORKFLOW_LAYOUT_PERSISTENCE_KEY, WorkflowDiagramTypes, type LoadingUpdate } from '@dialogram/shared';
import {
    WorkflowComputedBoundsActionHandler,
    WorkflowModelSubmissionHandler,
    WorkflowRequestModelActionHandler
} from '../src/server/diagram-action-handlers';
import { LoadProgressReporter } from '../src/server/load-progress';

/**
 * Where a wait ends, and what is said of the layout on the way.
 *
 * The two long steps of a first open are the reading and the first layout,
 * and the second is the submission handler's. It says so before it starts:
 * ELK on a few hundred nodes is seconds, and "Reading top.fir" would have
 * stood over them.
 *
 * And the submission handler is where the model the reader is waiting for
 * leaves, so it is where the wait is said to be over. Not by a request nobody
 * is waiting on, whose model can leave in the middle of the reader's wait;
 * and by every failure on the way, since then no model will.
 */

/** A session's reporter, saying what it says to a list and to `order`. */
function reporterTo(told: LoadingUpdate[], order: string[] = []): LoadProgressReporter {
    const reporter = new LoadProgressReporter() as any;
    reporter.sink = (_client: string, update: LoadingUpdate) => {
        told.push(update);
        order.push(update.state === 'progress' ? 'said' : update.model ? 'over, model on its way' : 'over');
    };
    reporter.clientId = 'client-7';
    return reporter as LoadProgressReporter;
}

function submitHarness(layoutMeta: Record<string, unknown>) {
    const port = (id: string) => GPort.builder().id(id).type(WorkflowDiagramTypes.PORT_INPUT).build();
    const node = (id: string) => GNode.builder().id(id).type(WorkflowDiagramTypes.NODE_ACTOR).addChildren(port(`${id}.p`)).build();
    const edge = GEdge.builder().id('e1').sourceId('a.p').targetId('b.p').build();
    const root = GGraph.builder().id('root').addChildren(node('a'), node('b'), node('c'), edge).build();

    const store = new Map<string, unknown>([[WORKFLOW_LAYOUT_PERSISTENCE_KEY, { workflowFilePath: '/w/top.fir', networkId: 'Top', ...layoutMeta }]]);
    const order: string[] = [];
    const told: LoadingUpdate[] = [];

    const handler = new WorkflowModelSubmissionHandler() as any;
    handler.layoutEngine = { layout: async () => { order.push('layout'); } };
    handler.diagramConfiguration = { layoutKind: ServerLayoutKind.MANUAL, needsClientLayout: true, animatedUpdate: false };
    handler.modelState = {
        root,
        index: { get: () => undefined, find: () => undefined },
        get: (key: string) => store.get(key),
        set: (key: string, value: unknown) => store.set(key, value)
    };
    handler.serializer = { createSchema: () => { order.push('model made'); return {}; } };
    handler.commandStack = { isDirty: false };
    handler.requestModelAction = { requestId: 'r1' };
    handler.layoutPersistence = { loadLayout: async () => new Map(), saveLayoutImmediate: async () => {} };
    handler.rerouteHandler = { runReroute: async () => { order.push('reroute'); } };
    // The layout itself is every other suite's; here it is the step that is announced.
    handler.runBoundaryFlowAndPersist = async () => { order.push('layout'); };
    handler.loadProgress = reporterTo(told, order);
    return { handler, order, told };
}

const firstOpen = {
    hasPersistedLayout: false,
    hasPersistedEdgeRoutes: false,
    didInitialLayout: false,
    hasClientBounds: true,
    allowInitialLayoutPersistence: true
};
const laidOut = { ...firstOpen, hasPersistedLayout: true, hasPersistedEdgeRoutes: true };

describe('the first layout of a diagram', () => {
    it('is said before it runs, with how much there is to lay out', async () => {
        const { handler, order, told } = submitHarness(firstOpen);

        await handler.submitModelDirectly();

        expect(order.slice(0, 2)).toEqual(['said', 'layout']);
        expect(told[0]).toEqual({ state: 'progress', message: 'Laying out the diagram', detail: '3 nodes, 1 edge' });
    });

    it('is not said again for a diagram that has its layout', async () => {
        const { handler, order, told } = submitHarness(laidOut);

        await handler.submitModelDirectly();

        expect(told).toEqual([]);
        expect(order).not.toContain('layout');
    });

    it('says the routing of a saved layout that has no routes yet', async () => {
        const { handler, order, told } = submitHarness({ ...firstOpen, hasPersistedLayout: true, hasPersistedEdgeRoutes: false });

        await handler.submitModelDirectly();

        expect(order.slice(0, 2)).toEqual(['said', 'reroute']);
        expect(told[0]).toEqual({ state: 'progress', message: 'Routing the connections', detail: '3 nodes, 1 edge' });
    });

    it('lays out all the same on a host that shows no progress', async () => {
        const { handler, order } = submitHarness(firstOpen);
        handler.loadProgress = undefined;

        await handler.submitModelDirectly();

        expect(order).toEqual(['layout', 'model made']);
    });
});

describe('the end of a wait', () => {
    it('is said when the model is made, before it is sent', async () => {
        // Before, so that the diagram keeps its indicator until the picture
        // is there, and takes it down at that model and at no other.
        const { handler, order, told } = submitHarness(firstOpen);

        await handler.submitModelDirectly();

        expect(order).toEqual(['said', 'layout', 'model made', 'over, model on its way']);
        expect(told.at(-1)).toEqual({ state: 'done', model: true });
    });

    it('is said for a wait the load began, whose submit says nothing itself', async () => {
        const { handler, told } = submitHarness(laidOut);
        (handler.loadProgress as LoadProgressReporter).say({ message: 'Reading top.fir' });

        await handler.submitModelDirectly();

        expect(told).toEqual([{ state: 'progress', message: 'Reading top.fir' }, { state: 'done', model: true }]);
    });

    it('is not said for a submit nobody waited for', async () => {
        // One follows every edit. An end said for each is a message per keystroke.
        const { handler, told } = submitHarness(laidOut);

        await handler.submitModelDirectly();

        expect(told).toEqual([]);
    });

    it('is said with no model when the submit fails', async () => {
        const { handler, told } = submitHarness(firstOpen);
        const failure = new Error('the model could not be serialised');
        handler.serializer = { createSchema: () => { throw failure; } };

        await expect(handler.submitModelDirectly()).rejects.toBe(failure);

        expect(told.at(-1)).toEqual({ state: 'done' });
    });
});

function requestHarness(reporter: LoadProgressReporter | undefined, loadSourceModel: () => Promise<void> = async () => {}) {
    const statuses: StatusAction[] = [];
    const handler = new WorkflowRequestModelActionHandler() as any;
    handler.logger = { debug: () => {} };
    handler.modelState = { setAll: () => {}, root: { revision: 0 } };
    handler.sourceModelStorage = { loadSourceModel };
    handler.actionDispatcher = {
        dispatch: (action: any) => {
            if (action?.kind === StatusAction.KIND) {
                statuses.push(action as StatusAction);
            }
            return Promise.resolve();
        }
    };
    handler.progressService = { start: () => ({ end: () => undefined }) };
    handler.submissionHandler = {
        submitInitialModel: async () => [],
        // As the real one: the end of whatever was being waited for.
        submitModelDirectly: async () => {
            reporter?.endWithModel();
            return [];
        }
    };
    handler.loadProgress = reporter;
    return { handler, statuses };
}

describe('a request for the model', () => {
    it('does not start GLSP’s own notice where the diagram says what the load is doing', async () => {
        const { handler, statuses } = requestHarness(reporterTo([]));

        await handler.execute({ kind: 'requestModel', requestId: 'open-1' } as any);

        expect(statuses.filter(status => status.severity === 'INFO')).toEqual([]);
    });

    it('starts it as before where it does not', async () => {
        const { handler, statuses } = requestHarness(undefined);

        await handler.execute({ kind: 'requestModel', requestId: 'open-1' } as any);

        expect(statuses[0]?.severity).toBe('INFO');
        expect(statuses.at(-1)?.severity).toBe('NONE');
    });

    it('says the wait is over when the load fails, anywhere on the way', async () => {
        const told: LoadingUpdate[] = [];
        const reporter = reporterTo(told);
        const failure = new Error('the session has no model state');
        const { handler } = requestHarness(reporter, async () => {
            reporter.say({ message: 'Reading top.fir' });
            throw failure;
        });

        await expect(handler.execute({ kind: 'requestModel', requestId: 'open-1' } as any)).rejects.toBe(failure);

        expect(told).toEqual([{ state: 'progress', message: 'Reading top.fir' }, { state: 'done' }]);
    });

    it('made behind the reader’s back says nothing, and its model does not end their wait', async () => {
        // The first open of a workflow other workflows call: the host asks
        // again, for the callers it has found by then, while the layout the
        // reader is waiting for is still to run. That request submits a model
        // of its own at once.
        const told: LoadingUpdate[] = [];
        const reporter = reporterTo(told);
        reporter.say({ message: 'Reading top.fir' });
        let tellingWhileLoading: boolean | undefined;
        const { handler } = requestHarness(reporter, async () => {
            tellingWhileLoading = reporter.telling;
        });

        await handler.execute({
            kind: 'requestModel',
            requestId: 'refresh-caller-refs-1',
            options: { agentContextOnly: true }
        } as any);

        expect(tellingWhileLoading).toBe(false);
        expect(told).toEqual([{ state: 'progress', message: 'Reading top.fir' }]);
        // The reader's own load ends it, when its model leaves.
        reporter.endWithModel();
        expect(told.at(-1)).toEqual({ state: 'done', model: true });
    });
});

describe('the sizes the diagram measured', () => {
    it('say the wait is over when applying them fails', async () => {
        // The submit that follows them is what ends a wait. A throw before
        // it left the diagram counting the seconds of a load that was over.
        const told: LoadingUpdate[] = [];
        const reporter = reporterTo(told);
        reporter.say({ message: 'Drawing the diagram' });
        const failure = new Error('Invalid Route!');
        const handler = new WorkflowComputedBoundsActionHandler() as any;
        handler.modelState = { get root(): never { throw failure; } };
        handler.loadProgress = reporter;

        await expect(handler.execute({ kind: 'computedBounds', bounds: [] } as any)).rejects.toBe(failure);

        expect(told.at(-1)).toEqual({ state: 'done' });
    });
});
