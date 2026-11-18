// @vitest-environment happy-dom
/**
 * The loading indicator: where it is, what it says, and when it goes away.
 *
 * It is the answer to an empty canvas that says nothing, so the cases are the
 * waits a reader has: a first open (the middle of the canvas, at once), a view
 * opened while another is on screen (a pill, and only when the wait is long
 * enough to be one), and the two ways a wait ends: the model, or the host
 * saying there will be none.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOADING_MESSAGE_TYPE, type LoadingMessage } from '@dialogram/shared';
import {
    BUSY_DELAY_MS,
    LoadingIndicatorModelListener,
    applyLoadingUpdate,
    installLoadingIndicator,
    isLoadingVisible,
    loadingProgress,
    resetLoadingIndicatorForTests
} from '../src/loading-indicator';

const indicator = (): HTMLElement | null => document.getElementById('workflow-loading');
const said = (part: 'message' | 'detail' | 'elapsed'): string =>
    indicator()?.querySelector(`.workflow-loading-${part}`)?.textContent ?? '';
const isPill = (): boolean => indicator()?.classList.contains('workflow-loading-pill') === true;

/** A model as the listener sees it: the root GLSP starts with, an empty diagram, a diagram. */
const emptyRoot = { type: 'NONE', id: 'EMPTY', children: [] } as never;
const drawnRoot = { type: 'graph', id: 'g', children: [{ id: 'n1' }] } as never;
const failureRoot = { type: 'graph', id: 'g', children: [] } as never;

const post = (message: unknown): void => {
    window.dispatchEvent(new MessageEvent('message', { data: message }));
};
const progress = (message: string, detail?: string): LoadingMessage => ({
    type: LOADING_MESSAGE_TYPE,
    payload: { state: 'progress', message, ...(detail !== undefined ? { detail } : {}) }
});

beforeEach(() => {
    vi.useFakeTimers();
    resetLoadingIndicatorForTests();
});

afterEach(() => {
    resetLoadingIndicatorForTests();
    vi.useRealTimers();
});

describe('a diagram that is being opened', () => {
    it('says so at once, in the middle of the canvas', () => {
        installLoadingIndicator();

        expect(isLoadingVisible()).toBe(true);
        expect(indicator()?.hidden).toBe(false);
        expect(isPill()).toBe(false);
        expect(said('message')).toBe('Opening the diagram');
        // Said to a screen reader as it changes, without taking the focus.
        expect(indicator()?.getAttribute('role')).toBe('status');
    });

    it('says what the host says it is doing, and how big the job is', () => {
        installLoadingIndicator();

        post(progress('Reading SmallBoomHarness.fir'));
        expect(said('message')).toBe('Reading SmallBoomHarness.fir');
        expect(said('detail')).toBe('');

        post(progress('Laying out the diagram', '177 nodes, 565 edges'));
        expect(said('message')).toBe('Laying out the diagram');
        expect(said('detail')).toBe('177 nodes, 565 edges');

        // A step with nothing to count clears the count of the step before.
        post(progress('Drawing the diagram'));
        expect(said('detail')).toBe('');
    });

    it('stays up through the empty root the session starts with', () => {
        // GLSP installs an empty root long before the diagram's own model.
        // Taken for the end of the load, it took the indicator down a moment
        // after it went up, and every step the host then reported went to
        // nothing.
        installLoadingIndicator();

        new LoadingIndicatorModelListener().modelRootChanged(emptyRoot);

        expect(isLoadingVisible()).toBe(true);
        post(progress('Reading Top.fir'));
        expect(said('message')).toBe('Reading Top.fir');
    });

    it('goes away when the model arrives', () => {
        installLoadingIndicator();
        post(progress('Laying out the diagram'));

        new LoadingIndicatorModelListener().modelRootChanged(drawnRoot);

        expect(isLoadingVisible()).toBe(false);
        expect(indicator()?.hidden).toBe(true);
    });

    it('goes away when the host says the load ended with nothing to draw', () => {
        installLoadingIndicator();

        post({ type: LOADING_MESSAGE_TYPE, payload: { state: 'done' } });

        expect(isLoadingVisible()).toBe(false);
    });

    it('is raised once: a second starter does not put the opening words back', () => {
        // The stock starter raises it, and so does the module of stock
        // features, for a product whose starter is its own. Whichever comes
        // second finds what the host has said since.
        installLoadingIndicator();
        post(progress('Reading Top.fir'));

        installLoadingIndicator();

        expect(said('message')).toBe('Reading Top.fir');
        expect(document.querySelectorAll('#workflow-loading')).toHaveLength(1);
    });

    it('takes no notice of messages that are not about loading', () => {
        installLoadingIndicator();

        post({ type: 'dialogram.clientBehavior.merge', payload: { message: 'not for it' } });
        post({ type: LOADING_MESSAGE_TYPE, payload: { state: 'progress' } });
        post({ type: LOADING_MESSAGE_TYPE });
        post('a string');
        post(null);

        expect(said('message')).toBe('Opening the diagram');
    });
});

