import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { StatusAction } from '@eclipse-glsp/protocol';
import { WorkflowRequestModelActionHandler } from '../src/server/diagram-action-handlers';

/**
 * The GLSP base `RequestModelActionHandler` starts progress reporting by dispatching a sticky
 * `StatusAction` (severity INFO, message "Model loading in progress") and clears it with a
 * second `StatusAction` (severity NONE) once the load finishes. Its stock error path ends the
 * progress monitor but rethrows WITHOUT the clearing dispatch, so a failed load pins the
 * notification forever. These tests pin the disposal contract: a clearing status is dispatched
 * on BOTH the success and the failure path.
 */
function makeHandler(loadSourceModel: () => Promise<void>) {
    const dispatched: StatusAction[] = [];
    let monitorEnded = 0;

    const handler = new WorkflowRequestModelActionHandler();
    (handler as any).logger = { debug: () => {} };
    (handler as any).modelState = { setAll: () => {}, root: { revision: 0 } };
    (handler as any).sourceModelStorage = { loadSourceModel };
    (handler as any).actionDispatcher = {
        dispatch: (action: any) => {
            if (action?.kind === StatusAction.KIND) {
                dispatched.push(action as StatusAction);
            }
            return Promise.resolve();
        }
    };
    (handler as any).progressService = {
        start: () => ({ end: () => { monitorEnded += 1; } })
    };
    (handler as any).submissionHandler = { submitInitialModel: async () => [] };

    return { handler, dispatched, monitorEnded: () => monitorEnded };
}

describe('WorkflowRequestModelActionHandler model-loading notification disposal', () => {
    it('clears the loading status (NONE) after a successful load', async () => {
        const { handler, dispatched } = makeHandler(async () => {});

        await handler.execute({ kind: 'requestModel', requestId: 'open-1' } as any);

        // First INFO (start), last NONE (cleared).
        expect(dispatched[0]?.severity).toBe('INFO');
        expect(dispatched.at(-1)?.severity).toBe('NONE');
    });

    it('clears the loading status (NONE) and rethrows when the load fails', async () => {
        const boom = new Error('source load failed');
        const { handler, dispatched, monitorEnded } = makeHandler(async () => {
            throw boom;
        });

        await expect(
            handler.execute({ kind: 'requestModel', requestId: 'open-2' } as any)
        ).rejects.toBe(boom);

        // The INFO status must not be left pinned: a NONE clear was dispatched even on failure.
        expect(dispatched.some((a) => a.severity === 'INFO')).toBe(true);
        expect(dispatched.some((a) => a.severity === 'NONE')).toBe(true);
        expect(dispatched.at(-1)?.severity).toBe('NONE');
        // The progress monitor is ended exactly once (no double-end from base + override).
        expect(monitorEnded()).toBe(1);
    });

    it('never starts a status for a polling refresh (nothing to leak)', async () => {
        const { handler, dispatched } = makeHandler(async () => {});

        await handler.execute({ kind: 'requestModel', requestId: 'refresh-during-run-42' } as any);

        expect(dispatched).toHaveLength(0);
    });
});
