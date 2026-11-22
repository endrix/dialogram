// @vitest-environment happy-dom
/**
 * A message sent with no session open: the host makes one for it and says so
 * (`chat.sessionCreated` with `forMessage`). The message stays on screen, as
 * the first turn of that session, after the line that says it was made; what
 * was on screen before it goes, as for any new session. A session made with
 * "+" still starts on an empty transcript.
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
    panel.update = () => undefined;
    return { panel, sent };
}

const said = (panel: any) => panel.timeline.map((t: any) => `${t.role}: ${t.content}`);

beforeEach(() => {
    (globalThis as any).requestAnimationFrame = () => 1;
    (globalThis as any).cancelAnimationFrame = () => undefined;
});

describe('the first message, sent with no session open', () => {
    it('stays on screen after the line that says the session was made, and its turn goes on', () => {
        const { panel, sent } = makePanel();
        panel.pushMessage('system', 'This chat was deleted in another window.');
        panel.sendPrompt('Remember the word HERON.', [], true);
        expect(sent.pop()?.data).toMatchObject({ text: 'Remember the word HERON.', sessionId: null });

        panel.handleIncomingMessage('chat.sessionCreated', { session: { id: 'ses_1', name: 'Session 1' }, forMessage: true });

        expect(panel.currentSessionId).toBe('ses_1');
        expect(said(panel)).toEqual(['system: Created session: Session 1', 'user: Remember the word HERON.']);
        expect(panel.isStreaming).toBe(true);
        expect(panel.showTyping).toBe(true);

        // The answer follows it.
        panel.handleIncomingMessage('chat.message', { role: 'assistant', content: 'OK' });
        expect(said(panel)).toEqual(['system: Created session: Session 1', 'user: Remember the word HERON.', 'assistant: OK']);
    });

    it('can still be given back when the host does not take it', () => {
        const { panel } = makePanel();
        panel.sendPrompt('hello', [], true);
        panel.inputValue = '';
        panel.handleIncomingMessage('chat.sessionCreated', { session: { id: 'ses_1', name: 'Session 1' }, forMessage: true });
        panel.handleIncomingMessage('chat.messageNotSent', { sessionId: 'ses_1', reason: 'the agent does not read images', images: false });
        expect(said(panel)[0]).toBe('system: Created session: Session 1');
        expect(said(panel)).not.toContain('user: hello');
        expect(panel.inputValue).toBe('hello');
    });
});

describe('while the agent starts, after the first message was sent', () => {
    it('a note the panel made after the message goes when the session is made', () => {
        const { panel } = makePanel();
        panel.sendPrompt('hello', [], true);
        panel.pushMessage('system', 'Stopped');
        panel.handleIncomingMessage('chat.sessionCreated', { session: { id: 'ses_1', name: 'Session 1' }, forMessage: true });
        expect(said(panel)).toEqual(['system: Created session: Session 1', 'user: hello']);
    });

    it('a chat picked meanwhile stays on screen; the new one is only listed', () => {
        const { panel, sent } = makePanel();
        panel.sendPrompt('hello', [], true);
        panel.loadSession('ses_A');
        panel.handleIncomingMessage('chat.sessionCreated', { session: { id: 'ses_new', name: 'Session 2' }, forMessage: true });
        expect(panel.currentSessionId).toBe('ses_A');
        expect(panel.isLoadingSession).toBe(true);
        expect(sent.at(-1)?.type).toBe('chat.getSessions');
    });

    it('a task asked for meanwhile waits for its own session', () => {
        const { panel, sent } = makePanel();
        panel.sendPrompt('hello', [], true);
        panel.handleIncomingMessage('chat.startTask', { prompt: 'fix the run', mode: 'build', name: 'Fix' });
        panel.handleIncomingMessage('chat.sessionCreated', { session: { id: 'ses_1', name: 'Session 1' }, forMessage: true });
        expect(sent.filter((e) => e.type === 'chat.sendMessage').map((e) => e.data.text)).toEqual(['hello']);
        panel.handleIncomingMessage('chat.turnEnd', { sessionId: 'ses_1' });
        panel.handleIncomingMessage('chat.sessionCreated', { session: { id: 'ses_2', name: 'Fix' } });
        expect(sent.filter((e) => e.type === 'chat.sendMessage').map((e) => e.data.text)).toEqual(['hello', 'fix the run']);
    });
});

describe('a session made with "+"', () => {
    it('starts on an empty transcript, as before', () => {
        const { panel } = makePanel();
        panel.currentSessionId = 'ses_0';
        panel.sendPrompt('in the old session', [], true);
        panel.handleIncomingMessage('chat.turnEnd', { sessionId: 'ses_0' });

        panel.handleIncomingMessage('chat.sessionCreated', { session: { id: 'ses_1', name: 'Session 2' } });

        expect(said(panel)).toEqual(['system: Created session: Session 2']);
    });
});
