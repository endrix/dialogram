// A run agent's firing reports the session it talked to on its end event;
// the transcript keeps it on that firing's turn, where the view offers to
// open it in the agent's own CLI.
import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'vitest';
import { EXECUTION_OVERLAY_ACTION_KIND } from '@dialogram/shared';
import { liveAgentSession, RunAgentStreamActionHandler } from '../src/editing-action-handlers';

afterEach(() => RunAgentStreamActionHandler.reset());

function feed(events: Array<Record<string, unknown>>): void {
    new RunAgentStreamActionHandler().handle({ kind: EXECUTION_OVERLAY_ACTION_KIND, events } as any);
}

describe("a firing's session", () => {
    it('lands on its own turn, each turn keeping its own', () => {
        feed([
            { seq: 1, type: 'run.started' },
            { seq: 2, type: 'agent.message.start', instance: 'ask' },
            { seq: 3, type: 'agent.message.end', instance: 'ask', session: { id: 's1', connector: 'claude', cwd: '/w' } },
            { seq: 4, type: 'agent.message.start', instance: 'ask' },
            { seq: 5, type: 'agent.message.delta', instance: 'ask', delta: 'x' },
            { seq: 6, type: 'agent.message.end', instance: 'ask', session: { id: 's2', connector: 'claude', cwd: '/w' } }
        ]);
        const turns = RunAgentStreamActionHandler.getAgent('ask')!.parts.filter(p => p.kind === 'turn');
        expect(turns).toEqual([
            { kind: 'turn', index: 1, session: { id: 's1', connector: 'claude', cwd: '/w' } },
            { kind: 'turn', index: 2, session: { id: 's2', connector: 'claude', cwd: '/w' } }
        ]);
    });

    it('is absent from a turn whose end names none', () => {
        feed([
            { seq: 1, type: 'agent.message.start', instance: 'ask' },
            { seq: 2, type: 'agent.message.end', instance: 'ask' }
        ]);
        expect(RunAgentStreamActionHandler.getAgent('ask')!.parts[0]).toEqual({ kind: 'turn', index: 1 });
    });

    it('is read only when it names an id', () => {
        expect(liveAgentSession({ id: ' s ', connector: '', cwd: '/w' })).toEqual({ id: 's', cwd: '/w' });
        expect(liveAgentSession({ connector: 'claude' })).toBeUndefined();
        expect(liveAgentSession('s')).toBeUndefined();
    });
});
