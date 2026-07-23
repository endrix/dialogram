/**
 * Message-contract tests for ChatProfileRuntime (the activateChatProfile path).
 *
 * The critical contract, inherited from the proven chatbox handler: only the
 * `chat.ready` handshake reports `chat.connectionStatus`. Data requests such as
 * `chat.getProviders` must reply with their data ONLY — the chat panel re-fetches
 * providers/sessions whenever it sees a connected status, so a status echoed on
 * `chat.getProviders` creates an unbounded webview↔host ping-pong
 * (status → getProviders → status → …) that floods the channel and freezes the
 * extension host.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ChatProfileRuntime } from '../src/extension/chat/chat-profile-runtime';
import type { ChatPayload, ChatProfile } from '../src/api';

const URI = 'file:///tmp/example.mlir';

function makeRuntime() {
    const posts: Array<{ uri: string; payload: ChatPayload }> = [];
    const memento = {
        get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue,
        update: async (): Promise<void> => undefined,
        keys: (): string[] => []
    };
    const context = { workspaceState: memento } as any;
    const profile: ChatProfile = {
        key: 'test',
        displayName: 'Test',
        settingsSection: 'test.chat'
    };
    const runtime = new ChatProfileRuntime(context, profile, (uri, payload) =>
        posts.push({ uri, payload })
    );

    // Stub the ACP client as already connected so no process is spawned.
    const acp = (runtime as any).acp;
    acp.isClientConnected = () => true;
    acp.warmUpModelCatalog = async () => undefined;
    acp.listProviders = async () => [{ id: 'model-a', name: 'Model A' }];

    return { runtime, posts };
}

describe('ChatProfileRuntime message contract', () => {
    let runtime: ChatProfileRuntime;
    let posts: Array<{ uri: string; payload: ChatPayload }>;

    beforeEach(() => {
        ({ runtime, posts } = makeRuntime());
    });

    it('chat.getProviders while connected replies with providers only — no connectionStatus echo', async () => {
        await runtime.handleMessage(URI, { type: 'chat.getProviders' });

        const types = posts.map(p => p.payload.type);
        expect(types).toContain('chat.providers');
        // Echoing a status here loops: the panel re-requests providers on every
        // connected status it receives.
        expect(types).not.toContain('chat.connectionStatus');
    });

    it('chat.ready still reports connection status (the one-time handshake)', async () => {
        await runtime.handleMessage(URI, { type: 'chat.ready' });

        const types = posts.map(p => p.payload.type);
        expect(types).toContain('chat.connectionStatus');
        expect(types).toContain('chat.sessions');
        expect(types).toContain('chat.providers');
    });

    it('a status-triggered refetch converges instead of ping-ponging', async () => {
        // Simulate the panel: every connected status triggers getProviders+getSessions.
        const countStatuses = () =>
            posts.filter(
                p => p.payload.type === 'chat.connectionStatus' && p.payload.data?.connected
            ).length;

        await runtime.handleMessage(URI, { type: 'chat.ready' });
        let answered = 0;
        // Respond to each not-yet-answered connected status, as the panel does.
        for (let round = 0; round < 5 && answered < countStatuses(); round++) {
            answered = countStatuses();
            await runtime.handleMessage(URI, { type: 'chat.getProviders' });
            await runtime.handleMessage(URI, { type: 'chat.getSessions' });
        }
        // The handshake reports once; the refetch it triggers must not produce
        // another status, so the exchange terminates after a single round.
        expect(countStatuses()).toBe(1);
    });

    it('deleteSession/renameSession do not error when their prompts are dismissed', async () => {
        // Regression: these handlers called SessionManager.getSession(), which
        // did not exist — a TypeError surfaced as chat.error before the
        // confirmation dialog ever appeared.
        await runtime.handleMessage(URI, { type: 'chat.deleteSession', data: { sessionId: 's1' } });
        await runtime.handleMessage(URI, { type: 'chat.renameSession', data: { sessionId: 's1' } });
        expect(posts.map(p => p.payload.type)).not.toContain('chat.error');
    });

    it('two runtimes from one module instance are isolated', async () => {
        const a = makeRuntime();
        const b = makeRuntime();
        await a.runtime.handleMessage('file:///tmp/a.mlir', { type: 'chat.getProviders' });
        // b saw none of a's traffic — the state lives on instances, not the module.
        expect(b.posts).toHaveLength(0);
        expect(a.posts.length).toBeGreaterThan(0);
    });
});
