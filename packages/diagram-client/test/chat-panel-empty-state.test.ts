/**
 * Empty-state + new-session UX for the integrated chat panel.
 *
 *  (a) creating a new session clears any leftover transcript before the
 *      "Created session" system line — the previous session's rows must not
 *      persist visually into the fresh session;
 *  (b) with no session selected the panel exposes a centered placeholder whose
 *      text depends on whether any sessions exist:
 *        - none    → "Create a new session"
 *        - ≥1      → "Select a session or create a new session";
 *  (c) receiving the session list on init does NOT auto-select a session — the
 *      combo stays on the empty placeholder until the user picks/creates one.
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

describe('chat panel empty-state + new session', () => {
    it('(a) creating a new session clears the previous transcript', () => {
        const panel = makePanel();
        // Simulate a populated prior session.
        (panel as any).timeline = [
            { kind: 'message', role: 'user', content: 'old question', timestamp: 1 },
            { kind: 'message', role: 'assistant', content: 'old answer', timestamp: 2 }
        ];
        (panel as any).currentSessionId = 's-old';
        (panel as any).streamingText = 'half';
        (panel as any).showTyping = true;

        (panel as any).handleIncomingMessage('chat.sessionCreated', {
            session: { id: 's-new', name: 'Session 2' }
        });

        const timeline = (panel as any).timeline as Array<any>;
        // Nothing from the old session survives; only the "Created session" line.
        expect(timeline.filter(t => t.content === 'old question')).toHaveLength(0);
        expect(timeline.filter(t => t.content === 'old answer')).toHaveLength(0);
        const systemRows = timeline.filter(t => t.kind === 'message' && t.role === 'system');
        expect(systemRows).toHaveLength(1);
        expect(systemRows[0].content).toContain('Created session');
        expect((panel as any).currentSessionId).toBe('s-new');
        expect((panel as any).streamingText).toBe('');
        expect((panel as any).showTyping).toBe(false);
    });

    it('(b) empty-state text switches on whether sessions exist', () => {
        const panel = makePanel();
        // No session selected, no sessions at all.
        expect((panel as any).isEmptyState).toBe(true);
        expect((panel as any).emptyStateText).toBe('Create a new session');

        // Sessions exist but none selected yet.
        (panel as any).handleIncomingMessage('chat.sessions', {
            sessions: [{ id: 's1', name: 'Session 1' }]
        });
        expect((panel as any).isEmptyState).toBe(true);
        expect((panel as any).emptyStateText).toBe('Select a session or create a new session');

        // Once a session is selected the empty state clears.
        (panel as any).currentSessionId = 's1';
        expect((panel as any).isEmptyState).toBe(false);
    });

    it('(c) receiving the session list does not auto-select a session', () => {
        const panel = makePanel();
        (panel as any).handleIncomingMessage('chat.sessions', {
            sessions: [
                { id: 's1', name: 'Session 1' },
                { id: 's2', name: 'Session 2' }
            ]
        });
        expect((panel as any).currentSessionId).toBeNull();
        expect((panel as any).isEmptyState).toBe(true);
    });
});
