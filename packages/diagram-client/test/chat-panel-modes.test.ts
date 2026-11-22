// @vitest-environment happy-dom
/**
 * Plan and Build in the chat: a reply is tagged with the mode its message was
 * sent in, live (though the mode is switched while it runs) and restored (a
 * stored reply has no mode of its own); the composer asks for a question or a
 * plan in Plan, and names the "/" commands only where the product has some;
 * Shift+Tab switches the mode, and no key VS Code also takes does.
 */
import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/diagram-picture', () => ({ diagramPng: async () => undefined }));

import { ChatPanel } from '../src/chat-panel-integrated';

function makePanel() {
    const sent: Array<{ method: string; env: any }> = [];
    const panel = new ChatPanel();
    (panel as any).channel = { sendToHost: (method: string, env: any) => sent.push({ method, env }) };
    (panel as any).show = () => undefined;
    // A chat is open: a message sent with none waits for its session first
    // (chat-panel-first-message.test.ts).
    (panel as any).currentSessionId = 's1';
    return { panel: panel as any, sent };
}

beforeEach(() => {
    (globalThis as any).requestAnimationFrame = () => 1;
    (globalThis as any).cancelAnimationFrame = () => undefined;
});

describe('plan and build in the chat', () => {
    it("tags a reply with the mode its message was sent in, though the mode is switched while it runs", () => {
        const { panel } = makePanel();
        panel.inputValue = 'list the clauses';
        panel.sendMessage();
        panel.switchMode('plan');
        panel.handleIncomingMessage('chat.sessionUpdate', {
            notification: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'TRAP-001 — L1' } } }
        });
        panel.handleIncomingMessage('chat.turnEnd', {});
        const rows = panel.timeline.filter((t: any) => t.kind === 'message' && t.role !== 'system');
        expect(rows.map((r: any) => [r.role, r.mode])).toEqual([['user', 'build'], ['assistant', 'build']]);
        expect(panel.currentMode).toBe('plan');
    });

    it('tags a restored reply with the mode of the message it answers', () => {
        const { panel } = makePanel();
        panel.handleIncomingMessage('chat.sessionHistory', {
            sessionId: 's1',
            mode: 'build',
            messages: [
                { role: 'user', content: 'can you edit it?', mode: 'plan', timestamp: 1 },
                { role: 'assistant', content: 'Not in Plan.', timestamp: 2 },
                { role: 'user', content: 'edit it', mode: 'build', timestamp: 3 },
                { role: 'assistant', content: 'Done.', timestamp: 4 }
            ]
        });
        expect(panel.timeline.map((r: any) => r.mode)).toEqual(['plan', 'plan', 'build', 'build']);
    });

    it('asks for a question or a plan in Plan, and names the commands only where there are some', () => {
        const { panel } = makePanel();
        expect(panel.placeholder()).toBe('Describe a change or ask anything…');
        panel.switchMode('plan');
        expect(panel.placeholder()).toBe('Ask about this diagram, or plan a change…');
        panel.handleIncomingMessage('chat.commands', { commands: [{ command: 'layout', description: 'Lay out' }] });
        expect(panel.placeholder()).toBe('Ask about this diagram, or plan a change…  ("/" for commands)');
    });

    it('switches with Shift+Tab in the composer, and leaves Ctrl+Shift+P and B to VS Code', () => {
        const { panel, sent } = makePanel();
        const key = (init: KeyboardEventInit) => {
            const e = new KeyboardEvent('keydown', { cancelable: true, bubbles: true, ...init });
            panel.onInputKeydown(e);
            return e;
        };
        const shiftTab = key({ key: 'Tab', shiftKey: true });
        expect(panel.currentMode).toBe('plan');
        expect(shiftTab.defaultPrevented).toBe(true);
        expect(sent.at(-1)!.env).toMatchObject({ type: 'chat.setMode', data: { mode: 'plan' } });
        key({ key: 'Tab', shiftKey: true });
        expect(panel.currentMode).toBe('build');

        const palette = key({ key: 'P', ctrlKey: true, shiftKey: true });
        const buildTask = key({ key: 'B', ctrlKey: true, shiftKey: true });
        expect(panel.currentMode).toBe('build');
        expect(palette.defaultPrevented || buildTask.defaultPrevented).toBe(false);
    });

    it('switches with Shift+Tab while the "/" menu is open, where Tab takes the command', () => {
        const { panel } = makePanel();
        panel.handleIncomingMessage('chat.commands', { commands: [{ command: 'layout', description: 'Lay out' }] });
        panel.inputValue = '/';
        panel.updateMenu();
        expect(panel.menuItems).toHaveLength(1);
        panel.onInputKeydown(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, cancelable: true }));
        expect(panel.currentMode).toBe('plan');
        expect(panel.inputValue).toBe('/');
        panel.onInputKeydown(new KeyboardEvent('keydown', { key: 'Tab', cancelable: true }));
        expect(panel.inputValue.startsWith('/layout')).toBe(true);
    });

    it('keeps the mode of a turn still running when a history arrives', () => {
        const { panel } = makePanel();
        panel.inputValue = 'list the clauses';
        panel.sendMessage();
        panel.switchMode('plan');
        panel.handleIncomingMessage('chat.sessionHistory', { sessionId: 's1', mode: 'plan', messages: [] });
        expect(panel.turnMode).toBe('build');
        panel.handleIncomingMessage('chat.turnEnd', {});
        panel.handleIncomingMessage('chat.sessionHistory', { sessionId: 's1', mode: 'plan', messages: [] });
        expect(panel.turnMode).toBeUndefined();
    });
});
