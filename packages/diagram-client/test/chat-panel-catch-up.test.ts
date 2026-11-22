// @vitest-environment happy-dom
/**
 * Another window on the same folder (a local one, a Remote-SSH one) may make,
 * extend or delete a chat while this one's panel stays open. Coming back to
 * the window, the panel asks for the sessions again and names the one it
 * shows, so the host can bring its transcript up to date; not while a turn
 * runs or a session loads, and at most once a second.
 */
import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/diagram-picture', () => ({ diagramPng: async () => undefined }));

import { ChatPanel } from '../src/chat-panel-integrated';

function makePanel() {
    const sent: Array<{ type: string; data: any }> = [];
    const panel = new ChatPanel() as any;
    panel.channel = { sendToHost: (_method: string, env: any) => sent.push(env) };
    panel.show = () => undefined;
    const asked = () => sent.filter((e) => e.type === 'chat.getSessions');
    return { panel, sent, asked };
}

/** The panel's set-up with its listeners, without the elements happy-dom cannot host. */
function initialize(panel: any): void {
    for (const part of ['createHost', 'createToggleButton', 'setupMessageListener', 'update', 'requestState']) {
        panel[part] = () => undefined;
    }
    panel.initialize();
}

beforeEach(() => {
    (globalThis as any).requestAnimationFrame = () => 1;
    (globalThis as any).cancelAnimationFrame = () => undefined;
});

describe('coming back to the chat window', () => {
    it('asks for the sessions again, naming the one shown', () => {
        const { panel, asked } = makePanel();
        initialize(panel);
        panel.currentSessionId = 'ses_1';
        window.dispatchEvent(new Event('focus'));
        expect(asked().pop()?.data).toMatchObject({ shown: 'ses_1' });
    });

    it('names none while a turn runs or a session loads, and asks at most once a second', () => {
        const { panel, asked } = makePanel();
        panel.currentSessionId = 'ses_1';
        panel.isStreaming = true;
        panel.catchUp();
        expect(asked().pop()?.data.shown).toBeUndefined();

        panel.catchUp();
        expect(asked()).toHaveLength(1);

        panel.lastCatchUp = 0;
        panel.isStreaming = false;
        panel.isLoadingSession = true;
        panel.catchUp();
        expect(asked().pop()?.data.shown).toBeUndefined();

        panel.lastCatchUp = 0;
        panel.isLoadingSession = false;
        panel.catchUp();
        expect(asked().pop()?.data.shown).toBe('ses_1');
    });

    it('asks when the panel becomes visible again', () => {
        const { panel, asked } = makePanel();
        initialize(panel);
        const count = asked().length;
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
        document.dispatchEvent(new Event('visibilitychange'));
        expect(asked()).toHaveLength(count + 1);
    });
});
