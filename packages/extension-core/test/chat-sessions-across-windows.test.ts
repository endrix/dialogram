/**
 * A chat belongs to the machine with the files and the agent, not to the
 * window that made it.
 *
 * VS Code keeps an extension's workspaceState on the client, under the
 * window's URI: a local window and a Remote-SSH window on the same folder (or
 * two people's clients) each have their own. Chats kept there were lost to
 * every other window, although the agent still held the sessions. Here each
 * "window" is a ChatRuntime with its own workspaceState; the store they share
 * is the data folder of the machine their extension host runs on.
 */
import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { ChatRuntime } from '../src/extension/chat/chat-runtime';
import type { ChatPayload } from '../src/api';
import type { SessionData } from '../src/extension/session-manager';

const URI = 'file:///tmp/example.mlir';
const FILE = '/tmp/example.mlir';

function makeWindow(sessionId: string, kept?: SessionData[]) {
    const posts: ChatPayload[] = [];
    const state = new Map<string, unknown>(kept ? [['dialogram.sessions', kept]] : []);
    const memento = {
        get: <T>(key: string, defaultValue?: T): T | undefined => (state.has(key) ? (state.get(key) as T) : defaultValue),
        update: async (key: string, value: unknown): Promise<void> => {
            if (value === undefined) state.delete(key);
            else state.set(key, value);
        },
        keys: (): string[] => [...state.keys()]
    };
    const runtime = new ChatRuntime({ workspaceState: memento } as any, { key: 't', displayName: 'T', settingsSection: 't.chat' } as any, (_uri, payload) =>
        posts.push(payload)
    );
    const acp = (runtime as any).acp;
    acp.isClientConnected = () => true;
    acp.start = async () => undefined;
    acp.createSession = async () => sessionId;
    acp.getSession = (id: string) => ({ id });
    acp.loadSession = vi.fn(async () => undefined);
    acp.deleteSession = async () => undefined;
    acp.setProvider = async () => undefined;
    acp.setSessionMode = async () => undefined;
    acp.getSessionMode = () => 'build';
    acp.getSessionModel = () => 'model-a';
    acp.getMessagesWithIds = async () => [];
    acp.getRevertState = async () => false;
    acp.sendPrompt = async () => undefined;
    const settled = () => (runtime as any).sessions.store.idle() as Promise<void>;
    const send = (type: string, data?: unknown) => runtime.handleMessage(URI, { type, data } as any);
    const last = (type: string) => posts.filter((p) => p.type === type).pop() as any;
    return { runtime, acp, state, posts, settled, send, last };
}

async function turn(w: ReturnType<typeof makeWindow>, sessionId: string, asked: string, answer: string): Promise<void> {
    await w.send('chat.sendMessage', { sessionId, text: asked, mode: 'build' });
    w.acp.emit('turnComplete', { sessionId, text: answer, model: 'model-a', parts: [{ type: 'text', text: answer }] });
    await w.settled();
}

function said(history: any): string[] {
    return history.data.messages.filter((m: any) => m.role !== 'tool').map((m: any) => `${m.role}: ${m.content}`);
}

