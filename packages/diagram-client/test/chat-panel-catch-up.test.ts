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

    it("adds another window's messages after what it shows, keeping its own rows", () => {
        const { panel } = makePanel();
        panel.handleIncomingMessage('chat.sessionHistory', {
            sessionId: 'ses_1',
            messages: [{ role: 'user', content: 'first', mode: 'plan', timestamp: 1 }]
        });
        panel.pushMessage('system', 'a note of this window');
        const added = { sessionId: 'ses_1', messages: [{ role: 'assistant', content: 'from the other window', timestamp: 2 }] };

        panel.isStreaming = true;
        panel.handleIncomingMessage('chat.sessionAppend', added);
        panel.isStreaming = false;
        panel.handleIncomingMessage('chat.sessionAppend', { ...added, sessionId: 'ses_2' });
        expect(panel.timeline.map((t: any) => t.content)).toEqual(['first', 'a note of this window']);

        panel.handleIncomingMessage('chat.sessionAppend', added);
        expect(panel.timeline.map((t: any) => t.content)).toEqual(['first', 'a note of this window', 'from the other window']);
        // A reply takes the mode of the message it answers.
        expect(panel.timeline[2].mode).toBe('plan');
    });

    it('says why a session went when another window deleted it', () => {
        const { panel } = makePanel();
        panel.currentSessionId = 'ses_1';
        panel.isLoadingSession = true;
        panel.handleIncomingMessage('chat.sessionDeleted', { sessionId: 'ses_1', reason: 'This chat was deleted in another window.' });
        expect(panel.currentSessionId).toBeNull();
        expect(panel.isLoadingSession).toBe(false);
        expect(panel.timeline.map((t: any) => t.content)).toEqual(['This chat was deleted in another window.']);
    });

    it('shows a message caught up twice once', () => {
        const { panel } = makePanel();
        panel.handleIncomingMessage('chat.sessionHistory', { sessionId: 'ses_1', messages: [{ role: 'user', content: 'first', timestamp: 1, key: 'k1' }] });
        const added = { sessionId: 'ses_1', messages: [{ role: 'assistant', content: 'other window', timestamp: 2, key: 'k2' }] };
        panel.handleIncomingMessage('chat.sessionAppend', added);
        panel.handleIncomingMessage('chat.sessionAppend', added);
        expect(panel.timeline.map((t: any) => t.content)).toEqual(['first', 'other window']);
    });

    it('leaves a transcript sent again on catching up once a turn has started', () => {
        const { panel } = makePanel();
        panel.handleIncomingMessage('chat.sessionHistory', { sessionId: 'ses_1', messages: [{ role: 'user', content: 'first', timestamp: 1 }] });
        panel.isStreaming = true;
        panel.handleIncomingMessage('chat.sessionHistory', { sessionId: 'ses_1', catchUp: true, messages: [] });
        expect(panel.timeline.map((t: any) => t.content)).toEqual(['first']);
        panel.isStreaming = false;
        panel.handleIncomingMessage('chat.sessionHistory', { sessionId: 'ses_1', catchUp: true, messages: [{ role: 'user', content: 'in order', timestamp: 1 }] });
        expect(panel.timeline.map((t: any) => t.content)).toEqual(['in order']);
    });

    it('takes the next turn after a transcript sent again on catching up (no replay follows it)', () => {
        const { panel } = makePanel();
        panel.handleIncomingMessage('chat.sessionHistory', { sessionId: 'ses_1', messages: [] });
        expect(panel.suppressReplayStream).toBe(true);
        panel.suppressReplayStream = false;
        panel.handleIncomingMessage('chat.sessionHistory', { sessionId: 'ses_1', catchUp: true, messages: [] });
        expect(panel.suppressReplayStream).toBe(false);
    });

    it('names restored tool calls by key too, and shows one caught up twice once', () => {
        const { panel, asked } = makePanel();
        initialize(panel);
        panel.handleIncomingMessage('chat.sessionHistory', {
            sessionId: 'ses_1',
            messages: [{ role: 'user', content: 'look', timestamp: 1, key: 'k1' }, { role: 'tool', content: '', toolName: 'read', timestamp: 2, key: 'k2' }]
        });
        window.dispatchEvent(new Event('focus'));
        expect(asked().pop()?.data).toMatchObject({ shown: 'ses_1', keys: ['k1', 'k2'] });
        const tool = { sessionId: 'ses_1', messages: [{ role: 'tool', content: '', toolName: 'write', timestamp: 3, key: 'k3' }] };
        panel.handleIncomingMessage('chat.sessionAppend', tool);
        panel.handleIncomingMessage('chat.sessionAppend', tool);
        expect(panel.timeline.filter((t: any) => t.kind === 'tool').map((t: any) => t.title)).toEqual(['read', 'write']);
    });

    it('leaves the transcript shown when another chat is said to be deleted', () => {
        const { panel } = makePanel();
        panel.handleIncomingMessage('chat.sessionHistory', { sessionId: 'ses_2', messages: [{ role: 'user', content: 'mine', timestamp: 1, key: 'k1' }] });
        panel.handleIncomingMessage('chat.sessionDeleted', { sessionId: 'ses_1', reason: 'This chat was deleted in another window.' });
        expect(panel.currentSessionId).toBe('ses_2');
        expect(panel.timeline.map((t: any) => t.content)).toEqual(['mine']);
    });

    it('says how many rows it shows have no key when it asks to catch up', () => {
        const { panel, asked } = makePanel();
        initialize(panel);
        panel.handleIncomingMessage('chat.sessionHistory', { sessionId: 'ses_1', messages: [{ role: 'user', content: 'kept', timestamp: 1, key: 'k1' }] });
        panel.pushMessage('user', 'live');
        panel.pushMessage('system', 'a note');
        window.dispatchEvent(new Event('focus'));
        expect(asked().pop()?.data).toMatchObject({ shown: 'ses_1', keys: ['k1'], unkeyed: 1 });
    });

    it('leaves a note for another chat, and words a refusal by its cause', () => {
        const { panel } = makePanel();
        panel.handleIncomingMessage('chat.sessionHistory', { sessionId: 'ses_2', messages: [] });
        panel.handleIncomingMessage('chat.message', { sessionId: 'ses_1', role: 'system', content: 'not for this one' });
        expect(panel.timeline).toEqual([]);
        panel.handleIncomingMessage('chat.messageNotSent', { sessionId: 'ses_2', reason: 'this chat was deleted in another window' });
        panel.handleIncomingMessage('chat.messageNotSent', { sessionId: 'ses_2', reason: 'the agent does not read images', images: false });
        expect(panel.timeline.map((t: any) => t.content)).toEqual([
            'Not sent: this chat was deleted in another window.',
            'Not sent: the agent does not read images. Remove the images and send again.',
        ]);
    });

    it('goes on loading when another session is said to be deleted', () => {
        const { panel } = makePanel();
        panel.currentSessionId = 'ses_2';
        panel.isLoadingSession = true;
        panel.handleIncomingMessage('chat.sessionDeleted', { sessionId: 'ses_1' });
        expect(panel.isLoadingSession).toBe(true);
    });
});
