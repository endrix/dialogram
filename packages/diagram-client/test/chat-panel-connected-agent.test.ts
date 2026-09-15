/**
 * The connection status names the ACP connector the chat talks to, so a
 * "Connected" that means claude does not read as opencode.
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

describe('the connected status names the connector', () => {
    it('keeps the connector from the status and shows it in the topbar label', () => {
        const panel = makePanel();
        (panel as any).handleIncomingMessage('chat.connectionStatus', { connected: true, agent: 'claude' });
        expect((panel as any).connection).toBe('connected');
        expect((panel as any).connectionAgent).toBe('claude');
        const rendered = JSON.stringify((panel as any).topbarTemplate().values);
        expect(rendered).toContain('Connected · claude');
        expect(rendered).toContain('Connected to the claude ACP connector');
    });

    it('reads plain "Connected" when the host names no connector, and keeps the last name across a disconnect', () => {
        const panel = makePanel();
        (panel as any).handleIncomingMessage('chat.connectionStatus', { connected: true });
        expect(JSON.stringify((panel as any).topbarTemplate().values)).toContain('"Connected"');
        (panel as any).handleIncomingMessage('chat.connectionStatus', { connected: true, agent: 'opencode' });
        (panel as any).handleIncomingMessage('chat.connectionStatus', { connected: false, reason: 'opencode disconnected' });
        expect(JSON.stringify((panel as any).topbarTemplate().values)).toContain('opencode: opencode disconnected');
    });
});
