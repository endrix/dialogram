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
 * progress could otherwise never replace it. A request that is itself
 * replaced while it waits there never calls `getGraph`: when it is taken
 * from the queue, its signal is already aborted.
 *
 * The signal covers the product's own work and nothing after it: it is let
 * go of as soon as `getGraph` has answered, so that what the platform then
 * draws of that answer (the layout, the model sent to the webview) never
 * belongs to an aborted signal.
 *
 * A diagram's first load is not replaced: until the diagram shows a graph,
 * the reader is waiting for a picture, any picture, and gets this one first
 * and the newer one after it. Only its editor closing aborts it.
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
    /** The loads in progress, and whether a newer request replaces each. */
    private readonly loads = new Map<AbortController, { replaceable: boolean }>();
    /** How many requests the reader waits on have arrived, and which arrival each request was. */
    private arrivals = 0;
    private readonly arrivalOf = new WeakMap<object, number>();
    private closed = false;

    /**
     * A load starts: the signal to hand its producer.
     *
     * `request` is the request it loads for, as the dispatcher saw it
     * arrive; `waitedOn`, whether the reader waits for it (not a run's
     * overlay redrawn in the background); `replaceable`, whether a newer
     * request replaces it while it runs (not a diagram's first load).
     *
     * Already aborted when the session is closed, and when a newer request
     * the reader waits on arrived while this one waited in the queue: such a
     * load is for nobody before it starts, and is not started.
     */
    begin(request: object | undefined, waitedOn: boolean, replaceable: boolean): AbortSignal {
        const controller = new AbortController();
        if (this.closed) {
            controller.abort(abortReason(EDITOR_CLOSED));
            return controller.signal;
        }
        const arrival = request === undefined ? undefined : this.arrivalOf.get(request);
        if (waitedOn && arrival !== undefined && arrival < this.arrivals) {
            controller.abort(abortReason(NEWER_REQUEST));
            return controller.signal;
        }
        this.loads.set(controller, { replaceable: waitedOn && replaceable });
        return controller.signal;
    }

    /**
     * The producer handed `signal` has answered, or the load ended before it
     * was asked: from now on nothing aborts the signal.
     */
    end(signal: AbortSignal): void {
        for (const controller of this.loads.keys()) {
            if (controller.signal === signal) {
                this.loads.delete(controller);
                return;
            }
        }
    }

    /**
     * A request the reader waits on has arrived (`request`, which may now
     * wait in the queue): the loads they were waiting on are for nobody now,
     * and so is every such request that arrived before it and has not
     * started. A load nobody was waiting on (an overlay being redrawn) is
     * left to finish, as is a diagram's first load; each has its own reason
     * to.
     */
    supersede(request?: object): void {
        if (request !== undefined) {
            this.arrivalOf.set(request, ++this.arrivals);
        }
        for (const [controller, { replaceable }] of this.loads) {
            if (replaceable) {
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
