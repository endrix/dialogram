/**
 * The chat's own session in the agent's CLI is a hand-over, not a second
 * client: the chat's agent is stopped before the terminal opens the session,
 * and started again, with the session loaded, when the chat takes it back.
 * One client holds a session at a time. Codex refuses a second ("thread ...
 * already has an active writer"); the other agents would be written to from
 * two sides.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { ChatRuntime } from '../src/extension/chat/chat-runtime';
import { clipboardWrites, closeTerminal, createdTerminals } from './vscode-mock';

const URI = 'file:///w/top.py';
const OTHER = 'file:///w/other.py';

interface Options {
    resume?: string | null;
    /** How many times the agent refuses the load when the chat returns. */
    refusals?: number;
    held?: string[];
}

function makeRuntime(options: Options = {}) {
    const posts: Array<{ uri: string; type: string; data: any }> = [];
    /** What was done, in order: the agent's stop, start and loads, and the terminals. */
    const done: string[] = [];
    const memento = {
        get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue,
        update: async (): Promise<void> => undefined,
        keys: (): string[] => []
    };
    const runtime = new ChatRuntime(
        { workspaceState: memento } as any,
        { key: 'test', displayName: 'Test', settingsSection: 'test.chat' } as any,
        (uri, payload) => void posts.push({ uri, type: payload.type, data: payload.data }),
        () => true
    );
    let refusals = options.refusals ?? 0;
    const held = new Set(options.held ?? ['s1']);
    const acp = {
        agent: 'codex',
        resumeTemplate: options.resume === null ? undefined : (options.resume ?? 'codex resume {sessionId}'),
        connected: true,
        prompts: [] as string[],
        sessionCwd: () => '/w',
        isClientConnected: () => acp.connected,
        takesImages: () => undefined,
        getAllSessions: () => [...held].map(id => ({ id })),
        isSessionLoaded: (id: string) => held.has(id),
        getSession: (id: string) => ({ id }),
        getSessionMode: () => 'build',
        getSessionModel: () => undefined,
        setSessionMode: async (): Promise<void> => undefined,
        stopAndWait: async (): Promise<void> => {
            done.push('stop');
            acp.connected = false;
        },
        start: async (): Promise<void> => {
            done.push('start');
            acp.connected = true;
        },
        loadSession: async (id: string): Promise<void> => {
            if (refusals > 0) {
                refusals -= 1;
                done.push(`load ${id} refused`);
                throw new Error('This Codex session is in use by another Codex client');
            }
            done.push(`load ${id}`);
        },
        sendPrompt: async (id: string, text: string): Promise<void> => {
            done.push(`prompt ${id}`);
            acp.prompts.push(text);
        },
        listProviders: async () => [],
        warmUpModelCatalog: async (): Promise<void> => undefined
    };
    (runtime as any).acp = acp;
    (runtime as any).started = true;
    // The session manager asks the agent through its own reference.
    (runtime as any).sessions.acpClient = acp;
    const originalCreate = createdTerminals.push.bind(createdTerminals);
    createdTerminals.push = (...records: any[]) => {
        done.push('terminal');
        return originalCreate(...records);
    };
    const types = (uri?: string) => posts.filter(p => !uri || p.uri === uri).map(p => p.type);
    const last = (type: string) => [...posts].reverse().find(p => p.type === type);
    return { runtime, posts, done, acp, types, last };
}

async function handOver(runtime: ChatRuntime, sessionId = 's1'): Promise<void> {
    await runtime.handleMessage(URI, { type: 'chat.openSessionNatively', data: { sessionId } });
}

beforeEach(() => {
    createdTerminals.length = 0;
    clipboardWrites.length = 0;
    delete (createdTerminals as any).push;
});

