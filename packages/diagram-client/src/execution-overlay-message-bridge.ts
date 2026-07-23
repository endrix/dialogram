/**
 * Client-only routing of host `actionMessage` notifications (the run-stream
 * execution overlay; the grid toggle) into the webview.
 *
 * ## Why this exists (Round 6 — the registration-order race, now first-class)
 *
 * `vscode-messenger`'s `onNotification` is last-write-wins, so a stock
 * `actionMessage` registration landing AFTER a client-only wrapper used to
 * REPLACE it and the routing silently vanished (bar dark). The emergency fix
 * owned the one `actionMessage` handler and monkey-patched
 * `messenger.onNotification` to compose. That patch is retired: composition is
 * now a first-class capability of {@link DiagramWebviewChannel}, and this module
 * just registers the two client-only action-kind routes on it via
 * {@link installExecutionOverlayRouting}. The stock GLSP model-source handler
 * composes automatically (GLSP's direct `messenger.onNotification` is interposed
 * by the channel), so this is independent of registration order.
 */
import { IActionDispatcher, IDiagramStartup, TYPES } from '@eclipse-glsp/client';
import { Action as GlspAction } from '@eclipse-glsp/sprotty';
import { inject, injectable } from 'inversify';
import { EXECUTION_OVERLAY_ACTION_KIND } from '@dialogram/shared';
import { RunAgentStreamActionHandler } from './editing-action-handlers';
import { DiagramWebviewChannel } from './webview-channel';

/** Host-initiated grid toggle — a client-only kind routed to the dispatcher. */
const SHOW_GRID_ACTION_KIND = 'showGrid';

/** Client-only action kinds routed here; server-handled kinds are left to stock. */
const ROUTED_CLIENT_ONLY_KINDS: ReadonlySet<string> = new Set<string>([
    EXECUTION_OVERLAY_ACTION_KIND, // run-stream events → RunningAgentsBar
    SHOW_GRID_ACTION_KIND // host-initiated grid toggle (died at the same hop)
]);

interface ActionMessageParams {
    clientId?: string;
    action?: GlspAction & { events?: unknown[] };
}

/** Set once the diagram container exists; needed only for `showGrid` routing. */
let overlayActionDispatcher: IActionDispatcher | undefined;

export function setOverlayActionDispatcher(dispatcher: IActionDispatcher): void {
    overlayActionDispatcher = dispatcher;
}

/** Reset module state (tests only). */
export function __resetOverlayRoutingForTests(): void {
    overlayActionDispatcher = undefined;
}

/**
 * The client-only action carried by an `actionMessage` params payload, or
 * `undefined`. Exported for the regression test.
 */
export function routableActionFromParams(params: unknown): (GlspAction & { events?: unknown[] }) | undefined {
    const action = (params as ActionMessageParams | null | undefined)?.action;
    if (!action || typeof (action as { kind?: unknown }).kind !== 'string') {
        return undefined;
    }
    return ROUTED_CLIENT_ONLY_KINDS.has(action.kind) ? action : undefined;
}

/**
 * Register the two client-only action-kind routes on the canonical channel.
 * Call once, as early as possible (before the diagram identifier is accepted).
 * Composition is guaranteed by the channel, whatever order the starter, chat
 * panel, and GLSP client register in.
 */
export function installExecutionOverlayRouting(channel: DiagramWebviewChannel): void {
    channel.onActionKind(EXECUTION_OVERLAY_ACTION_KIND, (action) => {
        // Fresh instance; all state is static. Fires dialogram.runAgents.updated.
        new RunAgentStreamActionHandler().handle(action as never);
    });
    channel.onActionKind(SHOW_GRID_ACTION_KIND, (action) => {
        if (overlayActionDispatcher) {
            void overlayActionDispatcher.dispatch(action as GlspAction);
        }
    });
}

/**
 * IDiagramStartup whose only job is to hand the container's action dispatcher to
 * the module-level router (used for `showGrid`; the overlay path needs no DI).
 */
@injectable()
export class ExecutionOverlayMessageBridge implements IDiagramStartup {
    @inject(TYPES.IActionDispatcher)
    protected readonly actionDispatcher!: IActionDispatcher;

    postModelInitialization(): void {
        setOverlayActionDispatcher(this.actionDispatcher);
    }
}
