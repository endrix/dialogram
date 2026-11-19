import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { RequestModelAction, SelectAction, StatusAction } from '@eclipse-glsp/protocol';
import { NodeActionDispatchScope } from '@eclipse-glsp/server/node';
import type { DiagramModelSource, GraphDocument, LoadingUpdate, ModelSourceOptions } from '@dialogram/shared';
import { EDITOR_CLOSED, LoadAbandoned, LoadCancellation, NEWER_REQUEST } from '../src/server/load-cancellation';
import { LoadCancellingActionDispatcher } from '../src/server/load-cancelling-dispatcher';
import { LoadProgressReporter } from '../src/server/load-progress';
import { WorkflowSourceModelStorage } from '../src/server/source-model-storage';
import { WorkflowRequestModelActionHandler } from '../src/server/diagram-action-handlers';

/**
 * A load whose reader has gone.
 *
 * A product's `getGraph` can take seconds (a compiler, a worker, a server).
 * When the diagram's editor closes, or the reader asks for another graph
 * before this one has come, the product is told through the signal it was
 * handed, and nothing of the abandoned load is drawn: not over the newer
 * load's graph, and not into an editor that has gone.
 */

const SOURCE = 'file:///w/Top.dsl';

const graph = (nodes: number): GraphDocument =>
    ({
        version: '1.0',
        graph: { id: 'g', nodes: Array.from({ length: nodes }, (_, i) => ({ id: `n${i}` })), edges: [] }
    }) as unknown as GraphDocument;

function reporterTo(told: LoadingUpdate[]): LoadProgressReporter {
    const reporter = new LoadProgressReporter() as any;
    reporter.sink = (_client: string, update: LoadingUpdate) => told.push(update);
    reporter.clientId = 'client-3';
    return reporter as LoadProgressReporter;
}

/**
 * A session: its storage, its cancellation, its dispatcher, as the diagram
 * module binds them. It shows a graph already unless `firstLoad`: a
 * diagram's first load is not replaced by a newer request.
 */
function session(getGraph: DiagramModelSource['getGraph'], { firstLoad = false }: { firstLoad?: boolean } = {}) {
    const told: LoadingUpdate[] = [];
    const cancellation = new LoadCancellation();
    const storage = new WorkflowSourceModelStorage() as any;
    storage.injectedModelSource = { getGraph } satisfies DiagramModelSource;
    storage.loadProgress = reporterTo(told);
    storage.loadCancellation = cancellation;
    storage.publishGraphDiagnostics = async () => undefined;
    storage.modelState = { root: firstLoad ? undefined : { id: 'shown' } };
    let built = 0;
    storage.finishLoadFromDoc = async () => { built += 1; };
    const load = (requestId: string) =>
        storage.loadSourceModel({ kind: 'requestModel', requestId, options: { sourceUri: SOURCE } }) as Promise<void>;

    // The dispatcher's queue is GLSP's and is not started here: what is
    // pinned is what it does as a request ARRIVES, before the queue.
    const dispatcher = new LoadCancellingActionDispatcher() as any;
    dispatcher.loadCancellation = cancellation;
    let reentrant = false;
    dispatcher.dispatchScope = { enter: <R>(callback: () => R) => callback(), isReentrant: () => reentrant };
    dispatcher.logger = { debug: () => undefined, error: () => undefined, warn: () => undefined };
    const dispatch = (action: unknown) => { void (dispatcher.dispatch(action) as Promise<void>).catch(() => undefined); };
    return {
        told,
        cancellation,
        load,
        built: () => built,
        dispatch,
        closeEditor: () => dispatcher.dispose(),
        inside: (callback: () => void) => { reentrant = true; try { callback(); } finally { reentrant = false; } }
    };
}

/** A `getGraph` that waits to be let go, and keeps the signal it was handed. */
function slowSource() {
    let release!: (doc: GraphDocument | undefined) => void;
    let handed: ModelSourceOptions | undefined;
    let started!: () => void;
    const running = new Promise<void>(resolve => { started = resolve; });
    const getGraph: DiagramModelSource['getGraph'] = (_uri, options) => {
        handed = options;
        started();
        return new Promise<GraphDocument | undefined>(resolve => { release = resolve; });
    };
    return { getGraph, running, release: (doc: GraphDocument | undefined) => release(doc), handed: () => handed };
}

