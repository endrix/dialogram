// An ACP agent's tool call arrives with a title and a kind rather than a
// name; the live state labels it by the title, so the chat and the bar say
// "Write choice-a.txt" and not "unknown".
import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'vitest';
import { EXECUTION_OVERLAY_ACTION_KIND } from '@dialogram/shared';
import { RunAgentStreamActionHandler } from '../src/editing-action-handlers';

afterEach(() => RunAgentStreamActionHandler.reset());

describe('a tool call in the live agent state', () => {
    it('is labelled by its name, else its title, else its kind', () => {
        const handler = new RunAgentStreamActionHandler();
        handler.handle({
            kind: EXECUTION_OVERLAY_ACTION_KIND,
            events: [
                { seq: 1, type: 'run.started' },
                { seq: 2, type: 'agent.message.start', instance: 'ask' },
                { seq: 3, type: 'agent.tool_call', instance: 'ask', name: 'read_file', title: 'Read x' },
                { seq: 4, type: 'agent.tool_call', instance: 'ask', title: 'Write choice-a.txt', kind: 'edit' },
                { seq: 5, type: 'agent.tool_call', instance: 'ask', kind: 'execute' },
                { seq: 6, type: 'agent.tool_call', instance: 'ask' }
            ]
        } as any);
        const [agent] = RunAgentStreamActionHandler.getAgents();
        expect(agent.toolCalls).toEqual(['read_file', 'Write choice-a.txt', 'execute']);
    });
});
