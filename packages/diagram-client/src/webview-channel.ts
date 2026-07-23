/**
 * The ONE canonical host↔webview notification channel, with FIRST-CLASS handler
 * composition.
 *
 * ## Why this exists (Rounds 5–6 — one route, composition instead of a patch)
 *
 * The webview has exactly one `acquireVsCodeApi()`, but historically GLSP and
 * the chat panel each built their OWN `vscode-messenger` `Messenger` over it.
 * `vscode-messenger`'s `onNotification(type, handler)` is
 * `handlerRegistry.set(type.method, handler)` — LAST WRITE WINS, one handler per
 * method. Two consequences bit us in production:
 *
 *   - Round 5: notifications landed on whichever `Messenger` was NOT holding the
 *     handler and were dropped ("unknown method") — dark RunningAgentsBar and a
 *     "chat disconnected" indicator that still worked.
 *   - Round 6: even on the single shared `Messenger`, GLSP's `WebviewGlspClient`
 *     registers its stock `actionMessage` handler LATE (lazily, on `initialize`),
 *     REPLACING any earlier client-only routing → the overlay silently vanished.
 *
 * The emergency fix (`installActionMessageRouting`) monkey-patched
 * `messenger.onNotification` to append `actionMessage` registrations. This class
 * is the first-class successor: it owns the sole `Messenger`, keeps a per-method
 * list of handlers that fire in registration order, and — because GLSP calls
 * `messenger.onNotification` DIRECTLY, bypassing this API — it interposes on the
 * wrapped messenger's `onNotification` so every direct registration also
 * composes. There is never a replacement, whatever the registration order.
 *
 * `dialogram.ui.*` (the raw request/response postMessage transport in
 * `vscode-ui.ts` ↔ the editor provider's `webview.onDidReceiveMessage`) is NOT
 * owned here: it uses a different wire envelope (`{type, payload}` with manual
 * `requestId` correlation), a different host receiver (the editor provider, not
 * the GLSP connector's messenger), and request/response semantics. Folding it
 * onto the messenger would be a protocol change, not a mechanical reroute — see
 * the Task 1 report. Both transports still share the one cached `acquireVsCodeApi`.
 */
import { HOST_EXTENSION } from 'vscode-messenger-common';

/** A cancellable subscription (VS Code `Disposable`-shaped). */
export interface ChannelSubscription {
    dispose(): void;
}

type NotificationHandler = (params: unknown, sender?: unknown) => void;

/**
 * Structural view of the `vscode-messenger-webview` `Messenger` the channel
 * wraps. `handlerRegistry` is `protected` on the concrete class; declaring it
 * here (as the old routing did) lets the channel adopt a pre-existing handler.
 * Call sites pass the concrete `Messenger` through a cast.
 */
export interface ChannelMessenger {
    onNotification(type: { method: string }, handler: NotificationHandler): unknown;
    sendNotification(type: { method: string }, receiver: unknown, params?: unknown): void;
    start?(): void;
    handlerRegistry?: Map<string, NotificationHandler>;
}

const ACTION_MESSAGE_METHOD = 'actionMessage';

interface ActionLike {
    kind?: unknown;
}
interface ActionMessageParams {
    clientId?: string;
    action?: ActionLike;
}

/** Handler for a specific `actionMessage` action kind. */
export type ActionKindHandler = (action: ActionLike, params: ActionMessageParams) => void;

/**
 * One registration instance. Each `onNotification`/interposed call produces a
 * distinct entry so `dispose()` removes ITS registration by identity, even when
 * the same handler function is registered more than once.
 */
interface HandlerEntry {
    readonly handler: NotificationHandler;
}

export class DiagramWebviewChannel {
    /** Per-method registration lists; fired in registration order. */
    private readonly handlers = new Map<string, HandlerEntry[]>();
    /** The ORIGINAL `onNotification`, bound — used to install the one real route. */
    private readonly realOnNotification: ChannelMessenger['onNotification'];
    private readonly messenger: ChannelMessenger;

    constructor(messenger: ChannelMessenger) {
        this.messenger = messenger;
        this.realOnNotification = messenger.onNotification.bind(messenger);
        // Interpose: every FUTURE `onNotification` on this messenger — including
        // GLSP's own late `actionMessage`/`clientStateChange` registrations that
        // never see this channel's API — composes into the per-method list
        // instead of the last-write-wins `handlerRegistry.set`. This is the
        // first-class replacement for the retired monkey-patch.
        messenger.onNotification = ((type: { method: string }, handler: NotificationHandler) => {
            this.register(type.method, handler);
            return messenger;
        }) as ChannelMessenger['onNotification'];
    }