describe('the signal a product is handed', () => {
    it('is handed to every load, unaborted', async () => {
        const source = slowSource();
        const s = session(source.getGraph);

        const loading = s.load('open-1');
        await source.running;

        expect(source.handed()?.signal).toBeInstanceOf(AbortSignal);
        expect(source.handed()?.signal?.aborted).toBe(false);
        source.release(graph(3));
        await loading;
        expect(s.built()).toBe(1);
    });

    it('is aborted when the editor closes, and nothing is drawn', async () => {
        const source = slowSource();
        const s = session(source.getGraph);

        const loading = s.load('open-1');
        await source.running;
        s.closeEditor();

        const signal = source.handed()!.signal!;
        expect(signal.aborted).toBe(true);
        expect((signal.reason as Error).name).toBe('AbortError');
        expect((signal.reason as Error).message).toBe(EDITOR_CLOSED);

        // The product may answer anyway; it is drawn for nobody.
        source.release(graph(3));
        await expect(loading).rejects.toBeInstanceOf(LoadAbandoned);
        expect(s.built()).toBe(0);
        // Nor is the wait said to be over: there is no diagram to say it to.
        expect(s.told.some(update => update.state === 'done')).toBe(false);
    });

    it('is aborted when a newer request for the model arrives, while this one still loads', async () => {
        const source = slowSource();
        const s = session(source.getGraph);

        const loading = s.load('open-1');
        await source.running;
        // A save: the host asks again. GLSP would queue it behind this load.
        s.dispatch(RequestModelAction.create({ options: { sourceUri: SOURCE }, requestId: 'refresh-17' }));

        const signal = source.handed()!.signal!;
        expect(signal.aborted).toBe(true);
        expect((signal.reason as Error).message).toBe(NEWER_REQUEST);
        source.release(graph(3));
        await expect(loading).rejects.toBeInstanceOf(LoadAbandoned);
        expect(s.built()).toBe(0);
        // The newer load speaks for the indicator now: this one does not end it.
        expect(s.told.some(update => update.state === 'done')).toBe(false);
    });

    it('turns a producer that stops by throwing into an abandoned load, not a failure', async () => {
        const s = session(async (_uri, options) => {
            await new Promise<void>((_resolve, reject) => {
                options.signal?.addEventListener('abort', () => reject(options.signal!.reason), { once: true });
                setTimeout(() => s.closeEditor(), 0);
            });
            return graph(1);
        });

        await expect(s.load('open-1')).rejects.toBeInstanceOf(LoadAbandoned);
        expect(s.told.some(update => update.state === 'done')).toBe(false);
    });

    it('is not aborted by a request nobody is waiting on, nor by any other action', async () => {
        const source = slowSource();
        const s = session(source.getGraph);

        const loading = s.load('open-1');
        await source.running;
        s.dispatch(RequestModelAction.create({ options: { sourceUri: SOURCE }, requestId: 'refresh-live-overlay-4' }));
        s.dispatch(RequestModelAction.create({ options: { sourceUri: SOURCE, agentContextOnly: true }, requestId: 'refresh-9' }));
        s.dispatch(SelectAction.create({ selectedElementsIDs: ['n0'] }));
        s.dispatch(StatusAction.create('', { severity: 'NONE' }));

        expect(source.handed()!.signal!.aborted).toBe(false);
        source.release(graph(3));
        await loading;
        expect(s.built()).toBe(1);
    });

    it('is not aborted by a request made from inside the session (it runs within the load)', async () => {
        const source = slowSource();
        const s = session(source.getGraph);

        const loading = s.load('open-1');
        await source.running;
        s.inside(() => s.dispatch(RequestModelAction.create({ options: { sourceUri: SOURCE }, requestId: 'inner-1' })));

        expect(source.handed()!.signal!.aborted).toBe(false);
        source.release(graph(1));
        await loading;
    });

    it('leaves a background load running when the reader asks again, and stops it when the editor closes', async () => {
        const source = slowSource();
        const s = session(source.getGraph);

        const loading = s.load('refresh-live-overlay-1');
        await source.running;
        s.dispatch(RequestModelAction.create({ options: { sourceUri: SOURCE }, requestId: 'refresh-2' }));
        expect(source.handed()!.signal!.aborted).toBe(false);

        s.closeEditor();
        expect(source.handed()!.signal!.aborted).toBe(true);
        source.release(graph(1));
        await expect(loading).rejects.toBeInstanceOf(LoadAbandoned);
    });

    it('does not ask the product at all for a load that starts after the editor closed', async () => {
        let asked = 0;
        const s = session(async () => { asked += 1; return graph(1); });
        s.closeEditor();

        await expect(s.load('open-1')).rejects.toBeInstanceOf(LoadAbandoned);
        expect(asked).toBe(0);
        expect(s.told).toEqual([]);
    });

    it('forgets a load once it is over, so a later request aborts nothing it should not', async () => {
        const handed: AbortSignal[] = [];
        const s = session(async (_uri, options) => { handed.push(options.signal!); return graph(1); });

        await s.load('open-1');
        s.dispatch(RequestModelAction.create({ options: { sourceUri: SOURCE }, requestId: 'refresh-1' }));

        expect(handed[0].aborted).toBe(false);
    });
});

