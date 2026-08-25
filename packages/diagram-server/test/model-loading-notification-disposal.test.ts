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

    it('still clears a load that a silent refresh interleaved with', async () => {
        // Whether to clear must follow what THIS request started, not handler state:
        // the finishing step runs after an await, and a silent refresh that ran in
        // the meantime would otherwise talk it out of clearing a notification the
        // refresh never started — pinning it until the tab is closed.
        // Both loads are held open, so the refresh is still IN FLIGHT when the real
        // load finishes. That ordering is the whole point: it is the only moment at
        // which shared state says "silent" while the request doing the finishing is
        // the loud one.
        const release: Array<() => void> = [];
        const { handler, dispatched, monitorEnded } = makeHandler(
            () => new Promise<void>(resolve => release.push(resolve))
        );

        const open = handler.execute({ kind: 'requestModel', requestId: 'open-3' } as any);
        await Promise.resolve();
        const refresh = handler.execute({ kind: 'requestModel', requestId: 'refresh-during-run-7' } as any);
        await Promise.resolve();

        release[0]?.();   // the real load finishes while the refresh is still running
        await open;
        release[1]?.();
        await refresh;

        expect(dispatched.at(-1)?.severity).toBe('NONE');
        expect(monitorEnded()).toBe(1);
    });
});
