/**
 * The diagram's one "something is happening" indicator.
 *
 * A large design takes seconds to read and seconds more to lay out, and for
 * all of that the canvas was empty: nothing to tell a diagram that is on its
 * way from a viewer that has stopped. This is a turning circle with, under it,
 * what is being done now, how big the job is, and for how long it has been at
 * it. (Taken from the MLIR viewer, which had it first.)
 *
 * One element, in two places:
 *
 *  - in the MIDDLE until this webview has drawn its first model: the first
 *    open, when the canvas is empty and there is nothing else to look at;
 *  - as a PILL near the top from then on, whatever that model was: another
 *    view on its way (opened from the outline, a refresh after a save), or a
 *    file that could not be drawn being read again, whose card says why and
 *    is not to be covered. The pill waits {@link BUSY_DELAY_MS} before it
 *    appears: most loads are over by then, and a pill that blinks on every
 *    one of them, at every pause in the typing, is noise.
 *
 * It reports and never blocks (`pointer-events: none`): the work is the
 * host's, the webview stays free, and the reader can go on panning.
 *
 * ## Who says what
 *
 * The words are the host's ({@link LoadingMessage}, posted to the webview as
 * a message of its own so that it arrives WHILE the model is being asked
 * for). The starter raises the indicator before any of them, with words of
 * its own, so there is no moment with nothing.
 *
 * ## When it goes away
 *
 * When the host says the wait is over. With a model on its way (`done`,
 * `model`), at that model: the indicator stays until there is a picture in
 * its place. With none (`done`), at once.
 *
 * A model alone is not the end, once the host has spoken. Others arrive while
 * a load is on its way: a refresh the host makes behind the reader's back
 * lands in the middle of a first open whose layout is still running, and the
 * indicator going down with it left the rest of the wait unexplained. Before
 * the host has said anything (a host that says nothing at all, an older one),
 * a model is all there is to go by, and it does end the wait.
 */

import { injectable } from 'inversify';
import type { GModelRoot, IGModelRootListener } from '@eclipse-glsp/client';
import { isLoadingMessage, type LoadingUpdate } from '@dialogram/shared';

const INDICATOR_ID = 'workflow-loading';
const ANNOUNCER_ID = 'workflow-loading-announcer';

/** How long a load behind a diagram that is on screen may take before it is said. */
export const BUSY_DELAY_MS = 300;

/**
 * How long the indicator waits for the model the host said was on its way.
 * The model follows in the same breath; this is for the one that never
 * arrives, so that the indicator does not count the seconds of a wait that
 * is over.
 */
export const MODEL_GRACE_MS = 5_000;

/** From how many seconds the wait is counted out loud: a load of a second needs no stopwatch. */
const CLOCK_FROM_SECONDS = 2;

/** The root GLSP installs before any model has come: not a diagram, and not the end of a load. */
const EMPTY_ROOT_TYPE = 'NONE';

type Mode = 'center' | 'pill';

/** This webview has drawn a model: from here on the indicator keeps out of the way. */
let drawnOnce = false;
/** Something is being waited for. */
let waiting = false;
/** The host has said something of this wait, so the host will say when it is over. */
let hostSpoke = false;
/** The host has said it is over, and that its model is on its way. */
let ending = false;
let endTimer: ReturnType<typeof setTimeout> | undefined;

let visible = false;
let pendingShow: ReturnType<typeof setTimeout> | undefined;
/** What a pill not yet shown will say when it is. */
let pendingText: { message: string; detail: string } | undefined;
let clockTimer: ReturnType<typeof setInterval> | undefined;
let startedAt = 0;
let installed = false;