describe('handing the chat’s session over to the agent’s CLI', () => {
    it('stops the chat’s agent before the terminal opens the session', async () => {
        const { runtime, done, last } = makeRuntime();
        await handOver(runtime);
        expect(done).toEqual(['stop', 'terminal']);
        expect(createdTerminals[0].sent).toEqual(['codex resume s1']);
        expect(last('chat.handedOver')?.data).toEqual({ sessionId: 's1', agent: 'codex', terminalOpen: true });
    });

    it('tells every panel, and before the agent is stopped', async () => {
        const { runtime, posts, acp } = makeRuntime();
        await runtime.handleMessage(OTHER, { type: 'chat.log', data: { message: 'here' } });
        const stop = acp.stopAndWait;
        let toldBeforeStop: string[] = [];
        acp.stopAndWait = async () => {
            toldBeforeStop = posts.filter(p => p.type === 'chat.handedOver').map(p => p.uri);
            await stop();
        };
        await handOver(runtime);
        expect(toldBeforeStop.sort()).toEqual([OTHER, URI].sort());
    });

    it('hands nothing over without a resume command: the id is copied and the agent runs on', async () => {
        const { runtime, done, types } = makeRuntime({ resume: null });
        await handOver(runtime);
        expect(done).toEqual([]);
        expect(clipboardWrites).toEqual(['s1']);
        expect(types()).not.toContain('chat.handedOver');
    });

    it('hands nothing over while a turn is running', async () => {
        const { runtime, done, acp } = makeRuntime();
        let endTurn: () => void = () => undefined;
        acp.sendPrompt = () => new Promise<void>(resolve => (endTurn = resolve));
        const turn = runtime.handleMessage(URI, { type: 'chat.sendMessage', data: { sessionId: 's1', text: 'go' } });
        await new Promise(resolve => setTimeout(resolve, 20));
        await handOver(runtime);
        expect(done).toEqual([]);
        expect(createdTerminals).toHaveLength(0);
        endTurn();
        await turn;
        await handOver(runtime);
        expect(done).toEqual(['stop', 'terminal']);
    });

    it('shows the terminal again on a second click, and opens no second one', async () => {
        const { runtime, done } = makeRuntime();
        await handOver(runtime);
        createdTerminals[0].shown = false;
        await handOver(runtime);
        expect(done).toEqual(['stop', 'terminal']);
        expect(createdTerminals).toHaveLength(1);
        expect(createdTerminals[0].shown).toBe(true);
    });

    it('still copies the session id during the hand-over', async () => {
        const { runtime } = makeRuntime();
        await handOver(runtime);
        await runtime.handleMessage(URI, { type: 'chat.copySessionId', data: { sessionId: 's1' } });
        expect(clipboardWrites).toEqual(['s1']);
    });
});

describe('while the agent’s CLI holds the session', () => {
    it('sends no message: it goes back to the composer, and the agent is not started', async () => {
        const { runtime, done, last, acp } = makeRuntime();
        await handOver(runtime);
        done.length = 0;
        await runtime.handleMessage(URI, { type: 'chat.sendMessage', data: { sessionId: 's1', text: 'and now?' } });
        expect(done).toEqual([]);
        expect(acp.prompts).toEqual([]);
        expect(last('chat.messageNotSent')?.data).toEqual({ sessionId: 's1', reason: "the session is open in codex's CLI" });
        expect(last('chat.turnEnd')?.data).toEqual({ sessionId: 's1' });
    });

    it('starts the agent for nothing a panel asks: sessions, models, modes', async () => {
        const { runtime, done } = makeRuntime();
        await handOver(runtime);
        done.length = 0;
        for (const type of ['chat.getProviders', 'chat.createSession', 'chat.loadSession', 'chat.setMode', 'chat.setProvider', 'chat.deleteSession', 'chat.cancel']) {
            await runtime.handleMessage(URI, { type, data: { sessionId: 's1', mode: 'plan', providerId: 'm' } });
        }
        expect(done).toEqual([]);
    });

    it('tells a panel that opens where the session is, and does not connect', async () => {
        const { runtime, done, posts } = makeRuntime();
        await handOver(runtime);
        done.length = 0;
        posts.length = 0;
        await runtime.handleMessage(OTHER, { type: 'chat.ready' });
        expect(done).toEqual([]);
        const told = posts.filter(p => p.uri === OTHER).map(p => p.type);
        // The hand-over first: the panel reads the status that follows as its own.
        expect(told.slice(0, 2)).toEqual(['chat.handedOver', 'chat.connectionStatus']);
        const status = posts.find(p => p.type === 'chat.connectionStatus')!;
        expect(status.data).toEqual({ connected: false, reason: "the session is open in codex's CLI", agent: 'codex' });
    });

    it('says so when the person closes the terminal', async () => {
        const { runtime, last } = makeRuntime();
        await handOver(runtime);
        closeTerminal(createdTerminals[0]);
        expect(last('chat.handedOver')?.data).toEqual({ sessionId: 's1', agent: 'codex', terminalOpen: false });
    });
});

