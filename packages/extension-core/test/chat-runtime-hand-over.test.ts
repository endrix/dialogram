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
import * as vscode from './vscode-mock';
import { clipboardWrites, closeTerminal, createdTerminals } from './vscode-mock';

const URI = 'file:///w/top.py';
const OTHER = 'file:///w/other.py';

interface Options {
    resume?: string | null;
    /** How many times the agent refuses the load when the chat returns. */
    refusals?: number;
    held?: string[];
    /** The agent's process does not end when it is stopped. */
    staysAlive?: boolean;
    /** Sessions the agent started again cannot load: it kept none of them. */
    notKept?: string[];
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
        { key: 'test', displayName: 'Test', settingsSection: 'test.chat', acpAgent: async () => connector.set } as any,
        (uri, payload) => void posts.push({ uri, type: payload.type, data: payload.data }),
        () => true
    );
    let refusals = options.refusals ?? 0;
    const held = new Set(options.held ?? ['s1']);
    const notKept = new Set(options.notKept ?? []);
    /** How the agent was started, each time. */
    const starts: Array<{ cwd: string; agent: unknown }> = [];
    const acp = {
        agent: 'codex',
        resumeTemplate: options.resume === null ? undefined : (options.resume ?? 'codex resume {sessionId}'),
        connected: true,
        prompts: [] as string[],
        sessionCwd: () => '/w',
        isClientConnected: () => acp.connected,
        takesImages: () => undefined,
        getAllSessions: () => [...held].map(id => ({ id })),
        getSession: (id: string) => ({ id }),
        getSessionMode: () => 'build',
        getSessionModel: (): string | undefined => 'model-a',
        setSessionMode: async (id: string, mode: string): Promise<void> => void done.push(`mode ${id} ${mode}`),
        setProvider: async (id: string, model: string): Promise<void> => void done.push(`model ${id} ${model}`),
        createSession: async (): Promise<string> => {
            done.push('create');
            return 'made';
        },
        deleteSession: async (): Promise<void> => undefined,
        getMessagesWithIds: async () => [],
        getRevertState: async () => false,
        stopAndWait: async (): Promise<boolean> => {
            done.push('stop');
            acp.connected = false;
            return !options.staysAlive;
        },
        start: async (cwd: string, agent: unknown): Promise<void> => {
            done.push('start');
            starts.push({ cwd, agent });
            acp.agent = (agent as { name?: string } | undefined)?.name ?? acp.agent;
            acp.connected = true;
        },
        // Stopped for another agent: the runtime hears the disconnect.
        stop: (): void => {
            done.push('stop');
            acp.connected = false;
            (runtime as any).agentGeneration += 1;
            (runtime as any).started = false;
            (runtime as any).startPromise = undefined;
            (runtime as any).runningAgent = undefined;
        },
        forgetSessions: (): void => held.clear(),
        cancelPrompt: async (): Promise<void> => undefined,
        loadSession: async (id: string): Promise<void> => {
            if (notKept.has(id)) {
                done.push(`load ${id} refused`);
                throw new Error('No saved session found');
            }
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
    return { runtime, posts, done, acp, types, last, starts, notKept };
}

/** The connector the setting names: what an agent is started as. */
const connector: { set: unknown } = { set: undefined };
const CODEX = { name: 'codex', argv: ['codex-acp'] };
const ANOTHER = { name: 'another', argv: ['another-acp'] };

/** A chat the window's store knows, with rows of the roles given. */
function keep(runtime: ChatRuntime, id: string, roles: Array<'user' | 'assistant'>, file = '/w/top.py'): void {
    (runtime as any).sessions.sessions.set(id, {
        id,
        name: id,
        workflowFile: file,
        createdAt: 1,
        updatedAt: 1,
        mode: 'build',
        messages: roles.map((role, at) => ({ role, content: `${role} ${at}`, timestamp: at }))
    });
}
const kept = (runtime: ChatRuntime, id: string): unknown => (runtime as any).sessions.sessions.get(id);

async function handOver(runtime: ChatRuntime, sessionId = 's1'): Promise<void> {
    await runtime.handleMessage(URI, { type: 'chat.openSessionNatively', data: { sessionId } });
}

beforeEach(() => {
    createdTerminals.length = 0;
    clipboardWrites.length = 0;
    delete (createdTerminals as any).push;
    connector.set = undefined;
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

    it('hands nothing over while a turn is running, and says so in the chat that asked', async () => {
        const { runtime, done, acp, posts, types } = makeRuntime();
        let endTurn: () => void = () => undefined;
        acp.sendPrompt = () => new Promise<void>(resolve => (endTurn = resolve));
        const turn = runtime.handleMessage(URI, { type: 'chat.sendMessage', data: { sessionId: 's1', text: 'go' } });
        await new Promise(resolve => setTimeout(resolve, 20));
        // Asked from another chat of the window: the turn is not its own.
        await runtime.handleMessage(OTHER, { type: 'chat.openSessionNatively', data: { sessionId: 's1' } });
        expect(done).toEqual([]);
        expect(createdTerminals).toHaveLength(0);
        expect(types()).not.toContain('chat.handedOver');
        const said = posts.filter(p => p.type === 'chat.message');
        expect(said.map(p => p.uri)).toEqual([OTHER]);
        expect(said[0].data.role).toBe('system');
        expect(said[0].data.content).toContain('Not opened: a turn is running.');
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

    it('opens no terminal onto an agent that did not stop, and offers the return', async () => {
        const { runtime, done, last } = makeRuntime({ staysAlive: true });
        await handOver(runtime);
        // Still there, it may still hold the session.
        expect(done).toEqual(['stop']);
        expect(createdTerminals).toHaveLength(0);
        expect(last('chat.handedOver')?.data).toEqual({ sessionId: 's1', agent: 'codex', terminalOpen: false });
        expect(last('chat.error')?.data.message).toContain('codex did not stop');
        await runtime.handleMessage(URI, { type: 'chat.returnToChat', data: {} });
        expect(last('chat.returnedToChat')).toBeDefined();
    });

    it('offers the return when the terminal could not be opened', async () => {
        const { runtime, done, last } = makeRuntime();
        const create = vscode.window.createTerminal;
        vscode.window.createTerminal = () => {
            throw new Error('no terminal here');
        };
        try {
            await handOver(runtime);
        } finally {
            vscode.window.createTerminal = create;
        }
        expect(done).toEqual(['stop']);
        expect(last('chat.handedOver')?.data).toEqual({ sessionId: 's1', agent: 'codex', terminalOpen: false });
        expect(last('chat.error')?.data.message).toContain('no terminal here');
    });

    it('hands over no chat the agent has had no turn in', async () => {
        const { runtime, done, types } = makeRuntime();
        // No message at all: the agent wrote no session for its CLI to open.
        keep(runtime, 's1', []);
        await handOver(runtime);
        // Rows of the person's alone: commands the chat carried out itself.
        keep(runtime, 's1', ['user', 'user']);
        await handOver(runtime);
        expect(done).toEqual([]);
        expect(createdTerminals).toHaveLength(0);
        expect(types()).not.toContain('chat.handedOver');
    });

    it('hands over a chat with an answer, or one a prompt went to in this window', async () => {
        const answered = makeRuntime();
        keep(answered.runtime, 's1', ['user', 'assistant']);
        await handOver(answered.runtime);
        expect(answered.done).toEqual(['stop', 'terminal']);

        const prompted = makeRuntime();
        keep(prompted.runtime, 's1', []);
        // Its answer is not stored yet: the prompt went out all the same.
        await prompted.runtime.handleMessage(URI, { type: 'chat.sendMessage', data: { sessionId: 's1', text: 'go' } });
        prompted.done.length = 0;
        await handOver(prompted.runtime);
        expect(prompted.done.filter(d => d === 'stop' || d === 'terminal')).toEqual(['stop', 'terminal']);
    });

    it('lets a start under way end before it stops the agent', async () => {
        const { runtime, done, acp } = makeRuntime();
        (runtime as any).started = false;
        let connect: () => void = () => undefined;
        acp.start = () =>
            new Promise<void>(resolve => {
                connect = () => {
                    done.push('start');
                    resolve();
                };
            });
        const starting = (runtime as any).ensureStarted('/w');
        await new Promise(resolve => setTimeout(resolve, 10));
        const handing = handOver(runtime);
        await new Promise(resolve => setTimeout(resolve, 10));
        // Not stopped while it connects: that would leave it running behind.
        expect(done).toEqual([]);
        connect();
        await starting;
        await handing;
        expect(done).toEqual(['start', 'stop', 'terminal']);
        expect((runtime as any).started).toBe(false);
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

    it('ends a panel’s wait for a session it asked for', async () => {
        const { runtime, last } = makeRuntime();
        await handOver(runtime);
        await runtime.handleMessage(URI, { type: 'chat.createSession', data: { requestId: 'r1', name: 'Task' } });
        expect(last('chat.sessionCreateAborted')?.data).toEqual({ requestId: 'r1' });
    });

    it('starts the agent for no one else either: the diagnosis command, a handler past the guard', async () => {
        const { runtime, done } = makeRuntime();
        const folders = vscode.workspace.workspaceFolders;
        (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/w' } }];
        const log: string[] = [];
        (runtime as any).output = { appendLine: (line: string) => void log.push(line), show: () => undefined };
        try {
            await handOver(runtime);
            done.length = 0;
            await runtime.runDiagnostics();
            // It got as far as the start, and was refused there.
            expect(log.join('\n')).toContain('return to the chat first');
            await expect((runtime as any).ensureStarted('/w')).rejects.toThrow('return to the chat first');
        } finally {
            (vscode.workspace as any).workspaceFolders = folders;
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
        acp.loadSession = async () => {
            update('replayed');
            // The last of it leaves the forwarder's buffer after the load is answered.
            setTimeout(() => update('replayed late'), 60);
        };
        const returned = Date.now();
        await runtime.handleMessage(URI, { type: 'chat.returnToChat', data: {} });
        // The return waited for it: the session's updates show only after.
        expect(Date.now() - returned).toBeGreaterThanOrEqual(100);
        await new Promise(resolve => setTimeout(resolve, 80));
        update('live');
        const shown = posts.filter(p => p.type === 'chat.sessionUpdate').map(p => p.data.notification.text);
        expect(shown).toEqual(['live']);
    });

    it('starts the agent that was stopped, in its folder, whatever is set since', async () => {
        const { runtime, starts } = makeRuntime();
        (runtime as any).started = false;
        connector.set = CODEX;
        await (runtime as any).ensureStarted('/w');
        connector.set = ANOTHER;
        // Asked from a chat of another folder.
        await runtime.handleMessage('file:///elsewhere/x.py', { type: 'chat.openSessionNatively', data: { sessionId: 's1' } });
        await runtime.handleMessage(URI, { type: 'chat.returnToChat', data: {} });
        expect(starts).toEqual([
            { cwd: '/w', agent: CODEX },
            { cwd: '/w', agent: CODEX }
        ]);
    });
});

describe('a connector set otherwise, and the hand-over', () => {
    it('is followed once the session is back, not while the CLI holds it', async () => {
        const { runtime, starts, done, last } = makeRuntime();
        (runtime as any).started = false;
        connector.set = CODEX;
        await (runtime as any).ensureStarted('/w');
        await handOver(runtime);
        connector.set = ANOTHER;
        await (runtime as any).applyAgentChoice(new Set(['setting']));
        // The agent stays stopped: the session in the CLI is codex's.
        expect(starts).toHaveLength(1);
        expect(last('chat.error')).toBeUndefined();
        await runtime.handleMessage(URI, { type: 'chat.returnToChat', data: {} });
        expect(starts.map(start => start.agent)).toEqual([CODEX, CODEX]);
        expect(last('chat.returnedToChat')).toBeDefined();
        // Now the change is applied, as at any time: after it has settled.
        done.length = 0;
        await new Promise(resolve => setTimeout(resolve, 450));
        await (runtime as any).agentChoice;
        expect(starts.map(start => start.agent)).toEqual([CODEX, CODEX, ANOTHER]);
        expect(done.slice(0, 2)).toEqual(['stop', 'start']);
    });

    it('hands over no chat of the agent the connector named before', async () => {
        const { runtime, done, posts, types } = makeRuntime();
        (runtime as any).formerAgentOf.set('s1', 'claude');
        await handOver(runtime);
        expect(done).toEqual([]);
        expect(createdTerminals).toHaveLength(0);
        expect(types()).not.toContain('chat.handedOver');
        expect(posts.filter(p => p.type === 'chat.message').map(p => p.data.content)).toEqual([
            "Not opened: this chat was with claude, and codex's CLI cannot open it."
        ]);
    });

    it('waits for a change of agent under way before it reads the session', async () => {
        const { runtime, done, acp } = makeRuntime();
        let changed: () => void = () => undefined;
        (runtime as any).agentSwitch = new Promise<void>(resolve => {
            changed = () => {
                (runtime as any).agentSwitch = undefined;
                acp.agent = 'another';
                acp.resumeTemplate = 'another resume {sessionId}';
                resolve();
            };
        });
        const handing = handOver(runtime);
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(done).toEqual([]);
        changed();
        await handing;
        expect(createdTerminals[0].sent).toEqual(['another resume s1']);
    });

    it('forgets what a hand-over meant to load again when another agent takes over', async () => {
        const { runtime, posts } = makeRuntime({ held: ['s1', 's2'] });
        await runtime.handleMessage(OTHER, { type: 'chat.sendMessage', data: { sessionId: 's2', text: 'first' } });
        await handOver(runtime);
        await runtime.handleMessage(URI, { type: 'chat.returnToChat', data: {} });
        expect((runtime as any).toLoadAgain.has('s2')).toBe(true);
        await (runtime as any).stopAgentWhenIdle('codex', 'another');
        expect((runtime as any).toLoadAgain.size).toBe(0);
        // A turn of the chat with the new agent is shown, not taken for a replay.
        posts.length = 0;
        (runtime as any).post('s2', { type: 'chat.sessionUpdate', data: { notification: { sessionId: 's2', text: 'answer' } } });
        expect(posts.filter(p => p.type === 'chat.sessionUpdate')).toHaveLength(1);
    });
});

describe('the other chats of the agent that was stopped', () => {
    /** Hand `s1` over and take it back: `s2` is the stopped agent's too. */
    async function roundTrip(options: Options = {}) {
        const made = makeRuntime({ held: ['s1', 's2'], ...options });
        await handOver(made.runtime);
        await made.runtime.handleMessage(URI, { type: 'chat.returnToChat', data: {} });
        made.done.length = 0;
        made.posts.length = 0;
        return made;
    }

    it('drops one with no message that the agent did not keep, and gives the message back', async () => {
        const { runtime, done, posts, acp } = await roundTrip({ notKept: ['s2'] });
        keep(runtime, 's2', [], '/w/other.py');
        await runtime.handleMessage(OTHER, { type: 'chat.sendMessage', data: { sessionId: 's2', text: 'first words' } });
        // Nothing is prompted to an agent that does not hold the chat.
        expect(acp.prompts).toEqual([]);
        expect(done).toEqual(['load s2 refused']);
        const told = posts.filter(p => p.uri === OTHER && p.type !== 'chat.sessions');
        expect(told.map(p => p.type)).toEqual(['chat.messageNotSent', 'chat.turnEnd', 'chat.sessionDeleted']);
        expect(told[0].data).toEqual({ sessionId: 's2', reason: 'the agent did not keep this chat' });
        expect(told[2].data.sessionId).toBe('s2');
        expect(told[2].data.reason).toContain('had no message yet');
        expect(kept(runtime, 's2')).toBeUndefined();
        // No row of the message was stored for a chat that is gone.
        expect(posts.filter(p => p.type === 'chat.messageIds')).toEqual([]);
    });

    it('keeps one with messages that could not be loaded, sends nothing, and loads it at the next message', async () => {
        const { runtime, done, posts, acp, notKept } = await roundTrip({ notKept: ['s2'] });
        keep(runtime, 's2', ['user', 'assistant'], '/w/other.py');
        await runtime.handleMessage(OTHER, { type: 'chat.sendMessage', data: { sessionId: 's2', text: 'again' } });
        expect(acp.prompts).toEqual([]);
        expect(posts.find(p => p.type === 'chat.messageNotSent')?.data).toEqual({
            sessionId: 's2',
            reason: 'the agent could not load this chat again; send once more, or start a new chat'
        });
        expect(posts.filter(p => p.type === 'chat.sessionDeleted')).toEqual([]);
        expect((kept(runtime, 's2') as any).messages).toHaveLength(2);
        // The agent answers the load now: the message goes, and its turn is shown.
        notKept.clear();
        done.length = 0;
        await runtime.handleMessage(OTHER, { type: 'chat.sendMessage', data: { sessionId: 's2', text: 'again' } });
        expect(done).toEqual(['load s2', 'prompt s2']);
        (runtime as any).post('s2', { type: 'chat.sessionUpdate', data: { notification: { sessionId: 's2', text: 'answer' } } });
        expect(posts.filter(p => p.type === 'chat.sessionUpdate').map(p => p.data.notification.text)).toEqual(['answer']);
    });

    it('loads one before its mode or its model is set, once', async () => {
        const { runtime, done } = await roundTrip();
        keep(runtime, 's2', ['user', 'assistant'], '/w/other.py');
        await runtime.handleMessage(OTHER, { type: 'chat.setProvider', data: { sessionId: 's2', providerId: 'model-b' } });
        await runtime.handleMessage(OTHER, { type: 'chat.setMode', data: { sessionId: 's2', mode: 'plan' } });
        expect(done).toEqual(['load s2', 'model s2 model-b', 'mode s2 plan']);
    });

    it('changes no model of one it could not load, and shows the model it still has', async () => {
        const { runtime, done, posts } = await roundTrip({ notKept: ['s2'] });
        keep(runtime, 's2', ['user', 'assistant'], '/w/other.py');
        await runtime.handleMessage(OTHER, { type: 'chat.setProvider', data: { sessionId: 's2', providerId: 'model-b' } });
        expect(done).toEqual(['load s2 refused']);
        expect(posts.find(p => p.type === 'chat.providerChanged')?.data).toEqual({ provider: 'model-a' });
        expect(posts.find(p => p.type === 'chat.error')?.data.message).toContain('its model is not changed');
    });

    it('keeps the mode of one it could not load for its next message', async () => {
        const { runtime, done } = await roundTrip({ notKept: ['s2'] });
        keep(runtime, 's2', ['user', 'assistant'], '/w/other.py');
        await runtime.handleMessage(OTHER, { type: 'chat.setMode', data: { sessionId: 's2', mode: 'plan' } });
        expect(done).toEqual(['load s2 refused']);
        expect((kept(runtime, 's2') as any).mode).toBe('plan');
    });

    it('loads one that is opened, and shows its turns after', async () => {
        const { runtime, done, posts } = await roundTrip();
        keep(runtime, 's2', ['user', 'assistant'], '/w/other.py');
        await runtime.handleMessage(OTHER, { type: 'chat.loadSession', data: { sessionId: 's2' } });
        expect(done.filter(d => d.startsWith('load'))).toEqual(['load s2', 'load s2']);
        (runtime as any).post('s2', { type: 'chat.sessionUpdate', data: { notification: { sessionId: 's2', text: 'live' } } });
        expect(posts.filter(p => p.type === 'chat.sessionUpdate').map(p => p.data.notification.text)).toEqual(['live']);
    });

    it('loads one once for two who ask at the same time', async () => {
        const { runtime, done } = await roundTrip();
        keep(runtime, 's2', ['user', 'assistant'], '/w/other.py');
        await Promise.all([
            runtime.handleMessage(OTHER, { type: 'chat.setMode', data: { sessionId: 's2', mode: 'plan' } }),
            runtime.handleMessage(OTHER, { type: 'chat.setProvider', data: { sessionId: 's2', providerId: 'model-b' } })
        ]);
        expect(done.filter(d => d.startsWith('load'))).toEqual(['load s2']);
    });
});

describe('the review of the hand-over with a change of agent', () => {
    it('defers a change whose connector was still being read when the session was handed over', async () => {
        const { runtime, starts, last } = makeRuntime();
        (runtime as any).started = false;
        connector.set = CODEX;
        await (runtime as any).ensureStarted('/w');
        let read!: (agent: unknown) => void;
        connector.set = new Promise(resolve => { read = resolve; });
        const applying = (runtime as any).applyAgentChoice(new Set(['setting']));
        await new Promise(resolve => setTimeout(resolve, 0));
        await handOver(runtime);
        read(ANOTHER);
        await applying;
        // Nothing stopped or started behind the CLI, and no failure said.
        expect(starts.map(start => start.agent)).toEqual([CODEX]);
        expect(last('chat.connectionStatus')?.data.reason).toBe("the session is open in codex's CLI");
        expect([...(runtime as any).agentChoiceDeferred]).toEqual(['setting']);
        // Back, the change is followed.
        connector.set = ANOTHER;
        await runtime.handleMessage(URI, { type: 'chat.returnToChat', data: {} });
        await new Promise(resolve => setTimeout(resolve, 450));
        await (runtime as any).agentChoice;
        expect(starts.map(start => start.agent)).toEqual([CODEX, CODEX, ANOTHER]);
    });

    it('loads again a session made while the stop waited', async () => {
        const { runtime, acp } = makeRuntime();
        const stop = acp.stopAndWait;
        let stopped = false;
        acp.stopAndWait = async () => {
            const ended = await stop();
            stopped = true;
            return ended;
        };
        acp.getAllSessions = () => (stopped ? [{ id: 's1' }, { id: 'made-meanwhile' }] : [{ id: 's1' }]);
        await handOver(runtime);
        expect((runtime as any).toLoadAgain.has('made-meanwhile')).toBe(true);
    });

    it('stops the agent on purpose: its going is not reported, the status says where the session is', async () => {
        const { runtime, acp, posts } = makeRuntime();
        const stop = acp.stopAndWait;
        let onPurpose: boolean | undefined;
        acp.stopAndWait = async () => {
            onPurpose = (runtime as any).stoppingOnPurpose;
            return stop();
        };
        await handOver(runtime);
        expect(onPurpose).toBe(true);
        expect((runtime as any).stoppingOnPurpose).toBe(false);
        expect(posts.filter(p => p.type === 'chat.connectionStatus').map(p => p.data)).toEqual([
            { connected: false, reason: "the session is open in codex's CLI", agent: 'codex' },
        ]);
    });

    it('stops offering to send once more to a chat the agent could not load twice', async () => {
        const made = makeRuntime({ held: ['s1', 's2'], notKept: ['s2'] });
        await handOver(made.runtime);
        await made.runtime.handleMessage(URI, { type: 'chat.returnToChat', data: {} });
        keep(made.runtime, 's2', ['user', 'assistant'], '/w/other.py');
        made.posts.length = 0;
        await made.runtime.handleMessage(OTHER, { type: 'chat.sendMessage', data: { sessionId: 's2', text: 'again' } });
        await made.runtime.handleMessage(OTHER, { type: 'chat.sendMessage', data: { sessionId: 's2', text: 'again' } });
        expect(made.posts.filter(p => p.type === 'chat.messageNotSent').map(p => p.data.reason)).toEqual([
            'the agent could not load this chat again; send once more, or start a new chat',
            'the agent could not load this chat again (2 tries); start a new chat',
        ]);
        expect(made.acp.prompts).toEqual([]);
    });
});
