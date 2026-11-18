/**
 * Where the server says what a client's load is doing.
 *
 * The server runs in the extension host and has no way to the webview but
 * diagram actions, which wait behind the model request they would be
 * reporting on. The host has the webview, so the host is handed the words
 * (`createWorkflowGlspVscodeServer({ loadProgress })`) and posts them.
 *
 * Bound per server, used per session: a session says which client it is
 * (`ClientId`), and the host knows which webview that is.
 */

import type { LoadingUpdate } from '@dialogram/shared';

/** The host's side: post `update` to the diagram of the client `clientId`. */
export type LoadProgressSink = (clientId: string, update: LoadingUpdate) => void;

export const LOAD_PROGRESS_SINK = Symbol('LoadProgressSink');

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
        options?.agentContextOnly === true ||
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
