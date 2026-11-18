import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import {
    LOADING_LINE_MAX,
    LOADING_MESSAGE_TYPE,
    isLoadingMessage,
    normalizeLoadProgress,
    type DiagramModelSource,
    type GraphDocument,
    type LoadingUpdate,
    type ModelSourceOptions
} from '@dialogram/shared';
import { LoadProgressReporter, counted, isBackgroundLoad, tellLoading } from '../src/server/load-progress';
import { WorkflowSourceModelStorage } from '../src/server/source-model-storage';

/**
 * What a load says about itself while a reader waits for it.
 *
 * The words go from the server to the host (a sink) and from there to the
 * diagram. What is pinned here: which loads say anything, what the platform
 * says of its own steps, that a product's words are passed on as they should
 * be shown, and how a wait is said to be over: by the session's reporter,
 * since a wait is several requests long and a model alone does not end it.
 */

/** A session's reporter, saying what it says to a list. */
function reporterTo(told: LoadingUpdate[]): LoadProgressReporter {
    const reporter = new LoadProgressReporter() as any;
    reporter.sink = (_client: string, update: LoadingUpdate) => told.push(update);
    reporter.clientId = 'client-7';
    return reporter as LoadProgressReporter;
}

describe('what a product says', () => {
    it('is shown as one trimmed line each', () => {
        expect(normalizeLoadProgress({ message: '  Reading the circuit\n with firtool ', detail: ' Top.fir,\t49 MB ' })).toEqual({
            message: 'Reading the circuit with firtool',
            detail: 'Top.fir, 49 MB'
        });
    });

    it('is cut to a length that fits the canvas', () => {
        const long = normalizeLoadProgress({ message: 'x'.repeat(500) })!;

        expect(long.message).toHaveLength(LOADING_LINE_MAX);
        expect(long.message.endsWith('…')).toBe(true);
    });

    it('has no detail when none was given, or an empty one', () => {
        expect(normalizeLoadProgress({ message: 'Elaborating Top' })).toEqual({ message: 'Elaborating Top' });
        expect(normalizeLoadProgress({ message: 'Elaborating Top', detail: '  ' })).toEqual({ message: 'Elaborating Top' });
        expect(normalizeLoadProgress({ message: 'Elaborating Top', detail: 42 })).toEqual({ message: 'Elaborating Top' });
    });

    it('is nothing when there is no message to show', () => {
        for (const nothing of [undefined, null, 'Reading', 42, {}, { message: '' }, { message: '   ' }, { message: 7 }, { detail: 'only this' }]) {
            expect(normalizeLoadProgress(nothing), JSON.stringify(nothing)).toBeUndefined();
        }
    });
});

describe('the message a diagram is posted', () => {
    it('is recognised by its type and its state', () => {
        expect(isLoadingMessage({ type: LOADING_MESSAGE_TYPE, payload: { state: 'progress', message: 'Reading Top.fir' } })).toBe(true);
        expect(isLoadingMessage({ type: LOADING_MESSAGE_TYPE, payload: { state: 'done' } })).toBe(true);
        expect(isLoadingMessage({ type: LOADING_MESSAGE_TYPE, payload: { state: 'done', model: true } })).toBe(true);
    });

    it('is not anything else that is posted to a webview', () => {
        for (const other of [
            undefined,
            null,
            'dialogram.loading',
            { type: 'dialogram.clientBehavior.merge', payload: { state: 'done' } },
            { type: LOADING_MESSAGE_TYPE },
            { type: LOADING_MESSAGE_TYPE, payload: 'done' },
            { type: LOADING_MESSAGE_TYPE, payload: { state: 'progress' } },
            { type: LOADING_MESSAGE_TYPE, payload: { state: 'started', message: 'x' } }
        ]) {
            expect(isLoadingMessage(other), JSON.stringify(other)).toBe(false);
        }
    });
});

describe('telling the host', () => {
    it('says it for the client it is about', () => {
        const sink = vi.fn();

        tellLoading(sink, 'client-7', { state: 'done' });

        expect(sink).toHaveBeenCalledWith('client-7', { state: 'done' });
    });

    it('says nothing without a host to tell, or without a client', () => {
        const sink = vi.fn();

        tellLoading(undefined, 'client-7', { state: 'done' });
        tellLoading(sink, undefined, { state: 'done' });
        tellLoading(sink, '', { state: 'done' });

        expect(sink).not.toHaveBeenCalled();
    });

    it('is never a reason for a load to fail', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            expect(() =>
                tellLoading(() => { throw new Error('the webview has gone'); }, 'client-7', { state: 'done' })
            ).not.toThrow();
        } finally {
            warn.mockRestore();
        }
    });

    it('counts with the noun it counts', () => {
        expect(counted(1, 'node')).toBe('1 node');
        expect(counted(0, 'edge')).toBe('0 edges');
        expect(counted(32298, 'node')).toBe('32,298 nodes');
    });
});

