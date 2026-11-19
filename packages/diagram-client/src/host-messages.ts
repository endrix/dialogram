/**
 * A product's own messages to and from its extension host.
 *
 * The webview has one VS Code API object, and the platform's page holds it:
 * `acquireVsCodeApi` throws when called twice. A product's webview code used
 * to reach for the platform's private copy of it to talk to its own host
 * code; this is the supported way. The host side already exists:
 * `DiagramProfile.onWebviewMessage` hears what is posted here, and
 * `DiagramProfileHandle.postToWebview` (or the hook's `ctx.postToWebview`)
 * sends what `onHostMessage` hears.
 *
 * Messages are objects with a string `type`. Types starting with `dialogram.`
 * or `chat.` are the platform's: posting one could drive the platform's own
 * handlers (save a file, answer a pending dialog), so it is refused, and
 * listeners do not hear them either, nor GLSP's own traffic, which carries no
 * `type`. Anything structured-cloneable goes, `ArrayBuffer`s included.
 */
import type { HostMessage, HostMessaging, SurfaceDisposable } from './diagram-surface';
import { VscodeUi } from './vscode-ui';

/** The prefixes of the platform's own message types. */
const RESERVED_PREFIXES = ['dialogram.', 'chat.'];

/** Whether a message type is the platform's, not a product's. */
export function isReservedMessageType(type: string): boolean {
    return RESERVED_PREFIXES.some(prefix => type.startsWith(prefix));
}

function isProductMessage(message: unknown): message is HostMessage {
    const type = (message as { type?: unknown } | null | undefined)?.type;
    return typeof type === 'string' && type !== '' && !isReservedMessageType(type);
}

/**
 * Send a message to the product's extension host. False when it was not sent:
 * a reserved or missing `type`, or no VS Code API (outside a webview).
 */
export function postToHost(message: HostMessage): boolean {
    if (!isProductMessage(message)) {
        // eslint-disable-next-line no-console
        console.warn(`[dialogram] postToHost: refused a message of type ${JSON.stringify((message as { type?: unknown })?.type)}; types starting with ${RESERVED_PREFIXES.join(' or ')} are the platform's`);
        return false;
    }
    return VscodeUi.instance.post(message);
}

/** Hear the messages the product's extension host sends to this webview. */
export function onHostMessage(listener: (message: HostMessage) => void): SurfaceDisposable {
    const stop = VscodeUi.instance.onMessage(message => {
        if (isProductMessage(message)) {
            listener(message);
        }
    });
    return { dispose: stop };
}

/** Both, as one object: what a surface's context carries. */
export const hostMessaging: HostMessaging = { post: postToHost, onMessage: onHostMessage };
