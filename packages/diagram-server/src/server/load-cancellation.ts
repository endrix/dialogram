/**
 * When nobody is waiting for a graph any more.
 *
 * A product's `getGraph` can run a compiler, a worker or a request to a
 * server for seconds. Two things leave that work with no one to give it to:
 * the diagram's editor closes, or the reader asks the same diagram for
 * another graph (a save, another view, a refresh) before this one has come.
 * The session says so through the `signal` it hands `getGraph`
 * (`ModelSourceOptions.signal`), so that the product can stop, and draws
 * nothing of a load it has abandoned.
 *
 * One per session. The session's action dispatcher tells it of a newer
 * request as the request ARRIVES, not when it is taken from the queue: the
 * queue is sequential, so a request that waits there for the load in
 * progress could otherwise never replace it.
 */

import { injectable } from 'inversify';

/** Thrown by the storage for a load that was abandoned; the handler ends such a load without a model and without an error. */
export class LoadAbandoned extends Error {
    constructor(readonly why: string) {
        super(`The load was abandoned: ${why}`);
        this.name = 'LoadAbandoned';
    }
}

/** Whether `error` is what a load that was abandoned ends with. */
export function isLoadAbandoned(error: unknown): error is LoadAbandoned {
    return error instanceof LoadAbandoned;
}

/** The reasons a signal is aborted with: an `AbortError`, as `fetch` and Node's own APIs throw. */
function abortReason(why: string): Error {
    // `DOMException` is global from Node 17; an Error named the same reads the same where it is not.
    const DomException = (globalThis as { DOMException?: new (message: string, name: string) => Error }).DOMException;
    if (DomException) {
        return new DomException(why, 'AbortError');
    }
    const error = new Error(why);
    error.name = 'AbortError';
    return error;
}

export const EDITOR_CLOSED = 'the diagram\'s editor closed';
export const NEWER_REQUEST = 'a newer request for the diagram replaced this one';

@injectable()
export class LoadCancellation {
    /** The loads in progress, and whether each is one the reader is waiting on. */
    private readonly loads = new Map<AbortController, { watched: boolean }>();
    private closed = false;

    /**
     * A load starts: the signal to hand its producer. Already aborted when the
     * session is closed, so that a load that starts after its editor has gone
     * stops at once.
     */
    begin(watched: boolean): AbortSignal {
        const controller = new AbortController();
        if (this.closed) {
            controller.abort(abortReason(EDITOR_CLOSED));
            return controller.signal;
        }
        this.loads.set(controller, { watched });
        return controller.signal;
    }

    /** The load that was handed `signal` is over, however it ended. */
    end(signal: AbortSignal): void {
        for (const controller of this.loads.keys()) {
            if (controller.signal === signal) {
                this.loads.delete(controller);
                return;
            }
        }
    }

    /**
     * The reader asked for another graph: the loads they were waiting on are
     * for nobody now. A load nobody was waiting on (an overlay being redrawn)
     * is left to finish; it has its own reason to.
     */
    supersede(): void {
        for (const [controller, { watched }] of this.loads) {
            if (watched) {
                this.loads.delete(controller);
                controller.abort(abortReason(NEWER_REQUEST));
            }
        }
    }

    /** The session is over (its editor closed): every load is for nobody, and so is any that starts. */
    close(): void {
        this.closed = true;
        for (const controller of this.loads.keys()) {
            controller.abort(abortReason(EDITOR_CLOSED));
        }
        this.loads.clear();
    }

    /** The words a signal was aborted with, for the log. */
    static why(signal: AbortSignal): string {
        const reason = signal.reason as { message?: unknown } | undefined;
        return typeof reason?.message === 'string' ? reason.message : String(signal.reason ?? 'aborted');
    }
}
