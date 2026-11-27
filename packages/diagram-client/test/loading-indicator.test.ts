// @vitest-environment happy-dom
/**
 * The loading indicator: where it is, what it says, and when it goes away.
 *
 * It is the answer to an empty canvas that says nothing, so the cases are the
 * waits a reader has: a first open (the middle of the canvas, at once), a load
 * once something has been drawn (a pill, and only when the wait is long
 * enough to be one), and the ways a wait ends: the host saying it is over
 * with its model on the way, the host saying it is over with none, and, for a
 * host that says nothing, the model itself.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOADING_MESSAGE_TYPE, type LoadingMessage } from '@dialogram/shared';
import {
    ANNOUNCE_DELAY_MS,
    BUSY_DELAY_MS,
    LoadingIndicatorModelListener,
    MODEL_GRACE_MS,
    applyLoadingUpdate,
    installLoadingIndicator,
    isLoadingVisible,
    loadingProgress,
    resetLoadingIndicatorForTests
} from '../src/loading-indicator';

const indicator = (): HTMLElement | null => document.getElementById('workflow-loading');
const announcer = (): HTMLElement | null => document.getElementById('workflow-loading-announcer');
const said = (part: 'message' | 'detail' | 'elapsed'): string =>
    indicator()?.querySelector(`.workflow-loading-${part}`)?.textContent ?? '';
const isPill = (): boolean => indicator()?.classList.contains('workflow-loading-pill') === true;

/** A model as the listener sees it: the root GLSP starts with, a diagram, a view that could not be drawn, an empty one. */
const emptyRoot = { type: 'NONE', id: 'EMPTY', children: [] } as never;
const drawnRoot = { type: 'graph', id: 'g', children: [{ id: 'n1' }] } as never;
const failureRoot = { type: 'graph', id: 'g', children: [{ id: 'error' }] } as never;
const nothingRoot = { type: 'graph', id: 'g', children: [] } as never;

const model = (root: never = drawnRoot): void => new LoadingIndicatorModelListener().modelRootChanged(root);
const post = (message: unknown): void => {
    window.dispatchEvent(new MessageEvent('message', { data: message }));
};
const progress = (message: string, detail?: string): LoadingMessage => ({
    type: LOADING_MESSAGE_TYPE,
    payload: { state: 'progress', message, ...(detail !== undefined ? { detail } : {}) }
});
const over: LoadingMessage = { type: LOADING_MESSAGE_TYPE, payload: { state: 'done' } };
const overWithModel: LoadingMessage = { type: LOADING_MESSAGE_TYPE, payload: { state: 'done', model: true } };

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

        model(emptyRoot);

        expect(isLoadingVisible()).toBe(true);
        post(progress('Reading Top.fir'));
        expect(said('message')).toBe('Reading Top.fir');
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

describe('when the wait is over', () => {
    it('goes away at the model the host said was on its way, and not before', () => {
        // Said before the model is sent: the indicator stays until there is
        // a picture to look at in its place.
        installLoadingIndicator();
        post(progress('Laying out the diagram'));

        post(overWithModel);
        expect(isLoadingVisible()).toBe(true);

        model();
        expect(isLoadingVisible()).toBe(false);
        expect(indicator()?.hidden).toBe(true);
    });

    it('goes away by itself if that model never arrives', () => {
        installLoadingIndicator();
        post(progress('Laying out the diagram'));
        post(overWithModel);

        vi.advanceTimersByTime(MODEL_GRACE_MS - 1);
        expect(isLoadingVisible()).toBe(true);
        vi.advanceTimersByTime(1);
        expect(isLoadingVisible()).toBe(false);
    });

    it('goes away at once when the host says it ended with nothing to draw', () => {
        installLoadingIndicator();
        post(progress('Reading Top.fir'));

        post(over);

        expect(isLoadingVisible()).toBe(false);
    });

    it('does not go away at a model that is not the one being waited for', () => {
        // A refresh the host makes behind the reader's back lands in the
        // middle of a first open, with a model of its own. The layout the
        // reader is waiting for is still running, and the indicator going
        // down with that model left the rest of the wait unexplained.
        installLoadingIndicator();
        post(progress('Reading Top.fir'));

        model();

        expect(isLoadingVisible()).toBe(true);
        // But there is a picture now, and the indicator is out of its way.
        expect(isPill()).toBe(true);

        post(progress('Laying out the diagram', '177 nodes, 565 edges'));
        expect(said('message')).toBe('Laying out the diagram');
        post(overWithModel);
        model();
        expect(isLoadingVisible()).toBe(false);
    });

    it('goes away at the model for a host that says nothing', () => {
        // A host from before the indicator, or one that shows no progress:
        // the model is all there is to go by.
        installLoadingIndicator();

        model();

        expect(isLoadingVisible()).toBe(false);
    });

    it('stays for a wait that begins as the one before it ends', () => {
        installLoadingIndicator();
        post(progress('Laying out the diagram'));
        post(overWithModel);

        post(progress('Reading Core.fir'));
        vi.advanceTimersByTime(MODEL_GRACE_MS);

        expect(isLoadingVisible()).toBe(true);
        expect(said('message')).toBe('Reading Core.fir');
    });
});