    private registerEntry(method: string, handler: NotificationHandler): HandlerEntry {
        this.ensureRoute(method);
        const entry: HandlerEntry = { handler };
        this.handlers.get(method)!.push(entry);
        return entry;
    }

    /** Start the underlying messenger (idempotent; the Messenger guards `started`). */
    start(): void {
        this.messenger.start?.();
    }

    /**
     * Register a handler for a raw notification method. Multi-handler and
     * ordered; late registration composes (never replaces). Returns a
     * subscription whose `dispose()` removes just this handler.
     */
    onNotification(method: string, handler: NotificationHandler): ChannelSubscription {
        const entry = this.registerEntry(method, handler);
        return { dispose: () => this.unregister(method, entry) };
    }

    /**
     * Register a handler for a specific `actionMessage` action kind. Composes
     * with the stock GLSP model-source handler and any other action-kind
     * handlers on the same channel.
     */
    onActionKind(kind: string, handler: ActionKindHandler): ChannelSubscription {
        const wrapped: NotificationHandler = (params) => {
            const p = params as ActionMessageParams | null | undefined;
            const action = p?.action;
            if (action && (action as ActionLike).kind === kind) {
                handler(action, p as ActionMessageParams);
            }
        };
        return this.onNotification(ACTION_MESSAGE_METHOD, wrapped);
    }

    /** Send a notification to the extension host over the shared messenger. */
    sendToHost(method: string, payload?: unknown): void {
        this.messenger.sendNotification({ method }, HOST_EXTENSION, payload);
    }

    /** The wrapped messenger — escape hatch for the deprecated shared-messenger alias. */
    get rawMessenger(): ChannelMessenger {
        return this.messenger;
    }

    private register(method: string, handler: NotificationHandler): void {
        this.registerEntry(method, handler);
    }

    /** Remove exactly this registration instance (identity, not first-by-value). */
    private unregister(method: string, entry: HandlerEntry): void {
        const list = this.handlers.get(method);
        if (!list) {
            return;
        }
        const index = list.indexOf(entry);
        if (index >= 0) {
            list.splice(index, 1);
        }
    }

    /**
     * Install the ONE real handler for `method` on the underlying messenger the
     * first time anyone registers for it. Fans out to the per-method list in
     * registration order; a throwing handler never blocks its siblings.
     */
    private ensureRoute(method: string): void {
        if (this.handlers.has(method)) {
            return;
        }
        const list: HandlerEntry[] = [];
        // Adopt any handler already registered directly (before this channel
        // adopted the messenger) so a pre-existing route still fires; the real
        // dispatcher below then replaces it in the messenger's registry, so it
        // fires exactly once, through the list.
        const preexisting = this.messenger.handlerRegistry?.get(method);
        if (preexisting) {
            list.push({ handler: preexisting });
        }
        this.handlers.set(method, list);
        this.realOnNotification({ method }, (params, sender) => {
            for (const entry of [...(this.handlers.get(method) ?? [])]) {
                try {
                    entry.handler(params, sender);
                } catch (err) {
                    // eslint-disable-next-line no-console
                    console.warn(`[diagram-channel] "${method}" handler threw`, err);
                }
            }
        });
    }
}

// ── Module-singleton accessor (mirrors the retired shared-messenger pattern) ──

let channelSingleton: DiagramWebviewChannel | undefined;

/**
 * Publish the ONE channel over GLSP's messenger. Called once by the diagram
 * bootstrap, as early as possible (before any host notification can arrive and
 * before `WebviewGlspClient` registers its stock handlers).
 */
export function installDiagramWebviewChannel(messenger: ChannelMessenger): DiagramWebviewChannel {
    if (channelSingleton) {
        // Idempotent: a second install must NOT re-interpose on the messenger's
        // `onNotification` (that would double-wrap the dispatch). Warn and return
        // the already-published channel.
        // eslint-disable-next-line no-console
        console.warn('[diagram-channel] installDiagramWebviewChannel called twice; reusing the existing channel');
        return channelSingleton;
    }
    channelSingleton = new DiagramWebviewChannel(messenger);
    return channelSingleton;
}

/** The published channel, or `undefined` before the bootstrap has run. */
export function getDiagramWebviewChannel(): DiagramWebviewChannel | undefined {
    return channelSingleton;
}

/** Reset the module singleton (tests only). */
export function __resetDiagramWebviewChannelForTests(): void {
    channelSingleton = undefined;
}
