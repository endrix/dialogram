/**
 * Where the server says what a client's reader is waiting for.
 *
 * The server runs in the extension host and has no way to the webview but
 * diagram actions, which wait behind the model request they would be
 * reporting on. The host has the webview, so the host is handed the words
 * (`createWorkflowGlspVscodeServer({ loadProgress })`) and posts them.
 *
 * The sink is bound per server; a session says which client it is
 * (`ClientId`), and the host knows which webview that is. What a session says
 * goes through its {@link LoadProgressReporter}, which also knows when the
 * wait is over.
 */

import { ClientId } from '@eclipse-glsp/server';
import { inject, injectable, optional } from 'inversify';
import { wordsForPhase, type LoadPhase, type LoadPhaseFacts, type LoadPhaseWords, type LoadProgress, type LoadingUpdate } from '@dialogram/shared';

/** The host's side: post `update` to the diagram of the client `clientId`. */
export type LoadProgressSink = (clientId: string, update: LoadingUpdate) => void;

export const LOAD_PROGRESS_SINK = Symbol('LoadProgressSink');

/** The profile's words for the platform's own steps (`DiagramProfile.loadPhaseWords`), when it has any. */
export const LOAD_PHASE_WORDS = Symbol('LoadPhaseWords');

/**
 * Tell the host, if there is one to tell.
 *
 * Never throws and never waits: a status line is not a reason for a load to
 * fail or to take longer. Without a sink (tests, a host that does not show
 * progress) or without a client, nothing is said.
 */
export function tellLoading(sink: LoadProgressSink | undefined, clientId: string | undefined, update: LoadingUpdate): void {
    if (!sink || !clientId) {
        return;
    }
    try {
        sink(clientId, update);
    } catch (error) {
        console.warn('[dialogram] could not report load progress:', error);
    }
}

/**
 * Whether a load is one nobody asked for and nobody is waiting on.
 *
 * A run redraws its overlay by asking for the model again every second or so,
 * and the host warms what it knows of a diagram behind the reader's back. An
 * indicator for those would be up for as long as the run lasts, reporting on
 * nothing the reader did. The reader's own loads are the rest: an open, a
 * view opened from another, a refresh.
 */
export function isBackgroundLoad(requestId: string | undefined, options: Record<string, unknown> | undefined): boolean {
    const id = requestId ?? '';
    return (
        // As the model handler reads it (any truthy value takes its fast
        // path, whose submit is the quiet one): a load the storage spoke for
        // and the submit did not end would count its seconds for good.
        Boolean(options?.agentContextOnly) ||
        id.startsWith('refresh-during-run-') ||
        id.startsWith('refresh-live-overlay-') ||
        id.startsWith('refresh-agent-ctx-') ||
        id.startsWith('refresh-caller-refs-')
    );
}

/** "1 node", "177 nodes": a count with its noun, for a detail line. */
export function counted(count: number, noun: string): string {
    return `${count.toLocaleString('en-US')} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * What one session says of what its reader is waiting for, and when that is
 * over.
 *
 * A wait is not one request. A first open is a load, a round trip to the
 * diagram for the sizes of things, a layout, and only then a model; a view
 * with a layout of its own is a load and a model. And in the middle of
 * either, a request nobody is waiting on can come and go with a model of its
 * own. So the end of a wait is said here, by the code that knows it:
 *
 *  - the submit that sends the model the reader is waiting for
 *    ({@link endWithModel}), said before that model is sent, so that the
 *    indicator stays until there is a picture in its place;
 *  - a failure, anywhere on the way ({@link endWithoutModel}).
 *
 * A request nobody is waiting on says nothing here and ends nothing. That
 * is the CALLER's to see to, call by call (the storage does not speak for
 * such a load; its submit is the quiet one), and not something this class
 * keeps a state of: the session does not handle one request at a time. The
 * refresh the storage asks for itself, once it has found a workflow's
 * callers, is dispatched from inside the load that started the search, and
 * runs alongside whatever the queue brings next, the sizes the diagram
 * measured among it. A "background request in flight" kept here made the
 * reader's own end look like the background's: it was swallowed, and the
 * indicator counted the seconds of a load that was over.
 */
@injectable()
export class LoadProgressReporter {
    @inject(LOAD_PROGRESS_SINK)
    @optional()
    protected sink?: LoadProgressSink;

    @inject(ClientId)
    @optional()
    protected clientId?: string;

    @inject(LOAD_PHASE_WORDS)
    @optional()
    protected phaseWords?: LoadPhaseWords;

    /** Something has been said that has not been ended. */
    private said = false;

    /** Whether anything said here reaches a reader: a product is handed something to say its part with only then. */
    get telling(): boolean {
        return this.sink !== undefined && this.clientId !== undefined;
    }

    /** Whether the host shows what is said here at all. */
    get listened(): boolean {
        return this.sink !== undefined;
    }

    /** What is being done now. */
    say(progress: LoadProgress): void {
        if (!this.telling) {
            return;
        }
        this.said = true;
        tellLoading(this.sink, this.clientId, { state: 'progress', ...progress });
    }

    /**
     * One of the platform's own steps, in the platform's `words` unless the
     * profile put others in their place or silenced the step: a product
     * whose graph is not its content says what the reader is really waiting
     * for, or nothing, rather than "1 node, 0 edges".
     */
    sayPhase(phase: LoadPhase, words: LoadProgress, facts: LoadPhaseFacts): void {
        if (!this.telling) {
            return;
        }
        const chosen = wordsForPhase(this.phaseWords, phase, words, facts);
        if (chosen) {
            this.say(chosen);
        }
    }

    /** What was being waited for is over, and its model is about to be sent. */
    endWithModel(): void {
        this.end({ state: 'done', model: true });
    }

    /** What was being waited for is over, with no model to show for it. */
    endWithoutModel(): void {
        this.end({ state: 'done' });
    }

    private end(update: LoadingUpdate): void {
        if (!this.telling || !this.said) {
            return;
        }
        this.said = false;
        tellLoading(this.sink, this.clientId, update);
    }
}