describe('the request whose load was abandoned', () => {
    it('ends with nothing sent and nothing said, and without an error', async () => {
        const told: LoadingUpdate[] = [];
        const handler = new WorkflowRequestModelActionHandler() as any;
        handler.logger = { debug: () => undefined };
        handler.modelState = { setAll: () => undefined, root: { revision: 0 } };
        handler.sourceModelStorage = { loadSourceModel: async () => { throw new LoadAbandoned(NEWER_REQUEST); } };
        handler.actionDispatcher = { dispatch: () => Promise.resolve() };
        handler.progressService = { start: () => ({ end: () => undefined }) };
        const submitInitialModel = vi.fn(async () => []);
        handler.submissionHandler = { submitInitialModel };
        handler.loadProgress = reporterTo(told);
        handler.loadProgress.say({ message: 'Reading Top.dsl' });
        const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        try {
            await expect(handler.execute(RequestModelAction.create({ options: { sourceUri: SOURCE }, requestId: 'open-1' }))).resolves.toEqual([]);
        } finally {
            log.mockRestore();
        }

        expect(submitInitialModel).not.toHaveBeenCalled();
        expect(told.some(update => update.state === 'done')).toBe(false);
    });
});

/**
 * A session's requests through GLSP's own queue, as a client and the host
 * send them: the cancelling dispatcher, its queue and dispatch scope, the
 * platform's request handler, and the storage. The submit is a stand-in that
 * records the model it would send, and fails where the session has none, as
 * GLSP's does (`modelState.root.revision`).
 */
function queuedSession(getGraph: DiagramModelSource['getGraph']) {
    const cancellation = new LoadCancellation();
    const modelState: { root?: { id: string; revision?: number }; setAll(): void } = { setAll: () => undefined };
    const storage = new WorkflowSourceModelStorage() as any;
    storage.injectedModelSource = { getGraph } satisfies DiagramModelSource;
    storage.loadCancellation = cancellation;
    storage.modelState = modelState;
    storage.publishGraphDiagnostics = async () => undefined;
    const built: string[] = [];
    let drawing: Promise<void> = Promise.resolve();
    storage.finishLoadFromDoc = async (doc: GraphDocument) => {
        await drawing;
        built.push(doc.graph.id);
        modelState.root = { id: doc.graph.id };
    };

    const shown: string[] = [];
    const failed: string[] = [];
    const handler = new WorkflowRequestModelActionHandler() as any;
    handler.logger = { debug: () => undefined };
    handler.modelState = modelState;
    handler.sourceModelStorage = storage;
    handler.actionDispatcher = { dispatch: () => Promise.resolve() };
    handler.progressService = { start: () => ({ end: () => undefined }) };
    handler.submissionHandler = {
        submitInitialModel: async () => {
            shown.push(modelState.root!.id);
            return [];
        }
    };

    const dispatcher = new LoadCancellingActionDispatcher() as any;
    dispatcher.loadCancellation = cancellation;
    dispatcher.dispatchScope = new NodeActionDispatchScope();
    dispatcher.logger = { debug: () => undefined, error: () => undefined, warn: () => undefined, info: () => undefined };
    dispatcher.clientActionForwarder = { handle: () => false };
    dispatcher.actionHandlerRegistry = { get: (kind: string) => (kind === RequestModelAction.KIND ? [handler] : []) };
    dispatcher.initialize();

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    /** A request for the model, as one arrives; settles once the queue has handled it. */
    const request = (requestId: string): Promise<void> =>
        (dispatcher.dispatch(RequestModelAction.create({ options: { sourceUri: SOURCE }, requestId })) as Promise<void>)
            .catch(error => { failed.push(`${requestId}: ${(error as Error).message}`); });
    return {
        request,
        built,
        shown,
        failed,
        modelState,
        /** Hold every draw (the layout, the submit) until `release` is called. */
        holdDrawing: () => {
            let release!: () => void;
            drawing = new Promise<void>(resolve => { release = resolve; });
            return () => release();
        },
        closeEditor: () => dispatcher.dispose(),
        done: () => log.mockRestore()
    };
}

