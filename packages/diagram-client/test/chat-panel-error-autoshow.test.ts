/**
 * Background connection errors must NOT auto-open the chat drawer.
 *
 * The unified runtime eagerly connects on the panel's `chat.ready` handshake
 * and surfaces spawn/connection failures as `chat.error` — with no user
 * interaction. The panel records the error in the timeline (visible when the
 * user opens the chat) but must not pop the drawer open by itself; only
 * user-initiated activity (streamed replies, tool calls, permission prompts,
 * session load/create) may auto-show.
 *
 * The DOM-less harness leaves `this.panel` null (render/show are inert), so
 * these tests assert on the show() DECISION via a spy, not on DOM state.
 */
import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatPanel } from '../src/chat-panel-integrated';

function makePanel(): { panel: ChatPanel; showSpy: ReturnType<typeof vi.fn> } {
    const panel = new ChatPanel();
    (panel as any).channel = { sendToHost: () => undefined };
    const showSpy = vi.fn();
    (panel as any).show = showSpy;
    return { panel, showSpy };
}

beforeEach(() => {
    (globalThis as any).requestAnimationFrame = () => 1;
    (globalThis as any).cancelAnimationFrame = () => undefined;
});

afterEach(() => {
    delete (globalThis as any).requestAnimationFrame;
    delete (globalThis as any).cancelAnimationFrame;
});

describe('chat.error auto-show suppression', () => {
    it('records the error in the timeline without opening the panel', () => {
        const { panel, showSpy } = makePanel();

        (panel as any).handleIncomingMessage('chat.error', { message: 'Could not start opencode: spawn ENOENT' });

        const timeline = (panel as any).timeline as Array<{ kind: string; role?: string; content?: string }>;
        expect(timeline.some(t => t.kind === 'message' && t.role === 'system' && t.content?.includes('spawn ENOENT'))).toBe(true);
        expect(showSpy).not.toHaveBeenCalled();
    });

    it('streamed assistant chunks still auto-show the panel', () => {
        const { panel, showSpy } = makePanel();

        (panel as any).handleIncomingMessage('chat.sessionUpdate', {
            notification: {
                sessionId: 's1',
                update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } }
            }
        });

        expect(showSpy).toHaveBeenCalled();
    });
});