describe('which loads a reader is waiting on', () => {
    it('are the ones the reader asked for', () => {
        expect(isBackgroundLoad(undefined, undefined)).toBe(false);
        expect(isBackgroundLoad('', {})).toBe(false);
        // An open, a view opened from another, a save, the refresh command.
        expect(isBackgroundLoad('open-1', {})).toBe(false);
        expect(isBackgroundLoad('refresh-1763460000000', {})).toBe(false);
        expect(isBackgroundLoad('refresh-queue-visibility-1763460000000', {})).toBe(false);
    });

    it('are not the ones made behind their back', () => {
        // A run asks again every second to redraw its overlay; an indicator
        // for those would be up for as long as the run lasts.
        for (const id of ['refresh-during-run-1', 'refresh-live-overlay-1', 'refresh-agent-ctx-1', 'refresh-caller-refs-1']) {
            expect(isBackgroundLoad(id, {}), id).toBe(true);
        }
        expect(isBackgroundLoad('refresh-queue-visibility-1', { agentContextOnly: true })).toBe(true);
    });

    it('read the flag as the model handler does', () => {
        // Any truthy value takes the handler's fast path, whose submit is
        // the quiet one. Read more strictly here, such a load was spoken for
        // by the storage and ended by nobody.
        expect(isBackgroundLoad('refresh-1', { agentContextOnly: 'true' })).toBe(true);
        expect(isBackgroundLoad('refresh-1', { agentContextOnly: 1 })).toBe(true);
        expect(isBackgroundLoad('refresh-1', { agentContextOnly: false })).toBe(false);
        expect(isBackgroundLoad('refresh-1', { agentContextOnly: '' })).toBe(false);
    });
});

describe('a session saying what its reader is waiting for', () => {
    it('says what is being done, and that it is over with its model on the way', () => {
        const told: LoadingUpdate[] = [];
        const reporter = reporterTo(told);

        reporter.say({ message: 'Reading Top.fir' });
        reporter.say({ message: 'Laying out the diagram', detail: '9 nodes, 16 edges' });
        reporter.endWithModel();

        expect(told).toEqual([
            { state: 'progress', message: 'Reading Top.fir' },
            { state: 'progress', message: 'Laying out the diagram', detail: '9 nodes, 16 edges' },
            { state: 'done', model: true }
        ]);
    });

    it('says that it is over with nothing to show, when that is how it ended', () => {
        const told: LoadingUpdate[] = [];
        const reporter = reporterTo(told);

        reporter.say({ message: 'Reading Top.fir' });
        reporter.endWithoutModel();

        expect(told.at(-1)).toEqual({ state: 'done' });
    });

    it('ends only what it began', () => {
        // A submit follows every edit, and most of them were waited for by
        // nobody: an end said for each would be a message per keystroke.
        const told: LoadingUpdate[] = [];
        const reporter = reporterTo(told);

        reporter.endWithModel();
        reporter.endWithoutModel();
        expect(told).toEqual([]);

        // And once: the end of a wait is not the end of the next.
        reporter.say({ message: 'Reading Top.fir' });
        reporter.endWithModel();
        reporter.endWithModel();
        expect(told).toHaveLength(2);
    });

    it('ends a wait whatever else the session is in the middle of', () => {
        // Whether a request is the reader's is the caller's to know, call by
        // call: the session does not handle one request at a time, and a
        // "background request in flight" kept here once made the reader's own
        // end look like the background's. Here whatever is said is said, and
        // whatever is ended is ended, with nothing to be in the middle of.
        const told: LoadingUpdate[] = [];
        const reporter = reporterTo(told);

        reporter.say({ message: 'Reading Top.fir' });
        expect(reporter.telling).toBe(true);
        reporter.endWithModel();

        expect(told.at(-1)).toEqual({ state: 'done', model: true });
    });

    it('says nothing on a host that shows no progress, or before it knows its client', () => {
        const silent = new LoadProgressReporter();
        expect(silent.telling).toBe(false);
        expect(silent.listened).toBe(false);
        expect(() => { silent.say({ message: 'Reading' }); silent.endWithModel(); silent.endWithoutModel(); }).not.toThrow();

        const told: LoadingUpdate[] = [];
        const clientless = reporterTo(told);
        (clientless as any).clientId = undefined;
        clientless.say({ message: 'Reading' });
        expect(clientless.listened).toBe(true);
        expect(told).toEqual([]);
    });
});

// ---------------------------------------------------------------- a load, start to end

const SOURCE = 'file:///w/Top.fir';

const graph = (nodes: number, edges: number): GraphDocument =>
    ({
        version: '1.0',
        graph: {
            id: 'g',
            nodes: Array.from({ length: nodes }, (_, i) => ({ id: `n${i}` })),
            edges: Array.from({ length: edges }, (_, i) => ({ id: `e${i}` }))
        }
    }) as unknown as GraphDocument;

/**
 * A storage that reads through `getGraph` and stops where the model would be
 * built: what is said up to there is this suite's, what is built after is
 * every other suite's.
 */
