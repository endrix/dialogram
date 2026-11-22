/**
 * Session-restore transcript fidelity.
 *
 * A turn that interleaves assistant text with tool calls
 * ([text "A", tool "read", text "B"]) must be persisted as an ordered,
 * structured transcript so that reloading the session restores it faithfully:
 *
 *  (a) tool-call parts survive into the restored `chat.sessionHistory` payload;
 *  (b) the two text parts are NOT merged across the tool boundary (no run-ons).
 *
 * Before the fix the whole turn was flattened into one concatenated assistant
 * message ("AB"), dropping the tool call and destroying the boundary.
 */
import { describe, it, expect, vi } from 'vitest';
import { ChatRuntime } from '../src/extension/chat/chat-runtime';
import type { ChatPayload } from '../src/api';

const URI = 'file:///tmp/example.mlir';

function makeRuntime() {
    const posts: Array<{ uri: string; payload: ChatPayload }> = [];
    const memento = {
        get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue,
        update: async (): Promise<void> => undefined,
        keys: (): string[] => []
    };
    const context = { workspaceState: memento } as any;
    const runtime = new ChatRuntime(context, { key: 't', displayName: 'T', settingsSection: 't.chat' } as any, (uri, payload) =>
        posts.push({ uri, payload })
    );
    const acp = (runtime as any).acp;
    acp.isClientConnected = () => true;
    acp.start = async () => undefined;
    acp.createSession = async () => 'session-1';
    acp.getSession = () => ({ id: 'session-1' });
    acp.loadSession = async () => undefined;
    acp.setProvider = async () => undefined;
    acp.setSessionMode = async () => undefined;
    acp.getSessionMode = () => 'build';
    acp.getSessionModel = () => 'model-a';
    acp.getMessagesWithIds = async () => [];
    acp.getRevertState = async () => false;
    return { runtime, posts, acp };
}

async function createSessionAndTurn(runtime: ChatRuntime, acp: any): Promise<void> {
    await runtime.handleMessage(URI, { type: 'chat.createSession', data: { name: 'S1', mode: 'build' } });
    // A turn that interleaves text and a tool call, as opencode streams it.
    acp.emit('turnComplete', {
        sessionId: 'session-1',
        text: 'AB',
        model: 'model-a',
        parts: [
            { type: 'text', text: 'A' },
            { type: 'tool', id: 'tc1', title: 'read', status: 'completed' },
            { type: 'text', text: 'B' }
        ]
    });
}

describe('restored transcript keeps tool calls and part boundaries', () => {
    it('(a) tool-call parts survive into the restored history payload', async () => {
        const { runtime, posts, acp } = makeRuntime();
        await createSessionAndTurn(runtime, acp);
        await runtime.handleMessage(URI, { type: 'chat.loadSession', data: { sessionId: 'session-1' } });

        const history = posts.filter(p => p.payload.type === 'chat.sessionHistory').pop();
        const messages: any[] = history!.payload.data.messages;
        const tool = messages.find(m => m.role === 'tool');
        expect(tool).toBeDefined();
        expect(tool.toolName).toBe('read');
    });

    it('(b) assistant text parts are not merged across the tool boundary', async () => {
        const { runtime, posts, acp } = makeRuntime();
        await createSessionAndTurn(runtime, acp);
        await runtime.handleMessage(URI, { type: 'chat.loadSession', data: { sessionId: 'session-1' } });

        const history = posts.filter(p => p.payload.type === 'chat.sessionHistory').pop();
        const messages: any[] = history!.payload.data.messages;
        const assistantTexts = messages.filter(m => m.role === 'assistant').map(m => m.content);
        expect(assistantTexts).toEqual(['A', 'B']);
        // No run-on message that concatenates across the tool call.
        expect(assistantTexts).not.toContain('AB');
    });
});

describe('a session loaded again', () => {
    /** The agent, restarted, says the session is in `said`; it takes a mode it is told unless `refuses`. */
    function agentSaying(acp: any, said: 'plan' | 'build', refuses = false) {
        let mode = said;
        acp.getSessionMode = () => mode;
        acp.setSessionMode = vi.fn(async (_id: string, m: 'plan' | 'build') => {
            if (refuses) throw new Error('no such mode');
            mode = m;
        });
    }

    it('is in the mode last chosen for it: the agent, saying another, is told', async () => {
        const { runtime, posts, acp } = makeRuntime();
        await createSessionAndTurn(runtime, acp);
        await runtime.handleMessage(URI, { type: 'chat.setMode', data: { sessionId: 'session-1', mode: 'plan' } });
        agentSaying(acp, 'build');
        await runtime.handleMessage(URI, { type: 'chat.loadSession', data: { sessionId: 'session-1' } });
        expect(acp.setSessionMode).toHaveBeenCalledWith('session-1', 'plan');
        const history = posts.filter(p => p.payload.type === 'chat.sessionHistory').pop();
        expect(history!.payload.data.mode).toBe('plan');
    });

    it('tells the agent nothing when it says the mode last chosen', async () => {
        const { runtime, acp } = makeRuntime();
        await createSessionAndTurn(runtime, acp);
        agentSaying(acp, 'build');
        await runtime.handleMessage(URI, { type: 'chat.loadSession', data: { sessionId: 'session-1' } });
        expect(acp.setSessionMode).not.toHaveBeenCalled();
    });

    it("shows, and stores, the agent's mode when it does not take the one chosen", async () => {
        const { runtime, posts, acp } = makeRuntime();
        await createSessionAndTurn(runtime, acp);
        await runtime.handleMessage(URI, { type: 'chat.setMode', data: { sessionId: 'session-1', mode: 'plan' } });
        agentSaying(acp, 'build', true);
        await runtime.handleMessage(URI, { type: 'chat.loadSession', data: { sessionId: 'session-1' } });
        const history = posts.filter(p => p.payload.type === 'chat.sessionHistory').pop();
        expect(history!.payload.data.mode).toBe('build');
        expect((runtime as any).sessions.getSession('session-1')?.mode).toBe('build');
    });
});
