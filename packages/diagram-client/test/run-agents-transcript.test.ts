// A running agent's transcript: every turn's reasoning, text and tool calls
// in arrival order, tool statuses updated in place, the questions among them;
// the bar's per-turn summary stays what it was.
import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'vitest';
import { EXECUTION_OVERLAY_ACTION_KIND } from '@dialogram/shared';
import { RunAgentStreamActionHandler } from '../src/editing-action-handlers';

afterEach(() => RunAgentStreamActionHandler.reset());

function feed(events: Array<Record<string, unknown>>): void {
    new RunAgentStreamActionHandler().handle({ kind: EXECUTION_OVERLAY_ACTION_KIND, events } as any);
}

describe("an agent's transcript", () => {
    it('keeps every turn in order, with tool statuses updated in place', () => {
        feed([
            { seq: 1, type: 'run.started' },
            { seq: 2, type: 'agent.message.start', instance: 'ask' },
            { seq: 3, type: 'agent.message.delta', instance: 'ask', field: 'reasoning', delta: 'I should ' },
            { seq: 4, type: 'agent.message.delta', instance: 'ask', field: 'reasoning', delta: 'write.' },
            { seq: 5, type: 'agent.tool_call', instance: 'ask', name: 'Write /tmp/1.txt', status: 'pending', id: 'c1' },
            { seq: 6, type: 'agent.tool_call_update', instance: 'ask', id: 'c1', status: 'completed' },
            { seq: 7, type: 'agent.message.delta', instance: 'ask', delta: '{"answer": 1}' },
            { seq: 8, type: 'agent.message.end', instance: 'ask' },
            { seq: 9, type: 'agent.message.start', instance: 'ask' },
            { seq: 10, type: 'agent.message.delta', instance: 'ask', delta: 'second turn' }
        ]);
        const a = RunAgentStreamActionHandler.getAgent('ask')!;
        expect(a.parts).toEqual([
            { kind: 'turn', index: 1 },
            { kind: 'reasoning', text: 'I should write.' },
            { kind: 'tool', name: 'Write /tmp/1.txt', status: 'completed', id: 'c1' },
            { kind: 'text', text: '{"answer": 1}' },
            { kind: 'turn', index: 2 },
            { kind: 'text', text: 'second turn' }
        ]);
        expect(a.turns).toBe(2);
        // The bar's summary is the current turn only.
        expect(a.text).toBe('second turn');
        expect(a.reasoning).toBe('');
        expect(a.toolCalls).toEqual([]);
        expect(a.status).toBe('running');
    });

    it('places a question where it was asked and counts it until answered', () => {
        feed([
            { seq: 1, type: 'run.started' },
            { seq: 2, type: 'agent.message.start', instance: 'ask' },
            { seq: 3, type: 'agent.message.delta', instance: 'ask', delta: 'hello' }
        ]);
        RunAgentStreamActionHandler.addQuestion('ask', { id: 9, agent: 'ask', question: 'Write?', choices: ['Allow'] });
        feed([{ seq: 4, type: 'agent.message.delta', instance: 'ask', delta: ' world' }]);
        const a = RunAgentStreamActionHandler.getAgent('ask')!;
        expect(a.parts.map(p => p.kind)).toEqual(['turn', 'text', 'question', 'text']);
        expect(a.pendingQuestions).toBe(1);
        expect(RunAgentStreamActionHandler.pendingQuestionCount()).toBe(1);
        RunAgentStreamActionHandler.resolveQuestion('ask', 9, { answer: 'Allow' });
        expect(a.pendingQuestions).toBe(0);
        expect((a.parts[2] as any).question.resolved).toEqual({ answer: 'Allow' });
        // An agent the stream has not reached yet still takes a question.
        RunAgentStreamActionHandler.addQuestion('late', { id: 10, agent: 'late', question: 'q', choices: [] });
        expect(RunAgentStreamActionHandler.getAgent('late')!.parts).toHaveLength(1);
    });
});
