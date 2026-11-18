/**
 * What a diagram that is loading says about it.
 *
 * A large design takes seconds to read and seconds more to lay out, and an
 * empty canvas for that long reads as a viewer that has stopped. The diagram
 * shows that it is working and what it is working on: a line for what is
 * happening now, a quieter one for how big the job is.
 *
 * The platform says its own steps (reading the file, laying the diagram out).
 * What is inside "reading the file" only the product knows, and it says so
 * through {@link ModelSourceOptions.progress}: its compiler running, its
 * sidecar starting, the build it is waiting for.
 *
 * The words travel from the server to the host and from the host to the
 * diagram's webview as a message of their own ({@link LOADING_MESSAGE_TYPE}),
 * and not as a diagram action: an action sent while the first model is being
 * asked for waits behind it, and would arrive when there is nothing left to
 * report.
 */

/** One thing a load is doing. */
export interface LoadProgress {
    /** What is happening now, in a few words: "Reading the circuit with firtool". */
    message: string;
    /** How big the job is, or what it is of: "SmallBoomHarness.fir, 49 MB". Absent clears the line. */
    detail?: string;
}

/** What the host tells a diagram about its load: what it is doing, or that it has ended with nothing to draw. */
export type LoadingUpdate =
    | ({ state: 'progress' } & LoadProgress)
    /**
     * The load is over and no model follows: it failed, or there was nothing
     * to draw again. A load that ends in a model says nothing: the model
     * arriving is the end.
     */
    | { state: 'done' };

/** The `type` of the message a diagram's webview is posted about its load. */
export const LOADING_MESSAGE_TYPE = 'dialogram.loading';

/** The message itself. */
export interface LoadingMessage {
    type: typeof LOADING_MESSAGE_TYPE;
    payload: LoadingUpdate;
}

/** The longest line shown; a product's words are cut to it. */
export const LOADING_LINE_MAX = 160;

/**
 * A product's words as they are shown: one line each, trimmed, cut to
 * {@link LOADING_LINE_MAX}. Nothing when there is no message to show, which a
 * caller takes for "say nothing".
 */
export function normalizeLoadProgress(progress: unknown): LoadProgress | undefined {
    if (!progress || typeof progress !== 'object') {
        return undefined;
    }
    const line = (value: unknown): string => {
        if (typeof value !== 'string') {
            return '';
        }
        const flat = value.replace(/\s+/g, ' ').trim();
        return flat.length > LOADING_LINE_MAX ? `${flat.slice(0, LOADING_LINE_MAX - 1)}…` : flat;
    };
    const message = line((progress as LoadProgress).message);
    if (message === '') {
        return undefined;
    }
    const detail = line((progress as LoadProgress).detail);
    return detail === '' ? { message } : { message, detail };
}

/** Whether a value posted to a webview is a {@link LoadingMessage} that can be shown. */
export function isLoadingMessage(value: unknown): value is LoadingMessage {
    if (!value || typeof value !== 'object' || (value as { type?: unknown }).type !== LOADING_MESSAGE_TYPE) {
        return false;
    }
    const payload = (value as { payload?: unknown }).payload as { state?: unknown; message?: unknown } | undefined;
    if (!payload || typeof payload !== 'object') {
        return false;
    }
    return payload.state === 'done' || (payload.state === 'progress' && typeof payload.message === 'string');
}
