import { describe, expect, it, vi } from 'vitest';
import type { ActionMessage } from '@eclipse-glsp/protocol';
import { createSessionGatedGlspClient } from '../src/server/session-gated-glsp-client';

/**
 * Regression coverage for item B: requests from a CLOSED session must not reach the
 * (now disposed) in-process dispatcher.
 *
 * On reopen the server logged
 *   `Failed to handle request 'requestModel' (client_1): Request cancelled: dispatcher disposed`
 * for both the pre-init buffered flush and the polling `refresh-queue-visibility`
 * redelivery — both traverse the wrapped client's `sendActionMessage`, which forwarded
 * them to the delegate after the session had been disposed.
 *
 * The wrapper now tracks disposed sessions and drops their sends silently (debug log)
 * until the same client id is re-initialized (a genuine reopen re-arms it).
 */

type Recorder = {
    delegate: any;
    sent: ActionMessage[];
};

function makeDelegate(): Recorder {
    const sent: ActionMessage[] = [];
    const delegate: any = {
        sendActionMessage: (m: ActionMessage) => sent.push(m),
        initializeClientSession: vi.fn(async () => {}),
        disposeClientSession: vi.fn(async () => {}),
        // A representative non-gated method to prove transparent delegation still works.
        start: vi.fn(async () => {})
    };
    return { delegate, sent };
}

const msg = (clientId: string, kind: string): ActionMessage => ({ clientId, action: { kind } } as ActionMessage);

const init = (client: any, clientSessionId: string): void => {
    void client.initializeClientSession({ clientSessionId, diagramType: 'd', clientActionKinds: [] });
};

describe('session-gated client: disposed-session guard', () => {
    it('drops a redelivery that arrives after the session was disposed (not merely buffered)', async () => {
        const { delegate, sent } = makeDelegate();
        const client = createSessionGatedGlspClient(delegate);

        init(client, 'client_1');
        client.sendActionMessage(msg('client_1', 'liveInit'));
        expect(sent.map(m => m.action.kind)).toEqual(['liveInit']);

        await client.disposeClientSession({ clientSessionId: 'client_1' } as any);

        // Late polling redelivery for the closed session: must be DROPPED, not buffered.
        client.sendActionMessage(msg('client_1', 'staleRedelivery'));
        expect(sent.map(m => m.action.kind)).toEqual(['liveInit']); // not forwarded

        // Distinguish drop from buffer: a genuine reopen must NOT replay the stale action.
        init(client, 'client_1');
        client.sendActionMessage(msg('client_1', 'freshAfterReopen'));
        expect(sent.map(m => m.action.kind)).toEqual(['liveInit', 'freshAfterReopen']);
        expect(sent.some(m => m.action.kind === 'staleRedelivery')).toBe(false);
    });

    it('drops pre-init buffered actions instead of flushing them to a disposed session', async () => {
        const { delegate, sent } = makeDelegate();
        const client = createSessionGatedGlspClient(delegate);

        // Buffered while the session is still pending init.
        client.sendActionMessage(msg('client_2', 'requestModel'));
        expect(sent).toHaveLength(0);

        // Session disposed before it was ever initialized -> buffer must be discarded,
        // and a subsequent (stray) init must NOT replay the stale buffered action.
        await client.disposeClientSession({ clientSessionId: 'client_2' } as any);
        expect(sent).toHaveLength(0);
    });

    it('re-arms a client id when it is re-initialized (genuine reopen still works)', async () => {
        const { delegate, sent } = makeDelegate();
        const client = createSessionGatedGlspClient(delegate);

        init(client, 'client_3');
        await client.disposeClientSession({ clientSessionId: 'client_3' } as any);

        // Reopen: same client id initialized again -> sends flow through once more.
        init(client, 'client_3');
        client.sendActionMessage(msg('client_3', 'requestModel'));
        expect(sent.map(m => m.action.kind)).toEqual(['requestModel']);
    });
});
