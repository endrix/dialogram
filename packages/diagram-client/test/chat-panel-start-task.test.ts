/**
 * A task the host asks the chat to start ("Fix with AI" on a failed run): the
 * panel opens, creates a session in the task's mode under the task's name, and
 * once it exists sends the task's message as if typed.
 */
import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatPanel } from '../src/chat-panel-integrated';

function makePanel() {
    const panel = new ChatPanel();
    const sent: Array<{ type: string; data: any }> = [];
    (panel as any).channel = { sendToHost: (_method: string, env: any) => void sent.push(env) };
    const showSpy = vi.fn(() => { (panel as any).isVisible = true; });
    (panel as any).show = showSpy;
    return { panel, sent, showSpy };
}

beforeEach(() => {
    (globalThis as any).requestAnimationFrame = () => 1;
    (globalThis as any).cancelAnimationFrame = () => undefined;
});
afterEach(() => {
    delete (globalThis as any).requestAnimationFrame;
    delete (globalThis as any).cancelAnimationFrame;
});

const task = { name: 'Fix: x (in m › i)', mode: 'plan', prompt: 'The last run of workflow `top` failed. …' };

describe('a task the host starts in the chat', () => {
    it('opens the panel and creates a session in the task’s mode and name', () => {
        const { panel, sent, showSpy } = makePanel();

        (panel as any).handleIncomingMessage('chat.startTask', task);

        expect(showSpy).toHaveBeenCalled();
        expect(sent.find(m => m.type === 'chat.createSession')?.data).toMatchObject({ mode: 'plan', name: task.name });
        expect(sent.some(m => m.type === 'chat.sendMessage')).toBe(false);
    });

    it('sends the task’s message once the session exists, in plan mode, once', () => {
        const { panel, sent } = makePanel();
        (panel as any).handleIncomingMessage('chat.startTask', task);

        (panel as any).handleIncomingMessage('chat.sessionCreated', { session: { id: 's1', name: task.name } });
        (panel as any).handleIncomingMessage('chat.sessionCreated', { session: { id: 's2', name: 'later' } });

        const messages = sent.filter(m => m.type === 'chat.sendMessage').map(m => m.data);
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({ text: task.prompt, sessionId: 's1', mode: 'plan' });
    });

    it('drops the task when the session is not created', () => {
        const { panel, sent } = makePanel();
        (panel as any).handleIncomingMessage('chat.startTask', task);
        (panel as any).handleIncomingMessage('chat.sessionCreateAborted', {});
        (panel as any).handleIncomingMessage('chat.sessionCreated', { session: { id: 's1' } });

        expect(sent.some(m => m.type === 'chat.sendMessage')).toBe(false);
    });
});
