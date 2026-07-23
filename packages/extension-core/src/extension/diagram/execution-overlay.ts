import type { ExecutionNodeState, ExecutionOverlaySink } from '@dialogram/shared';

export type ExecutionOverlayListener = (sourceUri: string) => void;
export type ExecutionOverlayEventsListener = (sourceUri: string, events: unknown[]) => void;

/**
 * Upper bound on the per-sourceUri replay window (Task 4). A run.started resets
 * the window, so a buffer holds at most the CURRENT run's events; this caps the
 * retained size within a single, unusually chatty run.
 */
export const EXECUTION_EVENT_REPLAY_LIMIT = 256;

/**
 * True for an event shaped like the client's run-boundary marker. The client's
 * folding (`RunAgentStreamActionHandler.apply`) keys its clear-and-restart on
 * `ev.type === 'run.started'`; the buffer resets on the SAME field so replay
 * anchoring and client folding never disagree.
 */
function isRunStartedEvent(event: unknown): boolean {
    return (
        !!event &&
        typeof event === 'object' &&
        (event as { type?: unknown }).type === 'run.started'
    );
}

/**
 * Neutral per-diagram execution-state registry (v2 seam). Consumers push
 * node states from whatever runner they own; the platform's rendering
 * reads them. Nothing here spawns processes or reads run artifacts.
 */
export class ExecutionOverlayRegistry implements ExecutionOverlaySink {
    private readonly states = new Map<string, ExecutionNodeState[]>();
    private readonly listeners = new Set<ExecutionOverlayListener>();
    private readonly eventsListeners = new Set<ExecutionOverlayEventsListener>();
    /**
     * Bounded per-sourceUri replay window (Task 4). Holds the current run's
     * emitted events so a webview that closes and reopens MID-RUN can be replayed
     * back to the live bar state. Anchored at run.started; capped at
     * {@link EXECUTION_EVENT_REPLAY_LIMIT}.
     */
    private readonly replayBuffers = new Map<string, unknown[]>();

    /**
     * Derives the replay-buffer key from a source URI. Injected so the buffer
     * keys through the SAME canonicalization the editor provider uses for its
     * client/URI resolution (Task-4 review M2): the run driver emits with one URI
     * form and the provider replays with another, and those must resolve to the
     * same buffer even when the raw strings differ. Defaults to identity so the
     * registry stays product- and vscode-neutral and unit-testable without a host.
     */
    constructor(private readonly bufferKeyOf: (sourceUri: string) => string = uri => uri) {}

    publish(sourceUri: string, states: ExecutionNodeState[]): void {
        this.states.set(sourceUri, [...states]);
        for (const l of this.listeners) l(sourceUri);
    }

    clear(sourceUri: string): void {
        // A cleared source has no live run: drop its replay window too so a later
        // reopen does not resurrect a stale run's bar.
        this.replayBuffers.delete(this.bufferKeyOf(sourceUri));
        if (this.states.delete(sourceUri)) {
            for (const l of this.listeners) l(sourceUri);
        }
    }

    get(sourceUri: string): readonly ExecutionNodeState[] {
        return this.states.get(sourceUri) ?? [];
    }

    onDidChange(listener: ExecutionOverlayListener): { dispose(): void } {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    }

    /**
     * Opaque event channel, separate from the states channel. Consumers push a
     * batch of stream events (e.g. an agent token stream) for a source URI; the
     * platform's bridge forwards them to the owning webview. The exact array is
     * handed to each listener (zero-copy live path — onDidChange never fires), and
     * a bounded copy is appended to the source's replay window so a webview
     * reopened MID-RUN can be replayed back to the live bar state.
     */
    emitEvents(sourceUri: string, events: unknown[]): void {
        this.appendToReplayBuffer(sourceUri, events);
        for (const l of this.eventsListeners) l(sourceUri, events);
    }

    onDidEmitEvents(listener: ExecutionOverlayEventsListener): { dispose(): void } {
        this.eventsListeners.add(listener);
        return { dispose: () => this.eventsListeners.delete(listener) };
    }

    /**
     * The current replay window for a source URI, as a copy (callers may mutate
     * freely). Empty for a source that never emitted — the host drain then skips
     * the bridge send entirely. The window is anchored at the current run's
     * run.started and bounded by {@link EXECUTION_EVENT_REPLAY_LIMIT}.
     */
    replayEvents(sourceUri: string): unknown[] {
        return (this.replayBuffers.get(this.bufferKeyOf(sourceUri)) ?? []).slice();
    }

    /**
     * Fold a live batch into the source's bounded replay window.
     *
     * Semantics (see task-4-report):
     *  - a run.started event RESETS the window; the run.started itself becomes the
     *    window's first entry (matching the client's clear-and-restart);
     *  - otherwise events append until the window reaches
     *    {@link EXECUTION_EVENT_REPLAY_LIMIT} — ANCHOR-PRESERVING overflow: once
     *    the cap is hit, further events for the current run are dropped from the
     *    window (the newest 256th..N are shed), keeping the OLDEST window that
     *    still starts at run.started. Dropping the anchor instead (a newest-N ring)
     *    would leave the client's runActive false and the bar diverging from the
     *    never-closed case, so the anchor is retained on purpose.
     * The window is rebuilt as a new array (no in-place mutation of the stored one).
     */
    private appendToReplayBuffer(sourceUri: string, events: unknown[]): void {
        const key = this.bufferKeyOf(sourceUri);
        let next = (this.replayBuffers.get(key) ?? []).slice();
        for (const event of events) {
            if (isRunStartedEvent(event)) {
                next = [event];
            } else if (next.length < EXECUTION_EVENT_REPLAY_LIMIT) {
                next.push(event);
            }
            // else: anchor-preserving cap reached — shed the overflow tail.
        }
        this.replayBuffers.set(key, next);
    }
}
