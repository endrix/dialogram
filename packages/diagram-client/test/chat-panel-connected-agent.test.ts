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

describe('a change of agent in the panel', () => {
    const systemRows = (panel: ChatPanel) =>
        ((panel as any).timeline as any[]).filter((t) => t.kind === 'message' && t.role === 'system').map((t) => t.content);

    it('reads "Connecting…" with no row while the host starts the new agent, then names it', () => {
        const panel = makePanel();
        (panel as any).handleIncomingMessage('chat.connectionStatus', { connected: true, agent: 'opencode' });
        (panel as any).handleIncomingMessage('chat.connectionStatus', { connected: false, connecting: true });
        expect(JSON.stringify((panel as any).topbarTemplate().values)).toContain('Connecting…');
        expect(systemRows(panel)).toEqual([]);
        (panel as any).handleIncomingMessage('chat.connectionStatus', { connected: true, agent: 'claude' });
        expect(JSON.stringify((panel as any).topbarTemplate().values)).toContain('Connected · claude');
        expect(systemRows(panel)).toEqual([]);
    });

    it('says a start that failed once: the error the status already carries adds no row', () => {
        const panel = makePanel();
        (panel as any).handleIncomingMessage('chat.connectionStatus', { connected: false, connecting: true });
        const reason = 'ACP connector "claud" is not known (known: claude, opencode)';
        (panel as any).handleIncomingMessage('chat.connectionStatus', { connected: false, reason });
        (panel as any).handleIncomingMessage('chat.error', { message: `Could not start the chat agent: ${reason}`, inStatus: true });
        expect(systemRows(panel)).toHaveLength(1);
        expect(systemRows(panel)[0]).toContain(reason);
        // Any other error still has its row.
        (panel as any).handleIncomingMessage('chat.error', { message: 'boom' });
        expect(systemRows(panel)).toEqual([expect.stringContaining(reason), 'Error: boom']);
    });

    it('gives a switch that failed its row, even with the reason a row before the switch gave', () => {
        const panel = makePanel();
        const reason = 'ACP connector "claud" is not known';
        (panel as any).handleIncomingMessage('chat.connectionStatus', { connected: false, reason });
        (panel as any).handleIncomingMessage('chat.connectionStatus', { connected: false, connecting: true });
        (panel as any).handleIncomingMessage('chat.connectionStatus', { connected: false, reason });
        expect(systemRows(panel)).toHaveLength(2);
    });

    it('says a failed start again when the status\'s row is no longer the last one', () => {
        const panel = makePanel();
        const reason = 'ACP connector "claud" is not known';
        (panel as any).handleIncomingMessage('chat.connectionStatus', { connected: false, reason });
        (panel as any).pushMessage('user', 'hello');
        // The same reason again: the status adds no row, so the error does.
        (panel as any).handleIncomingMessage('chat.connectionStatus', { connected: false, reason });
        (panel as any).handleIncomingMessage('chat.error', { message: `Could not start the chat agent: ${reason}`, inStatus: true });
        expect(systemRows(panel)).toEqual([expect.stringContaining(reason), `Error: Could not start the chat agent: ${reason}`]);
    });

    it('forgets the old agent\'s model when another is started', () => {
        const panel = makePanel();
        (panel as any).handleIncomingMessage('chat.providers', { providers: [{ id: 'opencode/big-pickle' }], current: 'opencode/big-pickle' });
        expect((panel as any).currentModel).toBe('opencode/big-pickle');
        (panel as any).handleIncomingMessage('chat.connectionStatus', { connected: false, connecting: true });
        expect((panel as any).currentModel).toBe('');
    });

    it('offers no model between two agents\' lists', () => {
        const panel = makePanel();
        (panel as any).handleIncomingMessage('chat.providers', { providers: [{ id: 'opencode/big-pickle' }] });
        (panel as any).handleIncomingMessage('chat.providers', { providers: [] });
        expect((panel as any).models).toEqual([]);
        (panel as any).handleIncomingMessage('chat.providers', { providers: [{ id: 'sonnet', name: 'Sonnet' }] });
        expect((panel as any).models).toEqual([{ id: 'sonnet', name: 'Sonnet' }]);
    });
});
