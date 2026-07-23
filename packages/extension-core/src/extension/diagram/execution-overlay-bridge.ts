/**
 * Bridge that forwards execution-overlay stream events from the neutral
 * {@link ExecutionOverlayRegistry} to the owning diagram webview.
 *
 * ROOT-CAUSE NOTE (live-smoke fix): this MUST use the connector's UNGATED
 * `sendMessageToClient`, NOT `dispatchAction`. `dispatchAction` only forwards an
 * action to the webview when the action's `kind` is present in the client's
 * advertised `clientActions` handshake list; `EXECUTION_OVERLAY_ACTION_KIND` is a
 * client-only custom kind that is not reliably advertised there, so
 * `dispatchAction` SILENTLY DROPS every batch (client is found → no warning). This
 * is the exact reason the neighbouring `showGrid` toggle sends via
 * `sendMessageToClient`. See docs/edit-backend-contract notes and the
 * smoke-events-debug report.
 */
import type { ActionMessage } from '@eclipse-glsp/protocol';
import { EXECUTION_OVERLAY_ACTION_KIND, type ExecutionOverlayActionPayload } from '@dialogram/shared';

/**
 * Minimal connector seam the bridge depends on: the direct-to-webview send that
 * bypasses the `clientActions` gate (structurally a subset of
 * `GlspVscodeConnector`).
 */
export interface ExecutionOverlayWebviewSink {
    sendMessageToClient(clientId: string, message: ActionMessage): void;
}

/**
 * Forward one batch of opaque stream events to the webview owning `sourceUri`.
 *
 * @returns `true` if the batch was sent, `false` if it was dropped because no
 *   diagram is open for `sourceUri` (lossless: the SSE run stream replays full
 *   history on every (re)connect).
 */
export function forwardExecutionOverlayEvents(
    connector: ExecutionOverlayWebviewSink,
    clientId: string | undefined,
    sourceUri: string,
    events: unknown[],
    onDrop?: (reason: string) => void
): boolean {
    if (!clientId) {
        onDrop?.(`[wf-lang [run-stream] drop: no open diagram for ${sourceUri}; history replays on reconnect`);
        return false;
    }
    const action: ExecutionOverlayActionPayload = {
        kind: EXECUTION_OVERLAY_ACTION_KIND,
        sourceUri,
        events
    };
    // Client-only kind → direct send (see ROOT-CAUSE NOTE above).
    const message: ActionMessage = { clientId, action: action as unknown as ActionMessage['action'] };
    connector.sendMessageToClient(clientId, message);
    // Permanent, ungated bisection log (deliverable, not debug residue): pairs with
    // the client-side `[wf-lang overlay] received …` log so a live run instantly
    // shows whether a batch left the host and whether it arrived in the webview.
    // eslint-disable-next-line no-console
    console.log(`[wf-lang overlay] sent ${events.length} events for ${sourceUri} (client ${clientId})`);
    return true;
}