/** The indicator's element, made if it is not there. Nothing where there is no document. */
function ensureIndicator(): HTMLElement | undefined {
    if (typeof document === 'undefined' || !document.body) {
        return undefined;
    }
    const existing = document.getElementById(INDICATOR_ID);
    if (existing) {
        return existing;
    }
    const indicator = document.createElement('div');
    indicator.id = INDICATOR_ID;
    indicator.className = 'workflow-loading';
    indicator.hidden = true;
    // For the eye. What a screen reader is told is the announcer's, below.
    indicator.setAttribute('aria-hidden', 'true');

    const card = document.createElement('div');
    card.className = 'workflow-loading-card';
    const spinner = document.createElement('div');
    spinner.className = 'workflow-loading-spinner';
    const text = document.createElement('div');
    text.className = 'workflow-loading-text';
    for (const part of ['message', 'detail', 'elapsed']) {
        const line = document.createElement('div');
        line.className = `workflow-loading-${part}`;
        text.appendChild(line);
    }
    card.append(spinner, text);
    indicator.appendChild(card);
    document.body.appendChild(indicator);

    // A status region that is always there, and only its words change. One
    // that is shown and given its words in the same breath is not reliably
    // read out; and the clock, read out every second, would be all that is.
    const announcer = document.createElement('div');
    announcer.id = ANNOUNCER_ID;
    announcer.className = 'workflow-loading-announcer';
    announcer.setAttribute('role', 'status');
    announcer.setAttribute('aria-live', 'polite');
    document.body.appendChild(announcer);
    return indicator;
}

function line(part: 'message' | 'detail' | 'elapsed'): Element | null {
    return typeof document === 'undefined' ? null : document.querySelector(`#${INDICATOR_ID} .workflow-loading-${part}`);
}

function announce(words: string): void {
    const announcer = typeof document === 'undefined' ? null : document.getElementById(ANNOUNCER_ID);
    if (announcer && announcer.textContent !== words) {
        announcer.textContent = words;
    }
}

function write(message: string, detail: string): void {
    const messageLine = line('message');
    if (messageLine && messageLine.textContent !== message) {
        messageLine.textContent = message;
    }
    const detailLine = line('detail');
    if (detailLine && detailLine.textContent !== detail) {
        detailLine.textContent = detail;
    }
    announce(detail === '' ? message : `${message}, ${detail}`);
}

function show(mode: Mode, message: string, detail: string): void {
    const indicator = ensureIndicator();
    if (!indicator) {
        return;
    }
    cancelPendingShow();
    indicator.classList.toggle('workflow-loading-pill', mode === 'pill');
    if (!visible) {
        visible = true;
        indicator.hidden = false;
        startClock();
    }
    write(message, detail);
}

function hide(): void {
    cancelPendingShow();
    stopClock();
    visible = false;
    const indicator = typeof document === 'undefined' ? null : document.getElementById(INDICATOR_ID);
    if (indicator) {
        indicator.hidden = true;
    }
    announce('');
}

function cancelPendingShow(): void {
    if (pendingShow !== undefined) {
        clearTimeout(pendingShow);
        pendingShow = undefined;
    }
    pendingText = undefined;
}

function cancelEnding(): void {
    ending = false;
    if (endTimer !== undefined) {
        clearTimeout(endTimer);
        endTimer = undefined;
    }
}

/**
 * Something is being waited for, and this is what is being done about it.
 *
 * Shown at once while this webview has drawn nothing, since nothing is
 * exactly what there is to look at. After that it waits
 * {@link BUSY_DELAY_MS} first, and what it then says is the latest thing
 * said.
 */
export function loadingProgress(message: string, detail = ''): void {
    waiting = true;
    // A step said after the end was announced is a new wait's.
    cancelEnding();
    if (visible) {
        write(message, detail);
        return;
    }
    if (!drawnOnce) {
        show('center', message, detail);
        return;
    }
    pendingText = { message, detail };
    if (pendingShow === undefined) {
        pendingShow = setTimeout(() => {
            pendingShow = undefined;
            const text = pendingText;
            pendingText = undefined;
            if (text) {
                show('pill', text.message, text.detail);
            }
        }, BUSY_DELAY_MS);
    }
}

/** The wait is over. */
export function loadingEnded(): void {
    hide();
    cancelEnding();
    waiting = false;
    hostSpoke = false;
}

