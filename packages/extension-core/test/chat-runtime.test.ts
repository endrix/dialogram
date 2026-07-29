/**
 * Message-contract tests for ChatRuntime (the diagram-profile chat path).
 *
 * The critical contract, inherited from the proven chatbox handler: only the
 * `chat.ready` handshake reports `chat.connectionStatus`. Data requests such as
 * `chat.getProviders` must reply with their data ONLY — the chat panel re-fetches
 * providers/sessions whenever it sees a connected status, so a status echoed on
 * `chat.getProviders` creates an unbounded webview↔host ping-pong
 * (status → getProviders → status → …) that floods the channel and freezes the
 * extension host.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { ChatRuntime } from '../src/extension/chat/chat-runtime';
import type { ChatPayload } from '../src/api';

const URI = 'file:///tmp/example.mlir';

function makeRuntime(config: Record<string, any> = {}) {
    const posts: Array<{ uri: string; payload: ChatPayload }> = [];
    const memento = {
        get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue,
        update: async (): Promise<void> => undefined,
        keys: (): string[] => []
    };
    const context = { workspaceState: memento } as any;
    const fullConfig = {
        key: 'test',
        displayName: 'Test',
        settingsSection: 'test.chat',
        ...config
    } as any;
    const runtime = new ChatRuntime(context, fullConfig, (uri, payload) =>
        posts.push({ uri, payload })
    );

    // Stub the ACP client as already connected so no process is spawned.
    const acp = (runtime as any).acp;
    acp.isClientConnected = () => true;
    acp.warmUpModelCatalog = async () => undefined;
    acp.listProviders = async () => [{ id: 'model-a', name: 'Model A' }];
    // Stubs so the slash-dispatch path can create/resolve a session without a
    // real agent process (each returns benignly).
    acp.start = async () => undefined;
    acp.createSession = async () => 'session-1';
    acp.getSession = () => ({ id: 'session-1' });
    acp.setSessionMode = async () => undefined;
    acp.setProvider = async () => undefined;
    acp.sendPrompt = async () => undefined;

    return { runtime, posts, acp };
}

describe('ChatRuntime message contract', () => {
    let runtime: ChatRuntime;
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

describe('unified runtime absorbed features', () => {
    it('config: constructs from ChatRuntimeConfig with slash commands', async () => {
        const handler = vi.fn(async () => ({ success: true }));
        const { runtime, posts } = makeRuntime({
            slashCommands: [{ command: 'ping', description: 'test', modes: ['build'], handler }]
        });
        await runtime.handleMessage('file:///ws/wf.py', { type: 'chat.getCommands', data: { mode: 'build' } });
        const cmds = posts.find(p => p.payload.type === 'chat.commands');
        expect(cmds!.payload.data.commands.map((c: any) => c.command)).toEqual(
            expect.arrayContaining(['ping', 'help'])
        );
    });

    it('slash input runs the contribution handler and posts the system confirmation', async () => {
        const handler = vi.fn(async () => ({ success: true }));
        const { runtime, posts } = makeRuntime({
            slashCommands: [{ command: 'ping', description: 'test', modes: ['build'], handler }]
        });
        await runtime.handleMessage('file:///ws/wf.py', {
            type: 'chat.sendMessage',
            data: { text: '/ping now', mode: 'build' }
        });
        expect(handler).toHaveBeenCalledWith(
            { _positional: ['now'] },
            expect.objectContaining({ file: expect.stringContaining('wf.py'), selectedNodeIds: [] })
        );
        const sys = posts.find(p => p.payload.type === 'chat.message');
        expect(sys!.payload.data.content).toBe('✓ Executed: /ping');
        expect(sys!.payload.data.role).toBe('system');
    });

    it('slash failure posts a system error message, not a thrown error', async () => {
        const { runtime, posts } = makeRuntime({
            slashCommands: [
                { command: 'boom', description: 't', modes: ['build'], handler: async () => ({ success: false, error: 'nope' }) }
            ]
        });
        await runtime.handleMessage('file:///ws/wf.py', {
            type: 'chat.sendMessage',
            data: { text: '/boom', mode: 'build' }
        });
        const sys = posts.find(p => p.payload.type === 'chat.message');
        expect(sys!.payload.data.content).toBe('Error: nope');
    });

    it('selection travels into the slash handler context', async () => {
        const handler = vi.fn(async () => ({ success: true }));
        const { runtime } = makeRuntime({
            slashCommands: [{ command: 'sel', description: 't', modes: ['build'], handler }]
        });
        await runtime.handleMessage('file:///ws/wf.py', {
            type: 'chat.selection',
            data: { selectedNodeIds: ['n1', 'n2'] }
        });
        await runtime.handleMessage('file:///ws/wf.py', {
            type: 'chat.sendMessage',
            data: { text: '/sel', mode: 'build' }
        });
        expect(handler).toHaveBeenCalledWith({}, expect.objectContaining({ selectedNodeIds: ['n1', 'n2'] }));
    });

    it('unknown /command errors with a /help hint and never reaches the agent (chat-only pass-through config)', async () => {
        // Chat-only profiles contribute pass-through suggestions (no handler);
        // an unknown /command must resolve to the error + /help hint on ALL
        // profiles rather than being forwarded to the agent.
        const { runtime, posts, acp } = makeRuntime({
            slashCommands: [{ command: 'render', description: 'render the doc', modes: ['build'] }]
        });
        acp.sendPrompt = vi.fn(async () => undefined);
        await runtime.handleMessage('file:///ws/wf.py', {
            type: 'chat.sendMessage',
            data: { text: '/definitely-not-a-command', mode: 'build' }
        });
        const sys = posts.find(
            p => p.payload.type === 'chat.message' && p.payload.data.role === 'system'
        );
        expect(sys!.payload.data.content).toMatch(/^Error: Unknown command: definitely-not-a-command/);
        expect(sys!.payload.data.content).toContain('/help');
        expect(acp.sendPrompt).not.toHaveBeenCalled();
    });

    it('chat.log lands in the output channel without erroring', async () => {
        const { runtime } = makeRuntime({});
        await expect(
            runtime.handleMessage('file:///ws/wf.py', { type: 'chat.log', data: { message: 'from webview' } })
        ).resolves.toBeUndefined();
    });

    it('chat.ready posts an immediate connection status before connecting', async () => {
        const { runtime, posts, acp } = makeRuntime({});
        // Simulate a not-yet-connected agent so the immediate status reflects the
        // pre-connect (disconnected) reality the panel must see instantly.
        acp.isClientConnected = () => false;
        await runtime.handleMessage('file:///ws/wf.py', { type: 'chat.ready', data: {} });
        const status = posts.filter(p => p.payload.type === 'chat.connectionStatus');
        expect(status.length).toBeGreaterThanOrEqual(1);
        expect(status[0].payload.data).toEqual(expect.objectContaining({ connected: false }));
    });
});

describe('new-session input box (single source of truth + duplicate guard)', () => {
    it('pre-fills the helper default and validateInput rejects existing names', async () => {
        const { runtime, acp } = makeRuntime();
        const file = '/ws/wf.py';
        const uri = `file://${file}`;

        // Seed a gap-y session list (Session 1, Session 3) so a naive count-based
        // default would collide — the fix must use the shared helper instead.
        let counter = 0;
        acp.createSession = async () => `id-${++counter}`;
        acp.getSession = () => ({ provider: undefined });
        acp.deleteSession = async () => undefined;
        const sessions = (runtime as any).sessions;
        await sessions.createSession(file); // Session 1
        await sessions.createSession(file); // Session 2
        await sessions.createSession(file); // Session 3
        await sessions.deleteSession('id-2'); // gap

        const captured: any[] = [];
        const spy = vi
            .spyOn(vscode.window, 'showInputBox')
            .mockImplementation(async (opts: any) => {
                captured.push(opts);
                return undefined; // user cancels; we only inspect the options
            });
        try {
            await runtime.handleMessage(uri, { type: 'chat.createSession', data: {} });
        } finally {
            spy.mockRestore();
        }

        expect(captured).toHaveLength(1);
        const opts = captured[0];
        // The default equals the helper's value exactly — no second resolver.
        expect(opts.value).toBe(sessions.nextDefaultSessionName(file));
        expect(opts.value).toBe('Session 4');
        // validateInput rejects a name already in use for this workflow…
        expect(opts.validateInput('Session 1')).toBe(
            'A session named "Session 1" already exists'
        );
        // …but accepts the free default (and any unused name).
        expect(opts.validateInput('Session 4')).toBeUndefined();
        expect(opts.validateInput('Fresh')).toBeUndefined();
    });
});

describe('connect watchdog (30 s dialog on stuck connection)', () => {
    it('shows a warning dialog when still disconnected 30 s after the handshake', async () => {
        vi.useFakeTimers();
        const warn = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined as any);
        try {
            const { runtime } = makeRuntime({});
            const acp = (runtime as any).acp;
            acp.isClientConnected = () => false;
            acp.start = () => new Promise(() => undefined); // spawn hangs forever

            void runtime.handleMessage('file:///ws/wf.py', { type: 'chat.ready', data: {} });
            expect(warn).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(30_000);

            expect(warn).toHaveBeenCalledTimes(1);
            expect(String(warn.mock.calls[0][0])).toContain('30 seconds');
            runtime.dispose();
        } finally {
            warn.mockRestore();
            vi.useRealTimers();
        }
    });

    it('does not warn when the connection succeeds before the deadline', async () => {
        vi.useFakeTimers();
        const warn = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined as any);
        try {
            const { runtime } = makeRuntime({});
            const acp = (runtime as any).acp;
            acp.isClientConnected = () => false;
            acp.start = async () => undefined; // spawn succeeds immediately

            await runtime.handleMessage('file:///ws/wf.py', { type: 'chat.ready', data: {} });
            await vi.advanceTimersByTimeAsync(31_000);

            expect(warn).not.toHaveBeenCalled();
            runtime.dispose();
        } finally {
            warn.mockRestore();
            vi.useRealTimers();
        }
    });

    it('warns at most once per runtime even across repeated handshakes', async () => {
        vi.useFakeTimers();
        const warn = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined as any);
        try {
            const { runtime } = makeRuntime({});
            const acp = (runtime as any).acp;
            acp.isClientConnected = () => false;
            acp.start = () => new Promise(() => undefined);

            void runtime.handleMessage('file:///ws/a.py', { type: 'chat.ready', data: {} });
            await vi.advanceTimersByTimeAsync(30_000);
            void runtime.handleMessage('file:///ws/b.py', { type: 'chat.ready', data: {} });
            await vi.advanceTimersByTimeAsync(30_000);

            expect(warn).toHaveBeenCalledTimes(1);
            runtime.dispose();
        } finally {
            warn.mockRestore();
            vi.useRealTimers();
        }
    });
});
