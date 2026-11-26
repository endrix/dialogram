/**
 * The chat follows its connector as it is set: a change of the setting naming
 * it (or of a connectors file) is checked at once, and when it names another
 * agent the running one is stopped, once the answer on its way ends, and every
 * open panel connects to the new one. Before, the agent was the one resolved
 * when the window's chat first started, until the window was reloaded, and a
 * connector named wrong was only found at the next connect.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { ChatRuntime, agentKey } from '../src/extension/chat/chat-runtime';
import type { AcpAgentSpec } from '../src/extension/acp-client';
import type { ChatPayload } from '../src/api';

const URI = 'file:///tmp/flow.py';
const spec = (name: string): AcpAgentSpec => ({ name, argv: [`${name}-acp`] });

function makeRuntime() {
    const posts: Array<{ uri: string; payload: ChatPayload }> = [];
    const context = { workspaceState: { get: (_k: string, d?: unknown) => d, update: async () => undefined, keys: () => [] } } as any;
    let choose: () => Promise<AcpAgentSpec | undefined> = async () => spec('opencode');
    let changed: (() => void) | undefined;
    let watching = 0;
    const runtime = new ChatRuntime(context, {
        key: 'test',
        displayName: 'Test',
        settingsSection: 'test.chat',
        acpAgent: () => choose(),
        acpAgentSetting: 'test.acp.connector',
        watchAcpAgent: (listener: () => void) => {
            changed = listener;
            watching++;
            return { dispose: () => { watching--; } };
        }
    } as any, (uri, payload) => posts.push({ uri, payload }));

    const acp = (runtime as any).acp;
    let connected = false;
    const started: string[] = [];
    let idle: Promise<void> = Promise.resolve();
    acp.isClientConnected = () => connected;
    acp.start = async (_cwd: string, agent?: AcpAgentSpec) => {
        started.push(agent?.name ?? 'default');
        connected = true;
    };
    acp.stop = vi.fn(() => {
        connected = false;
        acp.emit('disconnected');
    });
    acp.whenIdle = () => idle;
    acp.warmUpModelCatalog = async () => undefined;
    acp.listProviders = async () => [];
    return {
        runtime, posts, acp, started,
        choose: (next: () => Promise<AcpAgentSpec | undefined>) => { choose = next; },
        change: () => changed!(),
        holdTurn: (until: Promise<void>) => { idle = until; },
        watching: () => watching
    };
}

/** The connection statuses the panel was sent, in order. */
const statuses = (posts: Array<{ payload: ChatPayload }>) =>
    posts.filter(p => p.payload.type === 'chat.connectionStatus').map(p => (p.payload.data as any).connected);

describe('the chat\'s agent, when its connector is set', () => {
    beforeEach(() => vi.useFakeTimers());
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
        expect(statuses(t.posts).slice(-2)).toEqual([false, true]);
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
        let endTurn!: () => void;
        t.holdTurn(new Promise<void>(resolve => { endTurn = resolve; }));

        t.choose(async () => spec('claude'));
        t.change();
        await vi.advanceTimersByTimeAsync(400);
        expect(t.acp.stop).not.toHaveBeenCalled();

        endTurn();
        await vi.advanceTimersByTimeAsync(0);
        expect(t.started).toEqual(['opencode', 'claude']);
    });

    it('says at once why a connector cannot be spawned, with the way to its setting, and the panel says it too', async () => {
        const warn = vi.spyOn(vscode.window, 'showWarningMessage');
        const t = makeRuntime();
        await t.runtime.handleMessage(URI, { type: 'chat.ready' });

        t.choose(async () => { throw new Error('ACP connector "claud" is not known (known: claude, opencode)'); });
        t.change();
        await vi.advanceTimersByTimeAsync(400);

        expect(warn).toHaveBeenCalledWith('Test chat: ACP connector "claud" is not known (known: claude, opencode)', 'Open Settings');
        // The old agent is not kept talking under a setting that names another.
        expect(t.acp.stop).toHaveBeenCalledTimes(1);
        const last = t.posts.filter(p => p.payload.type === 'chat.connectionStatus').pop()!.payload.data as any;
        expect(last.connected).toBe(false);
        expect(String(last.reason)).toContain('"claud" is not known');
        warn.mockRestore();
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
        expect(statuses(t.posts).pop()).toBe(true);
    });

    it('applies a burst of changes once, after they settle', async () => {
        const t = makeRuntime();
        await t.runtime.handleMessage(URI, { type: 'chat.ready' });

        t.choose(async () => spec('claude'));
        t.change();
        t.change();
        t.change();
        await vi.advanceTimersByTimeAsync(400);

        expect(t.started).toEqual(['opencode', 'claude']);
    });

    it('puts a message to a chat the new agent cannot open back, saying why, not to the agent', async () => {
        const t = makeRuntime();
        let agent = 'opencode';
        Object.defineProperty(t.acp, 'agent', { get: () => agent, configurable: true });
        t.acp.getAllSessions = () => [{ id: 'ses_old' }];
        t.acp.getSession = () => undefined;
        t.acp.sendPrompt = vi.fn(async () => undefined);
        const sessions = (t.runtime as any).sessions;
        sessions.loadSession = async () => null;
        sessions.isGone = async () => false;
        await t.runtime.handleMessage(URI, { type: 'chat.ready' });

        t.choose(async () => { agent = 'claude'; return spec('claude'); });
        t.change();
        await vi.advanceTimersByTimeAsync(400);
        await t.runtime.handleMessage(URI, { type: 'chat.sendMessage', data: { sessionId: 'ses_old', text: 'go on' } });

        expect(t.acp.sendPrompt).not.toHaveBeenCalled();
        const refused = t.posts.find(p => p.payload.type === 'chat.messageNotSent')!.payload.data as any;
        expect(refused).toEqual({ sessionId: 'ses_old', reason: 'this chat was with opencode, and claude cannot open it; start a new chat' });
    });

    it('starts an agent that went away again on the next connect', async () => {
        const t = makeRuntime();
        await t.runtime.handleMessage(URI, { type: 'chat.ready' });

        t.acp.stop();
        await t.runtime.handleMessage(URI, { type: 'chat.ready' });

        expect(t.started).toEqual(['opencode', 'opencode']);
    });

    it('stops watching when it is disposed', () => {
        const t = makeRuntime();
        expect(t.watching()).toBe(1);
        t.runtime.dispose();
        expect(t.watching()).toBe(0);
    });

    it('tells agents apart by what they run', () => {
        expect(agentKey(spec('claude'))).toBe(agentKey(spec('claude')));
        expect(agentKey(spec('claude'))).not.toBe(agentKey({ ...spec('claude'), env: { A: '1' } }));
        expect(agentKey(undefined)).toBe('opencode');
    });
});
