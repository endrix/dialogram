import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { ChatPanel as ExportedChatPanel } from '../src/index';
import { ChatPanel } from '../src/chat-panel-integrated';

describe('stock ChatPanel public surface', () => {
    it('is exported from the package index for library consumers', () => {
        expect(ExportedChatPanel).toBe(ChatPanel);
    });

    it('disconnect notice copy is product-neutral', () => {
        const panel = new ChatPanel();
        (panel as any).channel = { sendToHost: () => undefined };
        (globalThis as any).window = {};
        try {
            (panel as any).handleIncomingMessage('chat.connectionStatus', { connected: false, reason: 'x' });
        } finally {
            delete (globalThis as any).window;
        }
        const timeline = (panel as any).timeline as Array<{ content?: string }>;
        const notice = timeline.map(t => t.content ?? '').join('\n');
        expect(notice).toContain('Run the chat\'s "Diagnose Connection" command for details.');
        expect(notice).not.toContain('Workflow Chat');
    });
});
