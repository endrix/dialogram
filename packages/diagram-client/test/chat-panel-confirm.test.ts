/**
 * A confirmation the host puts in the chat (resuming a run the session's agent
 * fixed): a card in the session's timeline, its choices as buttons; pressing
 * one answers the host once.
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

const confirm = { id: '1', title: 'Resume the failed run', text: 'Resume the run of top from where it failed?', choices: ['Resume', 'Not now'] };

describe('a confirmation in the chat', () => {
    it('is a card in the session’s timeline, and opens the panel on the session', () => {
        const { panel, showSpy } = makePanel();
        (panel as any).view = { kind: 'agent', instance: 'planner' };

        (panel as any).handleIncomingMessage('chat.confirm', confirm);

        expect((panel as any).timeline.at(-1)).toMatchObject({ kind: 'confirm', id: '1', choices: ['Resume', 'Not now'] });
        expect((panel as any).view).toEqual({ kind: 'session' });
        expect(showSpy).toHaveBeenCalled();
    });

    it('answers the host with the button pressed, once', () => {
        const { panel, sent } = makePanel();
        (panel as any).handleIncomingMessage('chat.confirm', confirm);
        const item = (panel as any).timeline.at(-1);

        (panel as any).answerConfirm(item, 'Resume');
        (panel as any).answerConfirm(item, 'Not now');

        expect(sent.filter(m => m.type === 'chat.confirmAnswer').map(m => m.data)).toEqual([{ id: '1', choice: 'Resume' }]);
        expect(item.resolved).toBe('Resume');
    });
});
