/**
 * Live tool-call chips must always show the tool name — including the success
 * path, where opencode names the tool on the initial `tool_call` and then sends
 * a status-only `tool_call_update` (no title). A status-only update must not
 * clobber the previously captured name back to the generic "tool call".
 */
import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatPanel } from '../src/chat-panel-integrated';

function makePanel(): ChatPanel {
    const panel = new ChatPanel();
    (panel as any).channel = { sendToHost: () => undefined };
    (panel as any).show = () => undefined;
    return panel;
}

const toolUpdate = (update: any) => ({
    notification: { sessionId: 's1', update }
});

beforeEach(() => {
    (globalThis as any).requestAnimationFrame = () => 1;
    (globalThis as any).cancelAnimationFrame = () => undefined;
});

afterEach(() => {
    delete (globalThis as any).requestAnimationFrame;
    delete (globalThis as any).cancelAnimationFrame;
});

describe('live tool-call chip names', () => {
    it('keeps the tool name through a status-only completed update (success path)', () => {
        const panel = makePanel();
        (panel as any).handleIncomingMessage(
            'chat.sessionUpdate',
            toolUpdate({ sessionUpdate: 'tool_call', toolCallId: 'tc1', title: 'wfpy-glsp_create-nodes', status: 'pending' })
        );
        (panel as any).handleIncomingMessage(
            'chat.sessionUpdate',
            toolUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'tc1', status: 'completed' })
        );

        const timeline = (panel as any).timeline as Array<any>;
        const tool = timeline.find(t => t.kind === 'tool' && t.id === 'tc1');
        expect(tool).toBeDefined();
        expect(tool.title).toBe('wfpy-glsp_create-nodes');
        expect(tool.status).toBe('completed');
    });

    it('shows the name on a failed chip', () => {
        const panel = makePanel();
        (panel as any).handleIncomingMessage(
            'chat.sessionUpdate',
            toolUpdate({ sessionUpdate: 'tool_call', toolCallId: 'tc2', title: 'wfpy-glsp_delete-nodes', status: 'in_progress' })
        );
        (panel as any).handleIncomingMessage(
            'chat.sessionUpdate',
            toolUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'tc2', status: 'failed' })
        );

        const timeline = (panel as any).timeline as Array<any>;
        const tool = timeline.find(t => t.kind === 'tool' && t.id === 'tc2');
        expect(tool.title).toBe('wfpy-glsp_delete-nodes');
        expect(tool.status).toBe('failed');
    });
});