describe('returning to the chat', () => {
    it('closes the terminal, starts the agent and loads the session, in that order', async () => {
        const { runtime, done, last, posts } = makeRuntime();
        await handOver(runtime);
        done.length = 0;
        posts.length = 0;
        await runtime.handleMessage(URI, { type: 'chat.returnToChat', data: { sessionId: 's1' } });
        expect(createdTerminals[0].closed).toBe(true);
        expect(done).toEqual(['start', 'load s1']);
        expect(last('chat.returnedToChat')?.data).toEqual({ sessionId: 's1', agent: 'codex' });
        // Closed by the return: not said as a terminal the person closed.
        expect(posts.filter(p => p.type === 'chat.handedOver')).toEqual([]);
    });

    it('takes messages again', async () => {
        const { runtime, done, acp } = makeRuntime();
        await handOver(runtime);
        await runtime.handleMessage(URI, { type: 'chat.returnToChat', data: {} });
        done.length = 0;
        await runtime.handleMessage(URI, { type: 'chat.sendMessage', data: { sessionId: 's1', text: 'back' } });
        expect(acp.prompts).toEqual(['back']);
        // Loaded by the return: not loaded a second time before the prompt.
        expect(done).toEqual(['prompt s1']);
    });

    it('is one return when asked for twice at once: the session is loaded once', async () => {
        const { runtime, done, posts } = makeRuntime();
        await handOver(runtime);
        done.length = 0;
        await Promise.all([
            runtime.handleMessage(URI, { type: 'chat.returnToChat', data: {} }),
            runtime.handleMessage(OTHER, { type: 'chat.returnToChat', data: {} })
        ]);
        expect(done).toEqual(['start', 'load s1']);
        expect(posts.filter(p => p.type === 'chat.returnedToChat' && p.uri === URI)).toHaveLength(1);
    });

    it('asks again when the CLI has not let go of the session yet', async () => {
        const { runtime, done, last } = makeRuntime({ refusals: 2 });
        await handOver(runtime);
        done.length = 0;
        await runtime.handleMessage(URI, { type: 'chat.returnToChat', data: {} });
        expect(done).toEqual(['start', 'load s1 refused', 'load s1 refused', 'load s1']);
        expect(last('chat.returnedToChat')).toBeDefined();
    });

    it('stays handed over when the session cannot be loaded, with the agent stopped and its reason said', async () => {
        const { runtime, done, last, acp } = makeRuntime({ refusals: 99 });
        await handOver(runtime);
        done.length = 0;
        await runtime.handleMessage(URI, { type: 'chat.returnToChat', data: {} });
        expect(done[0]).toBe('start');
        expect(done[done.length - 1]).toBe('stop');
        expect(acp.connected).toBe(false);
        expect(last('chat.returnedToChat')).toBeUndefined();
        expect(last('chat.handedOver')?.data.terminalOpen).toBe(false);
        expect(last('chat.error')?.data.message).toContain('Could not return to the chat');
        expect(last('chat.error')?.data.message).toContain('in use by another Codex client');
        // And it can be tried again.
        await runtime.handleMessage(URI, { type: 'chat.sendMessage', data: { sessionId: 's1', text: 'x' } });
        expect(acp.prompts).toEqual([]);
    }, 15000);

    it('loads another session the stopped agent held before that session’s next prompt, once', async () => {
        const { runtime, done, acp } = makeRuntime({ held: ['s1', 's2'] });
        await handOver(runtime);
        await runtime.handleMessage(URI, { type: 'chat.returnToChat', data: {} });
        // The session manager knows no `s2` of its own: the load goes through it.
        const loads: string[] = [];
        (runtime as any).sessions.loadSession = async (id: string) => {
            loads.push(id);
            return { id, messages: [] };
        };
        await runtime.handleMessage(OTHER, { type: 'chat.sendMessage', data: { sessionId: 's2', text: 'one' } });
        await runtime.handleMessage(OTHER, { type: 'chat.sendMessage', data: { sessionId: 's2', text: 'two' } });
        expect(loads).toEqual(['s2']);
        expect(acp.prompts).toEqual(['one', 'two']);
        expect(done.filter(d => d.startsWith('prompt'))).toEqual(['prompt s2', 'prompt s2']);
    });

    it('shows nothing of the history the agent replays on the load, and the turn after it in full', async () => {
        const { runtime, posts, acp } = makeRuntime();
        const update = (text: string) =>
            (runtime as any).post('s1', { type: 'chat.sessionUpdate', data: { notification: { sessionId: 's1', text } } });
        // The panel owns the session: an update of a turn reaches it.
        await runtime.handleMessage(URI, { type: 'chat.sendMessage', data: { sessionId: 's1', text: 'first' } });
        await handOver(runtime);
        acp.loadSession = async () => update('replayed');
        await runtime.handleMessage(URI, { type: 'chat.returnToChat', data: {} });
        update('live');
        const shown = posts.filter(p => p.type === 'chat.sessionUpdate').map(p => p.data.notification.text);
        expect(shown).toEqual(['live']);
    });
});
