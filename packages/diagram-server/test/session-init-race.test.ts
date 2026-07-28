import { describe, expect, it } from 'vitest';
import { BaseGLSPClient } from '@eclipse-glsp/protocol';
import type { ActionMessage } from '@eclipse-glsp/protocol';
import { createSessionGatedGlspClient } from '../src/server/session-gated-glsp-client';

/**
 * Regression coverage for the GLSP 2.7 session-init race.
 *
 * The in-process GLSP server throws
 *   `No client session has been initialized for client id: <id>`
 * from `DefaultGLSPServer.process()` whenever an action is forwarded before the
 * matching `initializeClientSession` has registered the session. Under GLSP 2.7
 * the vscode-integration send path (`base-glsp-vscode-server` →
 * `BaseGLSPClient.sendActionMessage`) gates forwarding only on server readiness
 * (`onReady`), NOT on the per-client session, and swallows the resulting throw as
 * an unhandled promise rejection — the pre-init action is DROPPED.
 *
 * `createSessionGatedGlspClient` wraps the in-process client so pre-init actions
 * are BUFFERED and flushed (in arrival order) the moment the client session is
 * initialized — no dropped actions, no unhandled rejections.
 */
class FakeGlspServer {
    readonly sessions = new Set<string>();
    readonly processed: ActionMessage[] = [];

    async initialize(): Promise<any> {
        return { protocolVersion: '1.0.0', serverActions: {} };
    }

    async initializeClientSession(params: { clientSessionId: string }): Promise<void> {
        // Mirror DefaultGLSPServer: the session is registered synchronously, before
        // the method's first `await`.
        this.sessions.add(params.clientSessionId);
    }

    async disposeClientSession(params: { clientSessionId: string }): Promise<void> {
        this.sessions.delete(params.clientSessionId);
    }

    process(message: ActionMessage): void {
        if (!this.sessions.has(message.clientId)) {
            throw new Error(`No client session has been initialized for client id: ${message.clientId}`);
        }
        this.processed.push(message);
    }

    shutdown(): void {
        /* no-op */
    }
}

async function startClient(server: FakeGlspServer): Promise<BaseGLSPClient> {
    const client = new BaseGLSPClient({ id: 'test' });
    client.configureServer(server as any);
    await client.start();
    return client;
}

const msg = (clientId: string, kind: string): ActionMessage =>
    ({ clientId, action: { kind } } as ActionMessage);

describe('GLSP 2.7 session-init race', () => {
    it('characterization: the stock client throws when an action is forwarded pre-init', async () => {
        const server = new FakeGlspServer();
        const raw = await startClient(server);

        expect(() => raw.sendActionMessage(msg('cal-network-diagram_0', 'requestModel'))).toThrow(
            /No client session has been initialized/
        );
        expect(server.processed).toHaveLength(0);
    });

    it('buffers a pre-init action and flushes it once the session is initialized', async () => {
        const server = new FakeGlspServer();
        const client = createSessionGatedGlspClient(await startClient(server));

        // Pre-init forward: buffered, never reaches the server, never throws.
        expect(() => client.sendActionMessage(msg('cal-network-diagram_0', 'requestModel'))).not.toThrow();
        expect(server.processed).toHaveLength(0);

        // Session init flushes the buffered action.
        void client.initializeClientSession({
            clientSessionId: 'cal-network-diagram_0',
            diagramType: 'cal-network-diagram',
            clientActionKinds: []
        } as any);

        expect(server.processed.map(m => m.action.kind)).toEqual(['requestModel']);
    });

    it('preserves arrival order across multiple buffered actions and forwards post-init sends directly', async () => {
        const server = new FakeGlspServer();
        const client = createSessionGatedGlspClient(await startClient(server));

        client.sendActionMessage(msg('cal-network-diagram_0', 'requestModel'));
        client.sendActionMessage(msg('cal-network-diagram_0', 'setViewport'));

        void client.initializeClientSession({
            clientSessionId: 'cal-network-diagram_0',
            diagramType: 'cal-network-diagram',
            clientActionKinds: []
        } as any);

        client.sendActionMessage(msg('cal-network-diagram_0', 'computedBounds'));

        expect(server.processed.map(m => m.action.kind)).toEqual([
            'requestModel',
            'setViewport',
            'computedBounds'
        ]);
    });

    it('isolates buffers per client id', async () => {
        const server = new FakeGlspServer();
        const client = createSessionGatedGlspClient(await startClient(server));

        client.sendActionMessage(msg('cal-network-diagram_0', 'requestModel'));
        client.sendActionMessage(msg('cal-network-diagram_1', 'requestModel'));

        void client.initializeClientSession({
            clientSessionId: 'cal-network-diagram_1',
            diagramType: 'cal-network-diagram',
            clientActionKinds: []
        } as any);

        // Only client _1's buffered action is flushed; _0 stays buffered.
        expect(server.processed.map(m => m.clientId)).toEqual(['cal-network-diagram_1']);
    });
});