/** A product whose every load waits to be let go; each load's signal and request are kept. */
function heldSource() {
    const calls: Array<{ signal?: AbortSignal; answer(doc: GraphDocument | undefined): void; fail(error: Error): void }> = [];
    let started: (() => void) | undefined;
    const getGraph: DiagramModelSource['getGraph'] = (_uri, options) =>
        new Promise<GraphDocument | undefined>((resolve, reject) => {
            calls.push({ signal: options.signal, answer: resolve, fail: reject });
            started?.();
        });
    const nextCall = (): Promise<void> => new Promise<void>(resolve => { started = resolve; });
    return { getGraph, calls, nextCall };
}

const named = (id: string): GraphDocument =>
    ({ version: '1.0', graph: { id, nodes: [], edges: [] } }) as unknown as GraphDocument;

describe('requests in the session\'s queue', () => {
    it('a request replaced while it still waits in the queue never asks the product', async () => {
        const source = heldSource();
        const s = queuedSession(source.getGraph);
        try {
            s.modelState.root = { id: 'before' };
            let asked = source.nextCall();
            const l1 = s.request('open-1');
            await asked;

            // A save while L1 loads (it aborts L1), and a refresh while that save still waits.
            const r2 = s.request('save-2');
            const r3 = s.request('refresh-3');
            expect(source.calls[0].signal?.aborted).toBe(true);

            asked = source.nextCall();
            source.calls[0].answer(named('L1'));
            await l1;
            await r2;
            await asked;

            // The save's load never started: the product was asked twice, for L1 and R3.
            expect(source.calls).toHaveLength(2);
            expect(source.calls[1].signal?.aborted).toBe(false);
            source.calls[1].answer(named('R3'));
            await r3;

            expect(s.built).toEqual(['R3']);
            expect(s.shown).toEqual(['R3']);
            expect(s.failed).toEqual([]);
        } finally {
            s.done();
        }
    });

    it('a request that arrives once the product has answered aborts nothing, and the answer is drawn', async () => {
        const source = heldSource();
        const s = queuedSession(source.getGraph);
        try {
            s.modelState.root = { id: 'before' };
            const release = s.holdDrawing();
            let asked = source.nextCall();
            const l1 = s.request('open-1');
            await asked;
            source.calls[0].answer(named('L1'));
            // L1 is being laid out and drawn when the save comes.
            await new Promise(resolve => setTimeout(resolve, 0));
            asked = source.nextCall();
            const r2 = s.request('save-2');

            expect(source.calls[0].signal?.aborted).toBe(false);
            release();
            await l1;
            await asked;
            source.calls[1].answer(named('R2'));
            await r2;

            expect(s.built).toEqual(['L1', 'R2']);
            expect(s.shown).toEqual(['L1', 'R2']);
            expect(source.calls[0].signal?.aborted).toBe(false);
        } finally {
            s.done();
        }
    });

    it('a diagram\'s first load is let finish when a newer request comes, so that a failing newer one leaves its picture', async () => {
        // Without the first load's exemption, the first load was abandoned for
        // the save and the save's failure left the diagram with no model at all.
        const source = heldSource();
        const s = queuedSession(source.getGraph);
        try {
            let asked = source.nextCall();
            const l1 = s.request('open-1');
            await asked;
            asked = source.nextCall();
            const r2 = s.request('save-2');

            source.calls[0].answer(named('L1'));
            await l1;
            await asked;
            source.calls[1].fail(new Error('the compiler stopped'));
            await r2;

            expect(s.shown).toEqual(['L1']);
            expect(s.modelState.root?.id).toBe('L1');
            expect(s.failed).toEqual(['save-2: the compiler stopped']);
            expect(source.calls[0].signal?.aborted).toBe(false);
        } finally {
            s.done();
        }
    });

    it('a diagram\'s first load is let finish, so that a newer request with nothing new sends the first picture', async () => {
        const source = heldSource();
        const s = queuedSession(source.getGraph);
        try {
            let asked = source.nextCall();
            const l1 = s.request('open-1');
            await asked;
            asked = source.nextCall();
            const r2 = s.request('save-2');

            source.calls[0].answer(named('L1'));
            await l1;
            await asked;
            source.calls[1].answer(undefined);
            await r2;

            expect(s.shown).toEqual(['L1', 'L1']);
            expect(s.failed).toEqual([]);
        } finally {
            s.done();
        }
    });

    it('a diagram\'s first load is still abandoned when its editor closes', async () => {
        const source = heldSource();
        const s = queuedSession(source.getGraph);
        try {
            const asked = source.nextCall();
            const l1 = s.request('open-1');
            await asked;
            s.closeEditor();

            expect(source.calls[0].signal?.aborted).toBe(true);
            source.calls[0].answer(named('L1'));
            await l1;
            expect(s.built).toEqual([]);
            expect(s.shown).toEqual([]);
        } finally {
            s.done();
        }
    });
});