describe('a chat across windows on the same folder (local, Remote-SSH)', () => {
    it('made in one window is listed and restored in another', async () => {
        const local = makeWindow('ses_1');
        await local.send('chat.createSession', { name: 'Review', mode: 'build' });
        await turn(local, 'ses_1', 'what does this do?', 'It adds.');

        const ssh = makeWindow('ses_other');
        await ssh.send('chat.getSessions');
        expect(ssh.last('chat.sessions').data.sessions).toEqual([{ id: 'ses_1', name: 'Review' }]);

        await ssh.send('chat.loadSession', { sessionId: 'ses_1' });
        expect(ssh.acp.loadSession).toHaveBeenCalledWith('ses_1', '/tmp', FILE, 'build');
        expect(said(ssh.last('chat.sessionHistory'))).toEqual(['user: what does this do?', 'assistant: It adds.']);
    });

    it('goes on in either: each window, loading it again, sees what the other added', async () => {
        const local = makeWindow('ses_1');
        await local.send('chat.createSession', { name: 'Review', mode: 'build' });
        await turn(local, 'ses_1', 'first', 'one');

        const ssh = makeWindow('ses_other');
        await ssh.send('chat.getSessions');
        await ssh.send('chat.loadSession', { sessionId: 'ses_1' });
        await turn(ssh, 'ses_1', 'second', 'two');

        await local.send('chat.loadSession', { sessionId: 'ses_1' });
        expect(said(local.last('chat.sessionHistory'))).toEqual([
            'user: first', 'assistant: one', 'user: second', 'assistant: two'
        ]);
    });

    it("keeps both windows' turns when each had it open all along", async () => {
        const local = makeWindow('ses_1');
        await local.send('chat.createSession', { name: 'Review', mode: 'build' });
        await turn(local, 'ses_1', 'first', 'one');
        const ssh = makeWindow('ses_other');
        await ssh.send('chat.getSessions');
        await ssh.send('chat.loadSession', { sessionId: 'ses_1' });
        await turn(ssh, 'ses_1', 'second', 'two');
        // The local window never loaded it again: the agent still has it attached.
        await turn(local, 'ses_1', 'third', 'three');

        const fresh = makeWindow('ses_x');
        await fresh.send('chat.getSessions');
        await fresh.send('chat.loadSession', { sessionId: 'ses_1' });
        expect(said(fresh.last('chat.sessionHistory'))).toEqual([
            'user: first', 'assistant: one', 'user: second', 'assistant: two', 'user: third', 'assistant: three'
        ]);
    });

    it('catches up in a window whose panel stayed open, when it is come back to', async () => {
        const local = makeWindow('ses_1');
        const ssh = makeWindow('ses_2');
        await local.send('chat.getSessions');
        await ssh.send('chat.getSessions');
        await local.send('chat.createSession', { name: 'Review', mode: 'build' });
        await turn(local, 'ses_1', 'first', 'one');

        // The SSH panel was open all along: coming back to it lists the new chat.
        await ssh.send('chat.getSessions', {});
        expect(ssh.last('chat.sessions').data.sessions).toEqual([{ id: 'ses_1', name: 'Review' }]);
        await ssh.send('chat.loadSession', { sessionId: 'ses_1' });
        await turn(ssh, 'ses_1', 'second', 'two');

        // The desk window shows ses_1: coming back to it, the transcript catches up.
        const before = local.posts.length;
        await local.send('chat.getSessions', { shown: 'ses_1' });
        const history = local.posts.slice(before).find((p) => p.type === 'chat.sessionHistory') as any;
        expect(said(history)).toEqual(['user: first', 'assistant: one', 'user: second', 'assistant: two']);

        // Nothing new: no transcript is sent again.
        const quiet = local.posts.length;
        await local.send('chat.getSessions', { shown: 'ses_1' });
        expect(local.posts.slice(quiet).map((p) => p.type)).toEqual(['chat.sessions']);

        // Deleted at the desk: the SSH window, coming back, is told.
        const ask = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Delete' as any);
        try {
            await local.send('chat.deleteSession', { sessionId: 'ses_1' });
        } finally {
            ask.mockRestore();
        }
        await ssh.send('chat.getSessions', { shown: 'ses_1' });
        expect(ssh.last('chat.sessionDeleted').data.sessionId).toBe('ses_1');
        expect(ssh.last('chat.sessions').data.sessions).toEqual([]);
    });

    it('deleted in one window leaves the other', async () => {
        const local = makeWindow('ses_1');
        await local.send('chat.createSession', { name: 'Review', mode: 'build' });
        const ssh = makeWindow('ses_other');
        await ssh.send('chat.getSessions');

        const ask = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Delete' as any);
        try {
            await ssh.send('chat.deleteSession', { sessionId: 'ses_1' });
        } finally {
            ask.mockRestore();
        }
        await local.send('chat.getSessions');
        expect(local.last('chat.sessions').data.sessions).toEqual([]);
    });

    it('kept in each client\'s workspaceState by an older Dialogram moves into the one store', async () => {
        const kept = (id: string, name: string, updatedAt: number): SessionData => ({
            id, name, workflowFile: FILE, createdAt: 1, updatedAt, mode: 'plan',
            messages: [{ role: 'user', content: `${name}?`, timestamp: 1 }]
        });
        const local = makeWindow('x', [kept('ses_local', 'At the desk', 2)]);
        const ssh = makeWindow('y', [kept('ses_ssh', 'From the laptop', 3)]);

        await local.send('chat.getSessions');
        await ssh.send('chat.getSessions');
        await local.send('chat.getSessions');
        expect(local.last('chat.sessions').data.sessions).toEqual([
            { id: 'ses_ssh', name: 'From the laptop' },
            { id: 'ses_local', name: 'At the desk' }
        ]);
        expect(ssh.last('chat.sessions').data.sessions).toHaveLength(2);
        expect(local.state.has('dialogram.sessions')).toBe(false);
        expect(ssh.state.has('dialogram.sessions')).toBe(false);

        await ssh.send('chat.loadSession', { sessionId: 'ses_local' });
        expect(said(ssh.last('chat.sessionHistory'))).toEqual(['user: At the desk?']);
    });
});
