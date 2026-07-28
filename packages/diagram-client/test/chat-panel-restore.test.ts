/**
 * Restoring a session's history into the integrated chat panel.
 *
 *  (a) a persisted tool message renders as a tool timeline item (the same chip
 *      the live path uses), not a text/system row;
 *  (c) a stray streamed chunk arriving AFTER the history is rendered — the
 *      session/load replay tail that opencode emits on `session/load` — must NOT
 *      duplicate the trailing assistant message.
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

beforeEach(() => {
    (globalThis as any).requestAnimationFrame = () => 1;
    (globalThis as any).cancelAnimationFrame = () => undefined;
});

afterEach(() => {
    delete (globalThis as any).requestAnimationFrame;
    delete (globalThis as any).cancelAnimationFrame;
});

describe('chat panel session-history restore', () => {
    it('(a) renders a persisted tool message as a tool timeline item', () => {
        const panel = makePanel();
        (panel as any).handleIncomingMessage('chat.sessionHistory', {
            sessionId: 's1',
            messages: [
                { role: 'assistant', content: 'A' },
                { role: 'tool', content: '', toolName: 'read', toolStatus: 'completed' },
                { role: 'assistant', content: 'B' }
            ]
        });

        const timeline = (panel as any).timeline as Array<any>;
        const tool = timeline.find(t => t.kind === 'tool');
        expect(tool).toBeDefined();
        expect(tool.title).toBe('read');
        expect(tool.status).toBe('completed');
        // The two assistant text parts remain distinct rows around the tool.
        const texts = timeline.filter(t => t.kind === 'message' && t.role === 'assistant').map(t => t.content);
        expect(texts).toEqual(['A', 'B']);
    });

    it('(c) a replay-tail chunk after history does not duplicate the trailing message', () => {
        const panel = makePanel();
        (panel as any).handleIncomingMessage('chat.sessionHistory', {
            sessionId: 's1',
            messages: [
                { role: 'user', content: 'hi' },
                { role: 'assistant', content: 'Done.' }
            ]
        });

        // opencode replays the last assistant message as a session/update after
        // session/load resolves; it must not become a second "Done." row.
        (panel as any).handleIncomingMessage('chat.sessionUpdate', {
            notification: {
                sessionId: 's1',
                update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } }
            }
        });
        (panel as any).finishStreamingMessage();

        const timeline = (panel as any).timeline as Array<any>;
        const assistantRows = timeline.filter(t => t.kind === 'message' && t.role === 'assistant');
        expect(assistantRows).toHaveLength(1);
        expect((panel as any).streamingText).toBe('');
    });
});
