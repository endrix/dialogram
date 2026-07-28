/**
 * Server logger that downgrades one benign lifecycle error to debug.
 *
 * When an editor closes while a `requestModel` (or any request) is still in flight,
 * the in-process GLSP action dispatcher is disposed and rejects the pending request
 * with `Request '<id>' cancelled: dispatcher disposed`. `DefaultGLSPServer` logs that
 * rejection via `logger.error(...)` (glsp-server.js:149), so a routine editor-close
 * surfaces as a scary ERROR line even though the request result is discarded anyway.
 *
 * This is the sanctioned "downgrade cancellation of in-flight requests on dispose"
 * seam: we own the `Logger` DI binding (see server-module `appModule`), so we route
 * ONLY this specific disposed-cancellation message to `debug` and leave every other
 * error untouched. At the warn log level the downgraded message is suppressed in
 * normal operation; it is never swallowed silently for other cancellation causes.
 */

import { ConsoleLogger } from '@eclipse-glsp/server';

/** Matches the dispatcher-disposed cancellation the action-dispatcher throws on dispose. */
const DISPOSED_CANCELLATION = /cancelled: dispatcher disposed/i;

export class WorkflowServerLogger extends ConsoleLogger {
    override error(message: string, ...params: unknown[]): void {
        if (this.isDisposedCancellation(message, params)) {
            // Benign editor-close race: the in-flight request is cancelled because the
            // session's dispatcher was disposed. Downgrade to debug (suppressed at warn).
            this.debug(message, ...params);
            return;
        }
        super.error(message, ...params);
    }

    private isDisposedCancellation(message: string, params: unknown[]): boolean {
        if (DISPOSED_CANCELLATION.test(message)) {
            return true;
        }
        for (const param of params) {
            const text =
                param instanceof Error ? param.message : typeof param === 'string' ? param : '';
            if (text && DISPOSED_CANCELLATION.test(text)) {
                return true;
            }
        }
        return false;
    }
}
