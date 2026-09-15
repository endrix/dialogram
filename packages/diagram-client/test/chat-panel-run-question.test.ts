/**
 * A running agent's question (the run driver's human port) goes into that
 * agent's transcript, switches the panel to the agent (unless the user is
 * typing to the session, then a banner), and is answered back to the host
 * as `chat.runAnswer`.
 */
import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatPanel } from '../src/chat-panel-integrated';
import { RunAgentStreamActionHandler } from '../src/editing-action-handlers';

function makePanel() {
    const panel = new ChatPanel();
    const sent: Array<{ method: string; env: any }> = [];
    (panel as any).channel = { sendToHost: (method: string, env: any) => void sent.push({ method, env }) };
    const showSpy = vi.fn(() => { (panel as any).isVisible = true; });
    (panel as any).show = showSpy;
    return { panel, sent, showSpy };
}

beforeEach(() => {
    (globalThis as any).requestAnimationFrame = () => 1;
    (globalThis as any).cancelAnimationFrame = () => undefined;
    RunAgentStreamActionHandler.reset();
});
afterEach(() => {
    delete (globalThis as any).requestAnimationFrame;
    delete (globalThis as any).cancelAnimationFrame;
    RunAgentStreamActionHandler.reset();
});

describe("a running agent's question in the chat", () => {
    it("lands in the agent's transcript, switches the view to it and opens the panel", () => {
        const { panel, showSpy } = makePanel();
        (panel as any).handleIncomingMessage('chat.runQuestion', {
            id: 7, agent: 'planner', model: 'opus', question: 'Apply the patch?', context: 'diff…', choices: ['Allow', 'Reject'], timeoutMs: 60000
        });
        expect((panel as any).timeline).toEqual([]);
        expect((panel as any).view).toEqual({ kind: 'agent', instance: 'planner' });
        const agent = RunAgentStreamActionHandler.getAgent('planner')!;
        expect(agent.pendingQuestions).toBe(1);
        expect(agent.parts).toEqual([{ kind: 'question', question: {
            id: 7, agent: 'planner', model: 'opus', question: 'Apply the patch?', context: 'diff…', choices: ['Allow', 'Reject']
        } }]);
        expect(RunAgentStreamActionHandler.pendingQuestionCount()).toBe(1);
        expect(showSpy).toHaveBeenCalled();
    });

    it('answers and declines back to the host, once, and resolves the transcript', () => {
        const { panel, sent } = makePanel();
        (panel as any).handleIncomingMessage('chat.runQuestion', { id: 1, agent: 'planner', question: 'Which?', choices: ['a', 'b'] });
        (panel as any).handleIncomingMessage('chat.runQuestion', { id: 2, agent: 'planner', question: 'Free text?' });
        const [q1, q2] = RunAgentStreamActionHandler.getAgent('planner')!.parts.map((p: any) => p.question);
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
        expect(RunAgentStreamActionHandler.pendingQuestionCount()).toBe(0);
    });

    it('does not pull the user out of a message they are typing: a banner instead, and Go switches', () => {
        const { panel } = makePanel();
        (panel as any).inputValue = 'please rename the';
        (panel as any).handleIncomingMessage('chat.runQuestion', { id: 3, agent: 'ask', question: 'Write /tmp/x', choices: ['Allow', 'Reject'] });
        expect((panel as any).view).toEqual({ kind: 'session' });
        expect((panel as any).runBanner).toMatchObject({ id: 3, agent: 'ask' });
        (panel as any).showAgent('ask');
        expect((panel as any).view).toEqual({ kind: 'agent', instance: 'ask' });
        expect((panel as any).runBanner).toBeNull();
    });

    it('the Run segment opens the agent with a question waiting, and Session comes back', () => {
        const { panel } = makePanel();
        (panel as any).handleIncomingMessage('chat.runQuestion', { id: 4, agent: 'analyst', question: 'q', choices: ['ok'] });
        (panel as any).showSession();
        expect((panel as any).view).toEqual({ kind: 'session' });
        (panel as any).openRun();
        expect((panel as any).view).toEqual({ kind: 'agent', instance: 'analyst' });
    });

    it('ignores a malformed question', () => {
        const { panel, showSpy } = makePanel();
        (panel as any).handleIncomingMessage('chat.runQuestion', { agent: 'x' });
        expect(RunAgentStreamActionHandler.getAgents()).toEqual([]);
        expect(showSpy).not.toHaveBeenCalled();
    });
});