describe('counting the wait', () => {
    it('says nothing for the first two seconds, then counts', () => {
        installLoadingIndicator();
        expect(said('elapsed')).toBe('');

        vi.advanceTimersByTime(1_000);
        expect(said('elapsed')).toBe('');

        vi.advanceTimersByTime(1_000);
        expect(said('elapsed')).toBe('2 s');

        vi.advanceTimersByTime(10_000);
        expect(said('elapsed')).toBe('12 s');
    });

    it('counts the whole wait, not each step of it', () => {
        installLoadingIndicator();
        vi.advanceTimersByTime(5_000);

        post(progress('Laying out the diagram'));
        vi.advanceTimersByTime(1_000);

        expect(said('elapsed')).toBe('6 s');
    });

    it('starts over for the next wait', () => {
        installLoadingIndicator();
        vi.advanceTimersByTime(7_000);
        new LoadingIndicatorModelListener().modelRootChanged(failureRoot);
        expect(said('elapsed')).toBe('');

        // Nothing was drawn, so the next load is in the middle again, and new.
        post(progress('Reading Top.fir'));
        expect(isLoadingVisible()).toBe(true);
        expect(isPill()).toBe(false);
        vi.advanceTimersByTime(2_000);
        expect(said('elapsed')).toBe('2 s');
    });
});

describe('a load while a diagram is on screen', () => {
    const withDiagram = (): void => {
        installLoadingIndicator();
        new LoadingIndicatorModelListener().modelRootChanged(drawnRoot);
    };

    it('is not said if it is over before it would be noticed', () => {
        withDiagram();

        post(progress('Reading Top.fir'));
        vi.advanceTimersByTime(BUSY_DELAY_MS - 1);
        expect(isLoadingVisible()).toBe(false);

        new LoadingIndicatorModelListener().modelRootChanged(drawnRoot);
        vi.advanceTimersByTime(5_000);
        expect(isLoadingVisible()).toBe(false);
    });

    it('is said as a pill, out of the way, when it lasts', () => {
        withDiagram();

        post(progress('Reading Top.fir'));
        vi.advanceTimersByTime(BUSY_DELAY_MS);

        expect(isLoadingVisible()).toBe(true);
        expect(isPill()).toBe(true);
        expect(said('message')).toBe('Reading Top.fir');
    });

    it('says the latest step when it appears, not the first', () => {
        withDiagram();

        post(progress('Reading Top.fir'));
        vi.advanceTimersByTime(100);
        post(progress('Laying out the diagram', '9 nodes, 16 edges'));
        vi.advanceTimersByTime(BUSY_DELAY_MS);

        expect(said('message')).toBe('Laying out the diagram');
        expect(said('detail')).toBe('9 nodes, 16 edges');
    });

    it('goes away with the model it was waiting for', () => {
        withDiagram();
        post(progress('Reading Top.fir'));
        vi.advanceTimersByTime(BUSY_DELAY_MS);

        new LoadingIndicatorModelListener().modelRootChanged(drawnRoot);

        expect(isLoadingVisible()).toBe(false);
        // And is in the middle again only if the canvas is empty.
        post(progress('Reading Core.fir'));
        vi.advanceTimersByTime(BUSY_DELAY_MS);
        expect(isPill()).toBe(true);
    });

    it('does not appear after the host has said the load is over', () => {
        withDiagram();
        post(progress('Reading Top.fir'));

        applyLoadingUpdate({ state: 'done' });
        vi.advanceTimersByTime(5_000);

        expect(isLoadingVisible()).toBe(false);
    });
});

describe('without a page', () => {
    it('does nothing, and does not throw', () => {
        const page = (globalThis as { document?: unknown }).document;
        (globalThis as { document?: unknown }).document = undefined;
        try {
            expect(() => {
                installLoadingIndicator();
                loadingProgress('Reading Top.fir');
                new LoadingIndicatorModelListener().modelRootChanged(drawnRoot);
            }).not.toThrow();
        } finally {
            (globalThis as { document?: unknown }).document = page;
        }
    });
});