function storageWith(getGraph: DiagramModelSource['getGraph'], withSink = true) {
    const told: LoadingUpdate[] = [];
    const storage = new WorkflowSourceModelStorage() as any;
    storage.injectedModelSource = { getGraph } satisfies DiagramModelSource;
    if (withSink) {
        storage.loadProgress = reporterTo(told);
    }
    storage.publishGraphDiagnostics = async () => undefined;
    let built = 0;
    storage.finishLoadFromDoc = async () => { built += 1; };
    const load = (requestId: string, options: Record<string, unknown> = {}) =>
        storage.loadSourceModel({ kind: 'requestModel', requestId, options: { sourceUri: SOURCE, ...options } });
    return { load, told, built: () => built, storage };
}

describe('a load', () => {
    it('says that it is reading the file, then what it draws and how much of it there is', async () => {
        const { load, told, built } = storageWith(async () => graph(177, 565));

        await load('open-1');

        expect(told).toEqual([
            { state: 'progress', message: 'Reading Top.fir' },
            { state: 'progress', message: 'Drawing the diagram', detail: '177 nodes, 565 edges' }
        ]);
        expect(built()).toBe(1);
        // And does not say it is over: the layout is still to come, and the
        // submit that sends the model says so.
        expect(told.some(update => update.state === 'done')).toBe(false);
    });

    it('passes on what the product says while it reads, as it should be shown', async () => {
        const { load, told } = storageWith(async (_uri, options: ModelSourceOptions) => {
            options.progress?.({ message: ' Reading the circuit\nwith firtool ', detail: 'Top.fir, 49 MB' });
            options.progress?.({ message: '' });
            options.progress?.({ message: 'Indexing the circuit' });
            return graph(9, 16);
        });

        await load('open-1');

        expect(told.slice(0, 3)).toEqual([
            { state: 'progress', message: 'Reading Top.fir' },
            { state: 'progress', message: 'Reading the circuit with firtool', detail: 'Top.fir, 49 MB' },
            { state: 'progress', message: 'Indexing the circuit' }
        ]);
    });

    it('stops listening to the product once it has answered', async () => {
        // A product that wires this to a build's output and gives up on the
        // build goes on being told things: said then, they would raise an
        // indicator for a load that is over, which nothing takes down.
        let late: ModelSourceOptions['progress'];
        const { load, told } = storageWith(async (_uri, options) => {
            late = options.progress;
            return graph(9, 16);
        });
        await load('open-1');
        const before = told.length;

        late?.({ message: '[info] compiling 3 Scala sources' });

        expect(told).toHaveLength(before);
    });

    it('says the detail of an empty graph as nothing, not as zeros', async () => {
        const { load, told } = storageWith(async () => graph(0, 0));

        await load('open-1');

        expect(told[1]).toEqual({ state: 'progress', message: 'Drawing the diagram', detail: '' });
    });

    it('says it is over when reading failed: no model follows to say so', async () => {
        const failure = new Error('the sidecar did not start');
        const { load, told } = storageWith(async () => { throw failure; });

        await expect(load('open-1')).rejects.toBe(failure);

        expect(told).toEqual([{ state: 'progress', message: 'Reading Top.fir' }, { state: 'done' }]);
    });

    it('says it is over when building the model failed', async () => {
        const failure = new Error('the graph could not be converted');
        const { load, told, storage } = storageWith(async () => graph(9, 16));
        storage.finishLoadFromDoc = async () => { throw failure; };

        await expect(load('open-1')).rejects.toBe(failure);

        expect(told.at(-1)).toEqual({ state: 'done' });
    });

    it('does not say the wait is over when there is nothing to draw anew', async () => {
        // The handler goes on to submit what there was, and a model follows:
        // said to be over here, the indicator went one round trip before it.
        // (That the handler ends it, at that model or at the failure of a
        // first load with nothing to submit, is its own suite's.)
        const { load, told, built } = storageWith(async () => undefined);

        await load('refresh-1');

        expect(told).toEqual([{ state: 'progress', message: 'Reading Top.fir' }]);
        expect(built()).toBe(0);
    });

    it('says nothing when nobody is waiting on it, and hands the product nothing to say it with', async () => {
        let handed: ModelSourceOptions | undefined;
        const { load, told, built } = storageWith(async (_uri, options) => {
            handed = options;
            return graph(9, 16);
        });

        await load('refresh-live-overlay-1');

        expect(told).toEqual([]);
        expect(built()).toBe(1);
        expect(handed?.progress).toBeUndefined();
    });

    it('loads all the same on a host that shows no progress', async () => {
        let handed: ModelSourceOptions | undefined;
        const { load } = storageWith(async (_uri, options) => {
            handed = options;
            return graph(9, 16);
        }, false);

        await expect(load('open-1')).resolves.toBeUndefined();
        expect(handed?.progress).toBeUndefined();
        expect(handed?.requestOptions.sourceUri).toBe(SOURCE);
    });
});
