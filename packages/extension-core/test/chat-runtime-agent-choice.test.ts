/**
 * The chat follows its connector as it is set: a change of the setting naming
 * it (or of a connectors file) is checked at once, and when it names another
 * agent the running one is stopped, once the answers on their way end, and
 * every open panel connects to the new one. Before, the agent was the one
 * resolved when the window's chat first started, until the window was
 * reloaded, and a connector named wrong was only found at the next connect.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { ChatRuntime, agentKey } from '../src/extension/chat/chat-runtime';
import type { AcpAgentSpec } from '../src/extension/acp-client';
import type { AcpConnectorChange } from '../src/extension/chat/acp-connectors';
import type { ChatPayload } from '../src/api';

const URI = 'file:///tmp/flow.py';
const spec = (name: string): AcpAgentSpec => ({ name, argv: [`${name}-acp`] });

function makeRuntime() {
    const posts: Array<{ uri: string; payload: ChatPayload }> = [];
    const context = { workspaceState: { get: (_k: string, d?: unknown) => d, update: async () => undefined, keys: () => [] } } as any;
    let choose: () => Promise<AcpAgentSpec | undefined> = async () => spec('opencode');
    let changed: ((change: AcpConnectorChange) => void) | undefined;
    let watching = 0;
    const runtime = new ChatRuntime(context, {
        key: 'test',
        displayName: 'Test',
        settingsSection: 'test.chat',
        acpAgent: () => choose(),
        acpAgentSetting: 'test.acp.connector',
        watchAcpAgent: (listener: (change: AcpConnectorChange) => void) => {
            changed = listener;
            watching++;
            return { dispose: () => { watching--; } };
        }
    } as any, (uri, payload) => posts.push({ uri, payload }));

    const acp = (runtime as any).acp;
    let connected = false;
    let agent = 'opencode';
    const started: string[] = [];
    /** The agent each prompt went to. */
    const promptedTo: string[] = [];
    let answer: () => Promise<void> = async () => undefined;
    Object.defineProperty(acp, 'agent', { get: () => agent, configurable: true });
    acp.isClientConnected = () => connected;
    acp.start = async (_cwd: string, next?: AcpAgentSpec) => {
        agent = next?.name ?? 'opencode';
        started.push(agent);
        connected = true;
        acp.emit('connected');
    };
    acp.stop = vi.fn(() => {
        connected = false;
        acp.emit('disconnected');
    });
    acp.warmUpModelCatalog = async () => undefined;
    acp.listProviders = async () => [];
    acp.getSession = (id: string) => ({ id });
    acp.getAllSessions = () => [];
    acp.getSessionMode = () => 'build';
    acp.cancelPrompt = vi.fn(async () => undefined);
    acp.sendPrompt = vi.fn(async () => {
        promptedTo.push(agent);
        await answer();
    });
    const sessions = (runtime as any).sessions;
    sessions.isGone = async () => false;
    sessions.addMessageToSession = () => undefined;
    return {
        runtime, posts, acp, sessions, started, promptedTo,
        choose: (next: () => Promise<AcpAgentSpec | undefined>) => { choose = next; },
        change: (change: AcpConnectorChange = 'setting') => changed!(change),
        /** Prompts from now on are answered when the returned function is called. */
        holdAnswers: () => {
            let release!: () => void;
            const answered = new Promise<void>(resolve => { release = resolve; });
            answer = () => answered;
            return release;
        },
        send: (text: string) => runtime.handleMessage(URI, { type: 'chat.sendMessage', data: { sessionId: 'session-1', text } }),
        watching: () => watching
    };
}

/** Let the work started settle, I/O included, until `done` holds. */
async function until(done: () => boolean): Promise<void> {
    for (let i = 0; i < 500 && !done(); i++) {
        await new Promise(resolve => setImmediate(resolve));
    }
}

/** The connection statuses the panel was sent, in order. */
const statuses = (posts: Array<{ payload: ChatPayload }>) =>
    posts.filter(p => p.payload.type === 'chat.connectionStatus').map(p => p.payload.data as any);

