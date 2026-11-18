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
import { counted, isBackgroundLoad, tellLoading } from '../src/server/load-progress';
import { WorkflowSourceModelStorage } from '../src/server/source-model-storage';

/**
 * What a load says about itself while a reader waits for it.
 *
 * The words go from the server to the host (a sink) and from there to the
 * diagram. What is pinned here: which loads say anything, what the platform
 * says of its own steps, that a product's words are passed on as they should
 * be shown, and that a load which ends without a model says that it has: a
 * model is what takes the indicator down, and such a load has none.
 */

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
    const told: Array<{ clientId: string; update: LoadingUpdate }> = [];
    const storage = new WorkflowSourceModelStorage() as any;
    storage.injectedModelSource = { getGraph } satisfies DiagramModelSource;
    if (withSink) {
        storage.loadProgressSink = (clientId: string, update: LoadingUpdate) => told.push({ clientId, update });
    }
    storage.clientId = 'client-7';
    storage.publishGraphDiagnostics = async () => undefined;
    storage.finishLoadFromDoc = async () => {
        told.push({ clientId: 'client-7', update: { state: 'progress', message: '(the model is built here)' } });
    };
    const load = (requestId: string, options: Record<string, unknown> = {}) =>
        storage.loadSourceModel({ kind: 'requestModel', requestId, options: { sourceUri: SOURCE, ...options } });
    return { load, told, lines: () => told.map(entry => entry.update) };
}

describe('a load', () => {
    it('says that it is reading the file, then what it draws and how much of it there is', async () => {
        const { load, told, lines } = storageWith(async () => graph(177, 565));

        await load('open-1');

        expect(lines()).toEqual([
            { state: 'progress', message: 'Reading Top.fir' },
            { state: 'progress', message: 'Drawing the diagram', detail: '177 nodes, 565 edges' },
            { state: 'progress', message: '(the model is built here)' }
        ]);
        // To the client whose load it is.
        expect(told.every(entry => entry.clientId === 'client-7')).toBe(true);
        // And nothing says it is over: the model does, when it arrives.
        expect(lines().some(update => update.state === 'done')).toBe(false);
    });

    it('passes on what the product says while it reads, as it should be shown', async () => {
        const { load, lines } = storageWith(async (_uri, options: ModelSourceOptions) => {
            options.progress?.({ message: ' Reading the circuit\nwith firtool ', detail: 'Top.fir, 49 MB' });
            options.progress?.({ message: '' });
            options.progress?.({ message: 'Indexing the circuit' });
            return graph(9, 16);
        });

        await load('open-1');

        expect(lines().slice(0, 3)).toEqual([
            { state: 'progress', message: 'Reading Top.fir' },
            { state: 'progress', message: 'Reading the circuit with firtool', detail: 'Top.fir, 49 MB' },
            { state: 'progress', message: 'Indexing the circuit' }
        ]);
    });

    it('says the detail of an empty graph as nothing, not as zeros', async () => {
        const { load, lines } = storageWith(async () => graph(0, 0));

        await load('open-1');

        expect(lines()[1]).toEqual({ state: 'progress', message: 'Drawing the diagram', detail: '' });
    });

    it('says it is over when it failed: no model follows to say so', async () => {
        const failure = new Error('the sidecar did not start');
        const { load, lines } = storageWith(async () => { throw failure; });

        await expect(load('open-1')).rejects.toBe(failure);

        expect(lines()).toEqual([{ state: 'progress', message: 'Reading Top.fir' }, { state: 'done' }]);
    });

    it('says it is over when there is nothing to draw anew', async () => {
        const { load, lines } = storageWith(async () => undefined);

        await load('refresh-1');

        expect(lines()).toEqual([{ state: 'progress', message: 'Reading Top.fir' }, { state: 'done' }]);
    });

    it('says nothing when nobody is waiting on it, and hands the product nothing to say it with', async () => {
        let handed: ModelSourceOptions | undefined;
        const { load, told } = storageWith(async (_uri, options) => {
            handed = options;
            return graph(9, 16);
        });

        await load('refresh-live-overlay-1');

        // But for the stand-in for the model being built, which is not the load's.
        expect(told.map(entry => entry.update)).toEqual([{ state: 'progress', message: '(the model is built here)' }]);
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
