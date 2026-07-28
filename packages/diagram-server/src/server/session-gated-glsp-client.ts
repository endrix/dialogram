/**
 * Session-gated GLSP client wrapper.
 *
 * Fixes a GLSP 2.7 race: the in-process GLSP server throws
 *   `No client session has been initialized for client id: <id>`
 * from `DefaultGLSPServer.process()` whenever an action is forwarded before the
 * matching `initializeClientSession` has registered the session.
 *
 * The vscode-integration send path gates forwarding only on server readiness,
 * not on the per-client session:
 *   - `base-glsp-vscode-server.js` forwards on `onReady` (server initialized):
 *       `this.onSendToServerEmitter.event(m => this.onReady.then(() =>
 *          this._glspClient.sendActionMessage(m)))`
 *   - `webview-endpoint.js` fires `glspClient.initializeClientSession(params)`
 *     WITHOUT awaiting it, so the webview believes the session is ready and
 *     immediately dispatches its first `RequestModelAction`.
 * When the webview→host ordering slips, that first action reaches
 * `sendActionMessage` before the session is registered. The throw surfaces as an
 * unhandled promise rejection (the `onReady.then(...)` chain has no `catch`) and
 * the action is DROPPED — there is no queue in the stock path (identical code in
 * GLSP 2.5, which also throws; 2.7 merely made the symptom visible).
 *
 * This wrapper buffers pre-init actions per client id and flushes them, in
 * arrival order, the instant the client session is initialized. It delegates
 * every other method to the wrapped {@link BaseGLSPClient} untouched, so the
 * server→client proxy binding and the rest of the protocol are unaffected.
 */

import type {
    ActionMessage,
    BaseGLSPClient,
    DisposeClientSessionParameters,
    InitializeClientSessionParameters
} from '@eclipse-glsp/protocol';

const GATED_METHODS = new Set(['sendActionMessage', 'initializeClientSession', 'disposeClientSession']);

/**
 * Wrap an in-process {@link BaseGLSPClient} so actions forwarded before a client
 * session exists are buffered instead of dropped. Returns a transparent proxy:
 * all non-gated members delegate to the wrapped client.
 */
export function createSessionGatedGlspClient(delegate: BaseGLSPClient): BaseGLSPClient {
    const initializedSessions = new Set<string>();
    const bufferedByClientId = new Map<string, ActionMessage[]>();

    const flushBuffered = (clientId: string): void => {
        const buffered = bufferedByClientId.get(clientId);
        if (!buffered || buffered.length === 0) {
            return;
        }
        bufferedByClientId.delete(clientId);
        for (const message of buffered) {
            delegate.sendActionMessage(message);
        }
    };

    const gated: Pick<BaseGLSPClient, 'sendActionMessage' | 'initializeClientSession' | 'disposeClientSession'> = {
        sendActionMessage(message: ActionMessage): void {
            const { clientId } = message;
            if (initializedSessions.has(clientId)) {
                delegate.sendActionMessage(message);
                return;
            }
            // Session not initialized yet: buffer (never mutate the existing array).
            const buffered = bufferedByClientId.get(clientId) ?? [];
            bufferedByClientId.set(clientId, [...buffered, message]);
        },

        initializeClientSession(params: InitializeClientSessionParameters): Promise<void> {
            // The GLSP server registers the session synchronously (the
            // `clientSessions.set` runs before the method's first `await`), so by the
            // time this call returns control the session exists. Mark it ready and
            // flush anything buffered before the session was known.
            const result = delegate.initializeClientSession(params);
            initializedSessions.add(params.clientSessionId);
            flushBuffered(params.clientSessionId);
            return result;
        },

        disposeClientSession(params: DisposeClientSessionParameters): Promise<void> {
            initializedSessions.delete(params.clientSessionId);
            bufferedByClientId.delete(params.clientSessionId);
            return delegate.disposeClientSession(params);
        }
    };

    return new Proxy(delegate, {
        get(target, prop, _receiver) {
            if (typeof prop === 'string' && GATED_METHODS.has(prop)) {
                return (gated as Record<string, unknown>)[prop];
            }
            const value = Reflect.get(target, prop, target);
            // Bind methods to the real client so their internal `this` is never the proxy.
            return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        }
    });
}
