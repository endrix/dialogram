import { afterEach, describe, expect, it, vi } from 'vitest';
import { LogLevel } from '@eclipse-glsp/server';
import { WorkflowServerLogger } from '../src/server/disposed-request-logger';

/**
 * The disposed-session in-flight request rejection ("cancelled: dispatcher disposed")
 * is a benign editor-close race that DefaultGLSPServer logs at ERROR. WorkflowServerLogger
 * downgrades ONLY that message to debug (suppressed at warn), leaving other errors intact.
 */
describe('WorkflowServerLogger disposed-cancellation downgrade', () => {
    afterEach(() => vi.restoreAllMocks());

    it('does not emit console.error for a dispatcher-disposed cancellation (message text)', () => {
        const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const logger = new WorkflowServerLogger(LogLevel.warn);

        logger.error(`Failed to handle request 'requestModel' (client_1):`, `Error: Request 'r7' cancelled: dispatcher disposed`);

        expect(err).not.toHaveBeenCalled();
    });

    it('does not emit console.error when the cancellation arrives as an Error param', () => {
        const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const logger = new WorkflowServerLogger(LogLevel.warn);

        logger.error('Failed to handle request', new Error(`Request 'r7' cancelled: dispatcher disposed`));

        expect(err).not.toHaveBeenCalled();
    });

    it('still emits console.error for unrelated errors (no over-suppression)', () => {
        const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const logger = new WorkflowServerLogger(LogLevel.warn);

        logger.error('Something genuinely broke', new Error('boom'));

        expect(err).toHaveBeenCalledTimes(1);
    });
});
