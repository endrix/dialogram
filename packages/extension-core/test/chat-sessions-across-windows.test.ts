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
    acp.sendPrompt = vi.fn(async () => undefined);
    const settled = () => (runtime as any).sessions.idle() as Promise<void>;
    const send = (type: string, data?: unknown) => runtime.handleMessage(URI, { type, data } as any);
    const last = (type: string) => posts.filter((p) => p.type === type).pop() as any;
    return { runtime, acp, state, posts, settled, send, last };
}

async function turn(w: ReturnType<typeof makeWindow>, sessionId: string, asked: string, answer: string): Promise<void> {
    // A turn takes the agent seconds; a window's stamps run a millisecond or
    // two ahead of the clock when it keeps two in one. Without this wait, two
    // windows' turns in one millisecond (a fast machine) tie, and the order
    // read back is no longer the order they were taken in.
    await new Promise((resolve) => setTimeout(resolve, 10));
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

        // The desk window shows ses_1: coming back to it, the other window's
        // turn is added after what its panel shows.
        const before = local.posts.length;
        await local.send('chat.getSessions', { shown: 'ses_1' });
        const posted = local.posts.slice(before);
        expect(posted.some((p) => p.type === 'chat.sessionHistory')).toBe(false);
        const append = posted.find((p) => p.type === 'chat.sessionAppend') as any;
        expect(said(append)).toEqual(['user: second', 'assistant: two']);

        // Nothing new (the panel names what it shows): nothing is sent again.
        const quiet = local.posts.length;
        await local.send('chat.getSessions', { shown: 'ses_1', keys: append.data.messages.map((m: any) => m.key) });
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

    it('deleted in one window takes no message in the other: nothing sent or kept, the message goes back', async () => {
        const local = makeWindow('ses_1');
        await local.send('chat.createSession', { name: 'Review', mode: 'build' });
        const ssh = makeWindow('ses_2');
        await ssh.send('chat.getSessions');
        await ssh.send('chat.loadSession', { sessionId: 'ses_1' });
        const ask = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Delete' as any);
        try {
            await local.send('chat.deleteSession', { sessionId: 'ses_1' });
        } finally {
            ask.mockRestore();
        }

        await ssh.send('chat.sendMessage', { sessionId: 'ses_1', text: 'still there?', mode: 'build' });
        expect(ssh.acp.sendPrompt).not.toHaveBeenCalled();
        expect(ssh.last('chat.messageNotSent').data).toMatchObject({ sessionId: 'ses_1', reason: 'this chat was deleted in another window' });
        expect(ssh.last('chat.sessionDeleted').data.reason).toMatch(/deleted in another window/);
        expect(ssh.last('chat.sessions').data.sessions).toEqual([]);
        await ssh.settled();
        const fresh = makeWindow('ses_x');
        await fresh.send('chat.getSessions');
        expect(fresh.last('chat.sessions').data.sessions).toEqual([]);
    });

    it('deleted in one window, opened from the other\'s old list, says so', async () => {
        const local = makeWindow('ses_1');
        await local.send('chat.createSession', { name: 'Review', mode: 'build' });
        const ssh = makeWindow('ses_2');
        await ssh.send('chat.getSessions');
        const ask = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Delete' as any);
        try {
            await local.send('chat.deleteSession', { sessionId: 'ses_1' });
        } finally {
            ask.mockRestore();
        }
        await ssh.send('chat.loadSession', { sessionId: 'ses_1' });
        expect(ssh.last('chat.error')).toBeUndefined();
        expect(ssh.last('chat.sessionDeleted').data).toMatchObject({ sessionId: 'ses_1' });
        expect(ssh.last('chat.sessions').data.sessions).toEqual([]);
    });

    it('whose file cannot be removed stays, and the panel says so', async () => {
        const local = makeWindow('ses_1');
        await local.send('chat.createSession', { name: 'Review', mode: 'build' });
        (local.runtime as any).sessions.store.remove = async () => { throw new Error('EPERM: operation not permitted'); };
        const warn = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Delete' as any);
        try {
            await local.send('chat.deleteSession', { sessionId: 'ses_1' });
        } finally {
            warn.mockRestore();
        }
        expect(local.last('chat.sessionDeleted')).toBeUndefined();
        expect(local.last('chat.error').data.message).toMatch(/Could not delete chat session "Review"/);
        expect(local.last('chat.sessions').data.sessions).toEqual([{ id: 'ses_1', name: 'Review' }]);
    });

    it("sends an open panel another window's turn even when a list read took it in before", async () => {
        const local = makeWindow('ses_1');
        await local.send('chat.createSession', { name: 'Review', mode: 'build' });
        await turn(local, 'ses_1', 'first', 'one');
        const ssh = makeWindow('ses_2');
        await ssh.send('chat.getSessions');
        await ssh.send('chat.loadSession', { sessionId: 'ses_1' });
        await turn(ssh, 'ses_1', 'second', 'two');

        // Focused mid-turn: the list is read (and the turn taken in), no session named.
        await local.send('chat.getSessions', {});
        const before = local.posts.length;
        await local.send('chat.getSessions', { shown: 'ses_1' });
        expect(said(local.posts.slice(before).find((p) => p.type === 'chat.sessionAppend'))).toEqual(['user: second', 'assistant: two']);
    });

    it('sends again what the panel left (a turn started meanwhile), not what it names', async () => {
        const local = makeWindow('ses_1');
        await local.send('chat.createSession', { name: 'Review', mode: 'build' });
        const ssh = makeWindow('ses_2');
        await ssh.send('chat.getSessions');
        await ssh.send('chat.loadSession', { sessionId: 'ses_1' });
        await turn(ssh, 'ses_1', 'second', 'two');

        const appended = async (keys: string[] = []) => {
            const before = local.posts.length;
            await local.send('chat.getSessions', { shown: 'ses_1', keys });
            return local.posts.slice(before).find((p) => p.type === 'chat.sessionAppend') as any;
        };
        // Left by the panel: it names none of them, so they are sent again.
        expect(said(await appended())).toEqual(['user: second', 'assistant: two']);
        const again = await appended();
        expect(said(again)).toEqual(['user: second', 'assistant: two']);
        expect(await appended(again.data.messages.map((m: any) => m.key))).toBeUndefined();
    });

    it('sends the transcript again, in order, when the other window went on at the same time', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            const local = makeWindow('ses_1');
            vi.setSystemTime(1_000);
            await local.send('chat.createSession', { name: 'Review', mode: 'build' });
            const ssh = makeWindow('ses_2');
            await ssh.send('chat.getSessions');
            await ssh.send('chat.loadSession', { sessionId: 'ses_1' });
            vi.setSystemTime(2_000);
            await ssh.send('chat.sendMessage', { sessionId: 'ses_1', text: 'asked there first', mode: 'build' });
            vi.setSystemTime(3_000);
            await turn(local, 'ses_1', 'asked here second', 'answered here');
            vi.setSystemTime(4_000);
            ssh.acp.emit('turnComplete', { sessionId: 'ses_1', text: 'answered there', model: 'model-a', parts: [{ type: 'text', text: 'answered there' }] });
            await ssh.settled();

            const before = local.posts.length;
            await local.send('chat.getSessions', { shown: 'ses_1' });
            const posted = local.posts.slice(before);
            expect(posted.some((p) => p.type === 'chat.sessionAppend')).toBe(false);
            const history = posted.find((p) => p.type === 'chat.sessionHistory') as any;
            expect(history.data.catchUp).toBe(true);
            expect(said(history)).toEqual(['user: asked there first', 'user: asked here second', 'assistant: answered here', 'assistant: answered there']);
        } finally {
            vi.useRealTimers();
        }
    });

    it('deleted while it answered: the panel is told the answer was not kept', async () => {
        const local = makeWindow('ses_1');
        await local.send('chat.createSession', { name: 'Review', mode: 'build' });
        const ssh = makeWindow('ses_2');
        await ssh.send('chat.getSessions');
        await local.send('chat.sendMessage', { sessionId: 'ses_1', text: 'long question', mode: 'build' });
        await local.settled();
        const ask = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Delete' as any);
        try {
            await ssh.send('chat.deleteSession', { sessionId: 'ses_1' });
        } finally {
            ask.mockRestore();
        }
        local.acp.emit('turnComplete', { sessionId: 'ses_1', text: 'late answer', model: 'model-a', parts: [{ type: 'text', text: 'late answer' }] });
        await vi.waitFor(() =>
            expect(local.posts.some((p: any) => p.type === 'chat.message' && /deleted in another window while it answered/.test(p.data?.content))).toBe(true));
        expect(local.last('chat.sessions').data.sessions).toEqual([]);
    });

    it('deleted here while it answered: not said to be deleted in another window', async () => {
        const local = makeWindow('ses_1');
        await local.send('chat.createSession', { name: 'Review', mode: 'build' });
        await local.send('chat.sendMessage', { sessionId: 'ses_1', text: 'long question', mode: 'build' });
        await local.settled();
        // The agent ends the turn as the session is deleted.
        local.acp.deleteSession = async (id: string) => {
            local.acp.emit('turnComplete', { sessionId: id, text: 'cut short', model: 'model-a', parts: [] });
        };
        const ask = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Delete' as any);
        try {
            await local.send('chat.deleteSession', { sessionId: 'ses_1' });
        } finally {
            ask.mockRestore();
        }
        await local.settled();
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(local.posts.some((p: any) => p.type === 'chat.message' && /another window/.test(p.data?.content ?? ''))).toBe(false);
        expect(local.last('chat.sessionDeleted').data.sessionId).toBe('ses_1');
    });

    it('deleted between the check and the load of a send: refused all the same', async () => {
        const local = makeWindow('ses_1');
        await local.send('chat.createSession', { name: 'Review', mode: 'build' });
        await local.settled();
        // After a reload: the agent has not attached the session yet.
        const ssh = makeWindow('ses_2');
        await ssh.send('chat.getSessions');
        ssh.acp.getSession = () => undefined;
        const sessions = (ssh.runtime as any).sessions;
        const isGone = sessions.isGone.bind(sessions);
        let first = true;
        sessions.isGone = async (id: string) => {
            if (!first) return isGone(id);
            first = false;
            // Still there when looked at; deleted right after.
            const ask = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Delete' as any);
            try {
                await local.send('chat.deleteSession', { sessionId: 'ses_1' });
            } finally {
                ask.mockRestore();
            }
            return false;
        };
        await ssh.send('chat.sendMessage', { sessionId: 'ses_1', text: 'hello?', mode: 'build' });
        expect(ssh.acp.sendPrompt).not.toHaveBeenCalled();
        expect(ssh.last('chat.messageNotSent').data.sessionId).toBe('ses_1');
    });

    it('falls back, after a delete, on a session that is still there', async () => {
        const local = makeWindow('ses_1');
        await local.send('chat.createSession', { name: 'Kept', mode: 'build' });
        local.acp.createSession = async () => 'ses_3';
        await local.send('chat.createSession', { name: 'Newer', mode: 'build' });
        local.acp.createSession = async () => 'ses_4';
        await local.send('chat.createSession', { name: 'Newest', mode: 'build' });
        await local.settled();
        const ssh = makeWindow('ses_2');
        await ssh.send('chat.getSessions');
        const confirm = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Delete' as any);
        try {
            // The desk asks "Delete Newest?"; meanwhile the SSH window deletes Newer.
            confirm.mockImplementationOnce(async () => {
                await ssh.send('chat.deleteSession', { sessionId: 'ses_3' });
                return 'Delete' as any;
            });
            await local.send('chat.deleteSession', { sessionId: 'ses_4' });
        } finally {
            confirm.mockRestore();
        }
        expect(local.last('chat.sessionDeleted').data).toMatchObject({ sessionId: 'ses_4', nextSessionId: 'ses_1' });
    });

    it('takes a message for a session the window has not listed yet (its panel kept it over a restart)', async () => {
        const local = makeWindow('ses_1');
        await local.send('chat.createSession', { name: 'Review', mode: 'build' });
        await local.settled();
        const restarted = makeWindow('ses_x');
        await turn(restarted, 'ses_1', 'after the restart', 'still here');
        expect(restarted.acp.sendPrompt).toHaveBeenCalled();
        const reader = makeWindow('ses_y');
        await reader.send('chat.getSessions');
        await reader.send('chat.loadSession', { sessionId: 'ses_1' });
        expect(said(reader.last('chat.sessionHistory'))).toEqual(['user: after the restart', 'assistant: still here']);
    });

    it('sends nothing on catching up when the panel names every stored message, tool calls too', async () => {
        const local = makeWindow('ses_1');
        await local.send('chat.createSession', { name: 'Review', mode: 'build' });
        await local.send('chat.sendMessage', { sessionId: 'ses_1', text: 'look', mode: 'build' });
        local.acp.emit('turnComplete', { sessionId: 'ses_1', text: '', model: 'model-a', parts: [{ type: 'text', text: 'looking' }, { type: 'tool', title: 'read', status: 'completed' }] });
        await local.settled();
        const ssh = makeWindow('ses_2');
        await ssh.send('chat.getSessions');
        await ssh.send('chat.loadSession', { sessionId: 'ses_1' });
        const history = ssh.last('chat.sessionHistory') as any;
        const before = ssh.posts.length;
        await ssh.send('chat.getSessions', { shown: 'ses_1', keys: history.data.messages.map((m: any) => m.key) });
        expect(ssh.posts.slice(before).map((p) => p.type)).toEqual(['chat.sessions']);
    });

    it('does not say a chat was deleted when the list could not be read', async () => {
        const local = makeWindow('ses_1');
        await local.send('chat.createSession', { name: 'Review', mode: 'build' });
        await local.settled();
        const restarted = makeWindow('ses_x');
        (restarted.runtime as any).sessions.store.list = async () => { throw new Error('EACCES: permission denied'); };
        await restarted.send('chat.getSessions', { shown: 'ses_1', keys: [] });
        expect(restarted.last('chat.sessionDeleted')).toBeUndefined();
    });

    it('sends the transcript again when the panel shows rows this host never sent nor made (a restart of the host)', async () => {
        const local = makeWindow('ses_1');
        await local.send('chat.createSession', { name: 'Review', mode: 'build' });
        await turn(local, 'ses_1', 'before the restart', 'answered');
        const restarted = makeWindow('ses_x');
        await restarted.send('chat.getSessions');
        const before = restarted.posts.length;
        await restarted.send('chat.getSessions', { shown: 'ses_1', keys: [], unkeyed: 2 });
        const posted = restarted.posts.slice(before);
        expect(posted.some((p) => p.type === 'chat.sessionAppend')).toBe(false);
        const history = posted.find((p) => p.type === 'chat.sessionHistory') as any;
        expect(history.data.catchUp).toBe(true);
        expect(said(history)).toEqual(['user: before the restart', 'assistant: answered']);
    });

    it('renamed after another window deleted it: the panel is told it was deleted, not renamed', async () => {
        const local = makeWindow('ses_1');
        await local.send('chat.createSession', { name: 'Review', mode: 'build' });
        const ssh = makeWindow('ses_2');
        await ssh.send('chat.getSessions');
        const ask = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Delete' as any);
        try {
            await ssh.send('chat.deleteSession', { sessionId: 'ses_1' });
        } finally {
            ask.mockRestore();
        }
        await local.send('chat.renameSession', { sessionId: 'ses_1', name: 'Design' });
        expect(local.last('chat.sessionRenamed')).toBeUndefined();
        expect(local.last('chat.sessionDeleted').data.reason).toMatch(/deleted in another window/);
    });

    it('a send, after a restart, to a chat deleted meanwhile is refused', async () => {
        const local = makeWindow('ses_1');
        await local.send('chat.createSession', { name: 'Review', mode: 'build' });
        await local.settled();
        const ask = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Delete' as any);
        try {
            await local.send('chat.deleteSession', { sessionId: 'ses_1' });
        } finally {
            ask.mockRestore();
        }
        const restarted = makeWindow('ses_x');
        await restarted.send('chat.sendMessage', { sessionId: 'ses_1', text: 'still there?', mode: 'build' });
        expect(restarted.acp.sendPrompt).not.toHaveBeenCalled();
        expect(restarted.last('chat.messageNotSent').data.sessionId).toBe('ses_1');
    });

    it('deleted from another panel of this window: not said to be another window', async () => {
        const local = makeWindow('ses_1');
        await local.send('chat.createSession', { name: 'Review', mode: 'build' });
        const ask = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Delete' as any);
        try {
            await local.send('chat.deleteSession', { sessionId: 'ses_1' });
        } finally {
            ask.mockRestore();
        }
        await local.send('chat.getSessions', { shown: 'ses_1', keys: [] });
        expect(local.last('chat.sessionDeleted').data.reason).toBe('This chat was deleted. Create or select a session to continue.');
    });

    it('a message from a panel with no chat open makes a chat, not into the one current', async () => {
        const w = makeWindow('ses_1');
        await w.send('chat.createSession', { name: 'Review', mode: 'build' });
        w.acp.createSession = async () => 'ses_2';
        await w.send('chat.sendMessage', { sessionId: null, text: 'a new question', mode: 'build' });
        expect(w.last('chat.sessionCreated').data).toMatchObject({ session: { id: 'ses_2' }, forMessage: true });
        expect(w.acp.sendPrompt.mock.calls.at(-1)?.[0]).toBe('ses_2');
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
