/**
 * A running agent's question (the run driver's human port) lands in the chat
 * timeline, opens the panel, and is answered back to the host as
 * `chat.runAnswer`: the chat is the run's viewer here, not its session.
 */
import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatPanel } from '../src/chat-panel-integrated';

function makePanel() {
    const panel = new ChatPanel();
    const sent: Array<{ method: string; env: any }> = [];
    (panel as any).channel = { sendToHost: (method: string, env: any) => void sent.push({ method, env }) };
    const showSpy = vi.fn();
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

describe('a running agent\'s question in the chat', () => {
    it('is recorded with its choices and opens the panel', () => {
        const { panel, showSpy } = makePanel();
        (panel as any).handleIncomingMessage('chat.runQuestion', {
            id: 7, agent: 'planner', model: 'opus', question: 'Apply the patch?', context: 'diff…', choices: ['Allow', 'Reject'], timeoutMs: 60000
        });
        const timeline = (panel as any).timeline as any[];
        expect(timeline).toEqual([
            { kind: 'question', id: 7, agent: 'planner', model: 'opus', question: 'Apply the patch?', context: 'diff…', choices: ['Allow', 'Reject'] }
        ]);
        expect(showSpy).toHaveBeenCalled();
    });

    it('answers and declines back to the host, once', () => {
        const { panel, sent } = makePanel();
        (panel as any).handleIncomingMessage('chat.runQuestion', { id: 1, agent: 'planner', question: 'Which?', choices: ['a', 'b'] });
        (panel as any).handleIncomingMessage('chat.runQuestion', { id: 2, agent: 'planner', question: 'Free text?' });
        const [q1, q2] = (panel as any).timeline as any[];
        (panel as any).answerRunQuestion(q1, 'b');
        (panel as any).answerRunQuestion(q1, 'a');   // already answered: ignored
        (panel as any).answerRunQuestion(q2, undefined);
        const answers = sent.filter(s => s.env.type === 'chat.runAnswer').map(s => s.env.data);
        expect(answers).toEqual([
            expect.objectContaining({ id: 1, answer: 'b' }),
            expect.objectContaining({ id: 2, declined: true })
        ]);
        expect(q1.resolved).toEqual({ answer: 'b' });
        expect(q2.resolved).toEqual({ declined: true });
    });

    it('ignores a malformed question', () => {
        const { panel, showSpy } = makePanel();
        (panel as any).handleIncomingMessage('chat.runQuestion', { agent: 'x' });
        expect((panel as any).timeline).toEqual([]);
        expect(showSpy).not.toHaveBeenCalled();
    });
});