describe('what a screen reader is told', () => {
    it('is in a status region that is in the page before it is given its words', () => {
        // A region made and filled in the same breath is not reliably read
        // out, and the first words are the ones that would be.
        installLoadingIndicator();

        expect(announcer()?.getAttribute('role')).toBe('status');
        expect(announcer()?.getAttribute('aria-live')).toBe('polite');
        expect(announcer()?.hidden).toBe(false);
        // The picture of it is for the eye.
        expect(indicator()?.getAttribute('aria-hidden')).toBe('true');
        expect(announcer()?.textContent).toBe('');

        vi.advanceTimersByTime(ANNOUNCE_DELAY_MS);
        expect(announcer()?.textContent).toBe('Opening the diagram');
    });

    it('is each step, with how big the job is, and not the clock', () => {
        installLoadingIndicator();

        post(progress('Laying out the diagram', '177 nodes, 565 edges'));
        vi.advanceTimersByTime(10_000);

        expect(announcer()?.textContent).toBe('Laying out the diagram, 177 nodes, 565 edges');
    });

    it('is the latest step, when several come at once', () => {
        installLoadingIndicator();
        vi.advanceTimersByTime(ANNOUNCE_DELAY_MS);

        post(progress('Reading Top.fir'));
        post(progress('Drawing the diagram', '9 nodes, 16 edges'));
        vi.advanceTimersByTime(ANNOUNCE_DELAY_MS);

        expect(announcer()?.textContent).toBe('Drawing the diagram, 9 nodes, 16 edges');
    });

    it('is nothing once the wait is over', () => {
        installLoadingIndicator();
        post(progress('Reading Top.fir'));
        vi.advanceTimersByTime(ANNOUNCE_DELAY_MS);

        post(over);
        vi.advanceTimersByTime(ANNOUNCE_DELAY_MS);

        expect(announcer()?.textContent).toBe('');
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
        model();
        expect(said('elapsed')).toBe('');

        post(progress('Reading Top.fir'));
        vi.advanceTimersByTime(BUSY_DELAY_MS + 2_000);

        expect(said('elapsed')).toBe('2 s');
    });
});

describe('a load once something has been drawn', () => {
    const withDiagram = (root: never = drawnRoot): void => {
        installLoadingIndicator();
        model(root);
    };

    it('is not said if it is over before it would be noticed', () => {
        withDiagram();

        post(progress('Reading Top.fir'));
        vi.advanceTimersByTime(BUSY_DELAY_MS - 1);
        expect(isLoadingVisible()).toBe(false);

        post(overWithModel);
        model();
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

    it('is a pill over a view that could not be drawn, too, and over an empty one', () => {
        // The card that says why a file cannot be drawn is what is on screen,
        // and the file is read again at every pause in the typing. The
        // indicator in the middle, at once, flashed over that card each time.
        for (const root of [failureRoot, nothingRoot]) {
            resetLoadingIndicatorForTests();
            withDiagram(root);

            post(progress('Reading x.py'));
            expect(isLoadingVisible(), 'not at once').toBe(false);

            vi.advanceTimersByTime(BUSY_DELAY_MS);
            expect(isPill()).toBe(true);
        }
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

        post(overWithModel);
        model();

        expect(isLoadingVisible()).toBe(false);
    });

    it('does not appear once the host has said the wait is over, either way', () => {
        withDiagram();

        post(progress('Reading Top.fir'));
        applyLoadingUpdate({ state: 'done' });
        vi.advanceTimersByTime(5_000);
        expect(isLoadingVisible()).toBe(false);

        // With the model on its way: a pill for the moment before it lands is a blink.
        post(progress('Reading Top.fir'));
        post(overWithModel);
        vi.advanceTimersByTime(BUSY_DELAY_MS);
        expect(isLoadingVisible()).toBe(false);
    });
});

describe('a wait the webview starts', () => {
    it('is ended by the next model, even while a wait the host spoke of is ending', () => {
        installLoadingIndicator();
        post(progress('Reading Top.fir'));
        model();
        post(progress('Laying out the diagram'));
        // The host's wait is over, its model on the way…
        post(overWithModel);
        // …when the reader starts one of their own, which the host knows nothing of.
        loadingProgress('Expanding');
        model();
        vi.advanceTimersByTime(BUSY_DELAY_MS);
        expect(isLoadingVisible()).toBe(false);
        vi.advanceTimersByTime(MODEL_GRACE_MS);
        expect(isLoadingVisible()).toBe(false);
    });

    it('is ended by the host once the host speaks for it', () => {
        installLoadingIndicator();
        model();
        loadingProgress('Expanding');
        post(progress('Laying out the diagram', '594 nodes, 1,081 edges'));
        vi.advanceTimersByTime(BUSY_DELAY_MS);
        expect(isLoadingVisible()).toBe(true);
        // A model the host has not said is the end: the pill stays.
        model();
        expect(isLoadingVisible()).toBe(true);
        post(overWithModel);
        model();
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
                applyLoadingUpdate({ state: 'done', model: true });
                model();
            }).not.toThrow();
            expect(isLoadingVisible()).toBe(false);
        } finally {
            (globalThis as { document?: unknown }).document = page;
        }
    });
});