describe('the chat\'s agent, when its connector is set', () => {
    beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
    afterEach(() => vi.useRealTimers());

    it('moves an open panel to the agent the setting names now, without a reload', async () => {
        const t = makeRuntime();
        await t.runtime.handleMessage(URI, { type: 'chat.ready' });
        expect(t.started).toEqual(['opencode']);

        t.choose(async () => spec('claude'));
        t.change();
        await vi.advanceTimersByTimeAsync(400);

        expect(t.acp.stop).toHaveBeenCalledTimes(1);
        expect(t.started).toEqual(['opencode', 'claude']);
        // Disconnected from the old agent, then connected to the new.
        expect(statuses(t.posts).slice(-2).map(s => s.connected)).toEqual([false, true]);
    });

    it('keeps the agent when the change leaves it the one running', async () => {
        const t = makeRuntime();
        await t.runtime.handleMessage(URI, { type: 'chat.ready' });

        t.change();
        await vi.advanceTimersByTimeAsync(400);

        expect(t.acp.stop).not.toHaveBeenCalled();
        expect(t.started).toEqual(['opencode']);
    });

    it('lets the answer on its way end before the agent is stopped', async () => {
        const t = makeRuntime();
        await t.runtime.handleMessage(URI, { type: 'chat.ready' });
        const answer = t.holdAnswers();
        const sending = t.send('slow');
        await until(() => t.promptedTo.length > 0);
        expect(t.promptedTo).toEqual(['opencode']);

        t.choose(async () => spec('claude'));
        t.change();
        await vi.advanceTimersByTimeAsync(400);
        expect(t.acp.stop).not.toHaveBeenCalled();

        answer();
        await sending;
        await vi.advanceTimersByTimeAsync(0);
        expect(t.started).toEqual(['opencode', 'claude']);
    });

    it('sends a message that arrives during the change to the new agent', async () => {
        const t = makeRuntime();
        await t.runtime.handleMessage(URI, { type: 'chat.ready' });
        const answer = t.holdAnswers();
        const first = t.send('slow');
        await until(() => t.promptedTo.length > 0);
        t.choose(async () => spec('claude'));
        t.change();
        await vi.advanceTimersByTimeAsync(400);

        // The change waits for the first answer; the second message waits for the change.
        const second = t.send('next');
        await until(() => t.promptedTo.length > 1);
        expect(t.promptedTo).toEqual(['opencode']);

        answer();
        await first;
        await second;
        expect(t.promptedTo).toEqual(['opencode', 'claude']);
    });

    it('cancels an answer still on its way after the grace, then moves', async () => {
        const t = makeRuntime();
        await t.runtime.handleMessage(URI, { type: 'chat.ready' });
        const answer = t.holdAnswers();
        t.acp.cancelPrompt = vi.fn(async () => answer());
        const sending = t.send('never ends');
        await until(() => t.promptedTo.length > 0);

        t.choose(async () => spec('claude'));
        t.change();
        await vi.advanceTimersByTimeAsync(400 + 59_000);
        expect(t.acp.cancelPrompt).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1_000);

        expect(t.acp.cancelPrompt).toHaveBeenCalledWith('session-1');
        await sending;
        await vi.advanceTimersByTimeAsync(0);
        expect(t.started).toEqual(['opencode', 'claude']);
    });

    it('says at once why a connector cannot be spawned, with the way to its setting, and once', async () => {
        const warn = vi.spyOn(vscode.window, 'showWarningMessage');
        const t = makeRuntime();
        await t.runtime.handleMessage(URI, { type: 'chat.ready' });

        t.choose(async () => { throw new Error('ACP connector "claud" is not known (known: claude, opencode)'); });
        t.change();
        await vi.advanceTimersByTimeAsync(400);
        t.change('file');
        await vi.advanceTimersByTimeAsync(400);

        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith('Test chat: ACP connector "claud" is not known (known: claude, opencode)', 'Open Settings');
        // The old agent is not kept talking under a setting that names another.
        expect(t.acp.stop).toHaveBeenCalledTimes(1);
        // The panel says why, and does not blame the agent that ran before.
        const last = statuses(t.posts).pop()!;
        expect(last.connected).toBe(false);
        expect(String(last.reason)).toBe('ACP connector "claud" is not known (known: claude, opencode)');
        expect(last).not.toHaveProperty('agent');
        const error = t.posts.filter(p => p.payload.type === 'chat.error').pop()!.payload.data as any;
        expect(error.message).toBe('Could not start the chat agent: ACP connector "claud" is not known (known: claude, opencode)');
        warn.mockRestore();
    });

    it('only logs a wrong connector when a connectors file changes with no chat about', async () => {
        const warn = vi.spyOn(vscode.window, 'showWarningMessage');
        const folders = Object.getOwnPropertyDescriptor(vscode.workspace, 'workspaceFolders');
        Object.defineProperty(vscode.workspace, 'workspaceFolders', { value: [{ uri: { fsPath: '/tmp' } }], configurable: true });
        try {
            const t = makeRuntime();
            t.choose(async () => { throw new Error('ACP connector "claud" is not known'); });

            t.change('file');
            await vi.advanceTimersByTimeAsync(400);
            expect(warn).not.toHaveBeenCalled();

            t.change('setting');
            await vi.advanceTimersByTimeAsync(400);
            expect(warn).toHaveBeenCalledTimes(1);
        } finally {
            if (folders) Object.defineProperty(vscode.workspace, 'workspaceFolders', folders);
            else delete (vscode.workspace as any).workspaceFolders;
            warn.mockRestore();
        }
    });

    it('connects the panels once a connector that could not be spawned is set right', async () => {
        const t = makeRuntime();
        t.choose(async () => { throw new Error('ACP connector "claud" is not known'); });
        await t.runtime.handleMessage(URI, { type: 'chat.ready' });
        expect(t.started).toEqual([]);

        t.choose(async () => spec('claude'));
        t.change();
        await vi.advanceTimersByTimeAsync(400);

        expect(t.started).toEqual(['claude']);
        expect(statuses(t.posts).pop()!.connected).toBe(true);
    });

    it('applies a burst of changes once, after they settle', async () => {
        const t = makeRuntime();
        await t.runtime.handleMessage(URI, { type: 'chat.ready' });

        t.choose(async () => spec('claude'));
        t.change();
        t.change('file');
        t.change();
        await vi.advanceTimersByTimeAsync(400);

        expect(t.started).toEqual(['opencode', 'claude']);
    });

    it('puts a message to a chat the new agent cannot open back, saying why, not to the agent', async () => {
        const t = makeRuntime();
        t.acp.getAllSessions = () => [{ id: 'ses_old' }];
        await t.runtime.handleMessage(URI, { type: 'chat.ready' });
        t.acp.getSession = () => undefined;
        t.sessions.loadSession = async () => null;

        t.choose(async () => spec('claude'));
        t.change();
        await vi.advanceTimersByTimeAsync(400);
        await t.runtime.handleMessage(URI, { type: 'chat.sendMessage', data: { sessionId: 'ses_old', text: 'go on' } });

        expect(t.acp.sendPrompt).not.toHaveBeenCalled();
        const refused = t.posts.find(p => p.payload.type === 'chat.messageNotSent')!.payload.data as any;
        expect(refused).toEqual({ sessionId: 'ses_old', reason: 'this chat was with opencode, and claude cannot open it; start a new chat' });
    });

    it('knows a stored chat\'s agent too, from before a reload', async () => {
        const t = makeRuntime();
        t.choose(async () => spec('claude'));
        await t.runtime.handleMessage(URI, { type: 'chat.ready' });
        t.acp.getSession = () => undefined;
        t.sessions.loadSession = async () => null;
        t.sessions.getSession = (id: string) => ({ id, agent: 'opencode' });

        await t.runtime.handleMessage(URI, { type: 'chat.sendMessage', data: { sessionId: 'ses_stored', text: 'go on' } });

        expect(t.acp.sendPrompt).not.toHaveBeenCalled();
        const refused = t.posts.find(p => p.payload.type === 'chat.messageNotSent')!.payload.data as any;
        expect(refused.reason).toBe('this chat was with opencode, and claude cannot open it; start a new chat');
    });

    it('starts an agent that went away again on the next connect', async () => {
        const t = makeRuntime();
        await t.runtime.handleMessage(URI, { type: 'chat.ready' });

        t.acp.stop();
        await t.runtime.handleMessage(URI, { type: 'chat.ready' });

        expect(t.started).toEqual(['opencode', 'opencode']);
    });

    it('does not take an agent that went away while it started as started', async () => {
        const t = makeRuntime();
        const ensureMcpServer = (t.runtime as any).ensureMcpServer.bind(t.runtime);
        let first = true;
        (t.runtime as any).ensureMcpServer = async () => {
            await ensureMcpServer();
            if (first) {
                first = false;
                t.acp.stop();
            }
        };
        await t.runtime.handleMessage(URI, { type: 'chat.ready' });
        expect((t.runtime as any).started).toBe(false);

        await t.runtime.handleMessage(URI, { type: 'chat.ready' });
        expect(t.started).toEqual(['opencode', 'opencode']);
        expect((t.runtime as any).started).toBe(true);
    });

    it('stops watching when it is disposed', () => {
        const t = makeRuntime();
        expect(t.watching()).toBe(1);
        t.runtime.dispose();
        expect(t.watching()).toBe(0);
    });

    it('tells agents apart by what they spawn', () => {
        expect(agentKey(spec('claude'))).toBe(agentKey(spec('claude')));
        expect(agentKey(spec('claude'))).not.toBe(agentKey({ ...spec('claude'), env: { A: '1' } }));
        // None, or one without a command, is opencode, as the client spawns it.
        const opencode = { name: 'opencode', argv: ['opencode', 'acp'], httpApi: true };
        expect(agentKey(undefined)).toBe(agentKey(opencode));
        expect(agentKey({ name: 'x', argv: [] })).toBe(agentKey(undefined));
    });
});
