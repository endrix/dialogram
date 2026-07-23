/**
 * Host half of the chat "disconnected" race: the messenger transport MUST be
 * wired BEFORE the (slow) opencode/ACP spawn, so a webview that posts
 * `chat.ready` during the spawn window gets a `connectionStatus` reply instead
 * of an "unknown method: dialogram/chat/toHost" drop. Once the ACP client exists
 * and connects, event forwarding is (re)attached so the 'connected' event flips
 * the panel from disconnected → connected.
 *
 * The real ACPClientService is mocked with a deferred `start()` so the spawn
 * window can be held open and inspected.
 *
 * See .superpowers/sdd/chat-race-fix-report.md.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

const hoisted = vi.hoisted(() => ({
    state: { resolveStart: undefined as undefined | (() => void), connected: false }
}));

vi.mock('../src/extension/acp-client', () => {
    class ACPClientService {
        private listeners = new Map<string, Array<(...a: any[]) => void>>();
        on(ev: string, fn: (...a: any[]) => void) {
            const a = this.listeners.get(ev) ?? [];
            a.push(fn);
            this.listeners.set(ev, a);
            return this;
        }
        off(ev: string, fn: (...a: any[]) => void) {
            const a = this.listeners.get(ev);
            if (a) {
                const i = a.indexOf(fn);
                if (i >= 0) a.splice(i, 1);
            }
            return this;
        }
        emit(ev: string, ...args: any[]) {
            (this.listeners.get(ev) ?? []).slice().forEach((f) => f(...args));
            return true;
        }
        // Deferred: holds the spawn window open until the test resolves it.
        start(): Promise<void> {
            return new Promise<void>((resolve) => {
                hoisted.state.resolveStart = resolve;
            });
        }
        isClientConnected(): boolean {
            return hoisted.state.connected;
        }
        async warmUpModelCatalog(): Promise<void> {}
        setChatSkill(): void {}
        setSourceMimeType(): void {}
        setWorkflowGraphProvider(): void {}
        setMcpServersProvider(): void {}
        stop(): void {}
    }
    return { ACPClientService };
});

// Import AFTER the mock is registered.
import { ChatBackend } from '../src/extension/chat/chat-backend';

const CHAT_TO_HOST = 'dialogram/chat/toHost';
const CHAT_TO_CLIENT = 'dialogram/chat/toClient';

function makeContext() {
    const store = new Map<string, unknown>();
    return {
        extensionUri: { fsPath: '/ext' },
        workspaceState: {
            get: <T>(key: string, defaultValue?: T): T | undefined =>
                store.has(key) ? (store.get(key) as T) : defaultValue,
            update: async (key: string, value: unknown): Promise<void> => {
                store.set(key, value);
            }
        },
        subscriptions: [] as { dispose(): void }[]
    } as any;
}

function makeProfile(key: string) {
    return {
        key,
        displayName: key,
        settingsNamespace: `${key}Lang`,
        chat: { name: key, fullName: key.toUpperCase(), operationPrefix: key, skill: 'skill' },
        commands: { layoutDiagram: `${key}.layout`, layoutDiagramIfNeeded: `${key}.layoutIfNeeded` }
    } as any;
}

/**
 * Recording GLSP connector: captures the ChatToHost handler the backend
 * registers and every ChatToClient notification the reply sink emits.
 */
function makeRecordingConnector() {
    const toHostHandlers: Array<(env: any, sender: any) => void> = [];
    const toClient: Array<{ type: string; data: any }> = [];
    const messenger = {
        onNotification: (type: { method: string }, handler: (env: any, sender: any) => void) => {
            if (type.method === CHAT_TO_HOST) toHostHandlers.push(handler);
        },
        sendNotification: (type: { method: string }, _target: unknown, payload: { type: string; data: any }) => {
            if (type.method === CHAT_TO_CLIENT) toClient.push(payload);
        }
    };
    return { connector: { messenger }, toHostHandlers, toClient };
}

const statusMsgs = (msgs: Array<{ type: string; data: any }>) => msgs.filter((m) => m.type === 'chat.connectionStatus');

describe('ChatBackend wires the messenger before the ACP spawn', () => {
    afterEach(() => {
        (vscode.workspace as any).workspaceFolders = undefined;
        hoisted.state.resolveStart = undefined;
        hoisted.state.connected = false;
        vi.clearAllMocks();
    });

    it('registers the ChatToHost handler before start() resolves, answers chat.ready mid-spawn, then flips to connected', async () => {
        (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/ws' } }];
        hoisted.state.connected = false;

        const { connector, toHostHandlers, toClient } = makeRecordingConnector();
        const deps = { getConnector: () => connector, getEditorProvider: () => undefined } as any;

        const backend = new ChatBackend(makeContext(), makeProfile('wfpy'), deps);
        const initPromise = backend.initialize();

        // The code before the first `await` (the deferred start) runs
        // synchronously during the initialize() call: the messenger handler must
        // already be registered and start() must be pending.
        expect(toHostHandlers.length).toBe(1);
        expect(hoisted.state.resolveStart).toBeDefined();

        // A webview posts chat.ready DURING the spawn window.
        const sender = { type: 'webview', webviewId: 'w1' };
        toHostHandlers[0]({ type: 'chat.ready', data: {} }, sender);
        await Promise.resolve();
        await Promise.resolve();

        // It gets a connectionStatus reply — disconnected, because ACP isn't up yet.
        const midSpawn = statusMsgs(toClient);
        expect(midSpawn.length).toBeGreaterThan(0);
        expect(midSpawn[midSpawn.length - 1].data.connected).toBe(false);

        // ACP finishes spawning and connects.
        hoisted.state.connected = true;
        hoisted.state.resolveStart!();
        await initPromise;

        // Forwarding is (re)attached after ACP exists: the panel flips to connected.
        const afterAttach = statusMsgs(toClient);
        expect(afterAttach[afterAttach.length - 1].data.connected).toBe(true);

        // A live 'connected' event also reaches the panel through the re-attached
        // forwarding (proves the listeners are live, not a one-shot placeholder).
        toClient.length = 0;
        backend.getACPClient()!.emit('connected');
        await Promise.resolve();
        const live = statusMsgs(toClient);
        expect(live.length).toBe(1);
        expect(live[0].data.connected).toBe(true);
    });
});
