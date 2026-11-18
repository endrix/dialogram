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
 *  - in the MIDDLE while there is no diagram on screen: the first open, and a
 *    view that could not be drawn being asked for again;
 *  - as a PILL at the top while a diagram is on screen and another is on its
 *    way (a view opened from the outline, a refresh after a save). The reader
 *    is looking at something and would rather not have it covered. The pill
 *    waits {@link BUSY_DELAY_MS} before it appears: most loads are over by
 *    then, and a pill that blinks on every one of them is noise.
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
 * When the model arrives. The load is what is being waited for, so its model
 * IS the end of the wait: no timer, and no way for the indicator to outlive
 * the work or to give up before it. A load that ends without a model (it
 * failed) says so itself (`state: 'done'`).
 */

import { injectable } from 'inversify';
import type { GModelRoot, IGModelRootListener } from '@eclipse-glsp/client';
import { isLoadingMessage, type LoadingUpdate } from '@dialogram/shared';

const INDICATOR_ID = 'workflow-loading';

/** How long a load behind a diagram that is on screen may take before it is said. */
export const BUSY_DELAY_MS = 300;

/** From how many seconds the wait is counted out loud: a load of a second needs no stopwatch. */
const CLOCK_FROM_SECONDS = 2;

/** The root GLSP installs before any model has come: not a diagram, and not the end of a load. */
const EMPTY_ROOT_TYPE = 'NONE';

type Mode = 'center' | 'pill';

let diagramOnScreen = false;
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
    // Said to a screen reader as it changes, without taking the focus.
    indicator.setAttribute('role', 'status');
    indicator.setAttribute('aria-live', 'polite');

    const card = document.createElement('div');
    card.className = 'workflow-loading-card';
    const spinner = document.createElement('div');
    spinner.className = 'workflow-loading-spinner';
    spinner.setAttribute('aria-hidden', 'true');
    const text = document.createElement('div');
    text.className = 'workflow-loading-text';
    for (const part of ['message', 'detail', 'elapsed']) {
        const line = document.createElement('div');
        line.className = `workflow-loading-${part}`;
        text.appendChild(line);
    }
    // The clock is for the eye: read out every second it would be all a screen reader says.
    text.lastElementChild?.setAttribute('aria-hidden', 'true');
    card.append(spinner, text);
    indicator.appendChild(card);
    document.body.appendChild(indicator);
    return indicator;
}

function line(part: 'message' | 'detail' | 'elapsed'): Element | null {
    return typeof document === 'undefined' ? null : document.querySelector(`#${INDICATOR_ID} .workflow-loading-${part}`);
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
}

function show(mode: Mode, message: string, detail: string): void {
    const indicator = ensureIndicator();
    if (!indicator) {
        return;
    }
    cancelPendingShow();
    indicator.classList.toggle('workflow-loading-pill', mode === 'pill');
    write(message, detail);
    if (!visible) {
        visible = true;
        indicator.hidden = false;
        startClock();
    }
}

function hide(): void {
    cancelPendingShow();
    stopClock();
    visible = false;
    const indicator = typeof document === 'undefined' ? null : document.getElementById(INDICATOR_ID);
    if (indicator) {
        indicator.hidden = true;
    }
}

function cancelPendingShow(): void {
    if (pendingShow !== undefined) {
        clearTimeout(pendingShow);
        pendingShow = undefined;
    }
    pendingText = undefined;
}

/**
 * A load says what it is doing.
 *
 * Shown at once when nothing is on screen, since nothing is exactly what
 * there is to look at. With a diagram on screen it waits {@link BUSY_DELAY_MS}
 * first, and what it then says is the latest thing said.
 */
export function loadingProgress(message: string, detail = ''): void {
    if (visible) {
        write(message, detail);
        return;
    }
    if (!diagramOnScreen) {
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

/** A load is over, with a model or without one. */
export function loadingEnded(): void {
    hide();
}

/** What the host posted about a load. */
export function applyLoadingUpdate(update: LoadingUpdate): void {
    if (update.state === 'done') {
        loadingEnded();
    } else {
        loadingProgress(update.message, update.detail ?? '');
    }
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
    if (!diagramOnScreen && !visible) {
        show('center', openingMessage, '');
    }
}

function onMessage(event: MessageEvent): void {
    if (isLoadingMessage(event.data)) {
        applyLoadingUpdate(event.data.payload);
    }
}

/**
 * The model arrived, which is what was being waited for.
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
        diagramOnScreen = root.children.length > 0;
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
    hide();
    diagramOnScreen = false;
    if (installed && typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('message', onMessage);
    }
    installed = false;
    if (typeof document !== 'undefined') {
        document.getElementById(INDICATOR_ID)?.remove();
    }
}