/** What the host posted about what the reader is waiting for. */
export function applyLoadingUpdate(update: LoadingUpdate): void {
    if (update.state === 'progress') {
        hostSpoke = true;
        loadingProgress(update.message, update.detail ?? '');
        return;
    }
    if (update.model !== true || !waiting) {
        loadingEnded();
        return;
    }
    // Over, with its model on its way: the indicator goes when the model is
    // there, or after a while if it never is. One that has not appeared yet
    // has no reason to now.
    hostSpoke = true;
    cancelPendingShow();
    cancelEnding();
    ending = true;
    endTimer = setTimeout(loadingEnded, MODEL_GRACE_MS);
    (endTimer as { unref?: () => void }).unref?.();
}

/** Whether the indicator is up. For tests and for whoever would otherwise put a second one beside it. */
export function isLoadingVisible(): boolean {
    return visible;
}

/**
 * Raise the indicator for a diagram that is being opened, and listen to the
 * host from here on.
 *
 * Called by the stock starter before anything else, and again where the stock
 * features are loaded, for a product whose starter is its own. Only the first
 * call does anything: a second one must not put "Opening the diagram" back
 * over what the host has said since.
 */
export function installLoadingIndicator(openingMessage = 'Opening the diagram'): void {
    if (installed || !ensureIndicator()) {
        return;
    }
    installed = true;
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('message', onMessage);
    }
    if (!drawnOnce && !visible) {
        loadingProgress(openingMessage);
    }
}

function onMessage(event: MessageEvent): void {
    if (isLoadingMessage(event.data)) {
        applyLoadingUpdate(event.data.payload);
    }
}

/**
 * A model has been drawn.
 *
 * Bound as an `IGModelRootListener`, which GLSP calls after every model it
 * has processed. The first of those is not a model: it is the empty root the
 * session starts with, long before the diagram's own, and taking it for the
 * end of the load took the indicator down a moment after it went up.
 */
@injectable()
export class LoadingIndicatorModelListener implements IGModelRootListener {
    modelRootChanged(root: Readonly<GModelRoot>): void {
        if (root.type === EMPTY_ROOT_TYPE) {
            return;
        }
        drawnOnce = true;
        if (waiting && hostSpoke && !ending) {
            // Not the model this wait is for: the host has not said the wait
            // is over. But there is a picture now, so the indicator gets out
            // of its way.
            if (visible) {
                document.getElementById(INDICATOR_ID)?.classList.add('workflow-loading-pill');
            }
            return;
        }
        loadingEnded();
    }
}

/**
 * The wait, counted.
 *
 * The words can stand unchanged for the ten seconds a compiler needs, which
 * is when a reader begins to think the viewer has died; a number that goes up
 * is the least that says it has not. Blank for the first two seconds, so that
 * a quick load does not flash a stopwatch.
 */
function startClock(): void {
    startedAt = Date.now();
    tick();
    if (clockTimer === undefined) {
        clockTimer = setInterval(tick, 1000);
        // Never a reason for a test process to stay up.
        (clockTimer as { unref?: () => void }).unref?.();
    }
}

function tick(): void {
    const elapsed = line('elapsed');
    if (!elapsed) {
        return;
    }
    const seconds = Math.floor((Date.now() - startedAt) / 1000);
    elapsed.textContent = seconds >= CLOCK_FROM_SECONDS ? `${seconds} s` : '';
}

function stopClock(): void {
    if (clockTimer !== undefined) {
        clearInterval(clockTimer);
        clockTimer = undefined;
    }
    const elapsed = line('elapsed');
    if (elapsed) {
        elapsed.textContent = '';
    }
}

/** Forget everything: for tests, which share the module between cases. */
export function resetLoadingIndicatorForTests(): void {
    loadingEnded();
    drawnOnce = false;
    if (installed && typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('message', onMessage);
    }
    installed = false;
    if (typeof document !== 'undefined') {
        document.getElementById(INDICATOR_ID)?.remove();
        document.getElementById(ANNOUNCER_ID)?.remove();
    }
}
