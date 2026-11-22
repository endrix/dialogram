// @vitest-environment happy-dom
/**
 * A message sent with no session open: the host makes one for it and says so
 * (`chat.sessionCreated` with `forMessage`). The message stays on screen, as
 * the first turn of that session, after the line that says it was made; what
 * was on screen before it goes, as for any new session. Until the session is
 * made, a second message waits in the composer, and a chat, a task or a "+"
 * asked for meanwhile wins over it. A session made with "+" still starts on
 * an empty transcript.
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
    it('"Stopped", said after the message, stays when the session is made', () => {
        const { panel, sent } = makePanel();
        panel.sendPrompt('hello', [], true);
        panel.cancelStreaming();
        expect(sent.find((e) => e.type === 'chat.cancel')?.data).toMatchObject({ sessionId: null });
        panel.handleIncomingMessage('chat.sessionCreated', { session: { id: 'ses_1', name: 'Session 1' }, forMessage: true });
        expect(said(panel)).toEqual(['system: Created session: Session 1', 'user: hello', 'system: Stopped']);
    });

    it('a second message waits in the composer, and goes to the same chat once it is made', () => {
        const { panel, sent } = makePanel();
        panel.inputValue = 'first';
        panel.sendMessage();
        panel.cancelStreaming();
        panel.inputValue = 'second';
        panel.sendMessage();
        expect(panel.inputValue).toBe('second');
        expect(sent.filter((e) => e.type === 'chat.sendMessage').map((e) => e.data.text)).toEqual(['first']);
        panel.handleIncomingMessage('chat.sessionCreated', { session: { id: 'ses_1', name: 'Session 1' }, forMessage: true });
        panel.sendMessage();
        expect(sent.filter((e) => e.type === 'chat.sendMessage').map((e) => [e.data.text, e.data.sessionId])).toEqual([
            ['first', null],
            ['second', 'ses_1'],
        ]);
    });

    it('a chat picked meanwhile stays on screen, not streaming; the new one is only listed', () => {
        const { panel, sent } = makePanel();
        panel.sendPrompt('hello', [], true);
        panel.loadSession('ses_A');
        panel.handleIncomingMessage('chat.sessionCreated', { session: { id: 'ses_new', name: 'Session 2' }, forMessage: true });
        expect(panel.currentSessionId).toBe('ses_A');
        expect(panel.isLoadingSession).toBe(true);
        expect(panel.isStreaming).toBe(false);
        expect(sent.at(-1)?.type).toBe('chat.getSessions');
        // A refusal for the message, made after, is not said in the chat shown.
        const before = said(panel);
        panel.handleIncomingMessage('chat.messageNotSent', { sessionId: 'ses_new', reason: 'the agent does not read images', images: false });
        expect(panel.inputValue).toBe('');
        expect(said(panel)).toEqual(before);
    });

    it('a task asked for meanwhile gets its own session, and the message\'s is only listed', () => {
        const { panel, sent } = makePanel();
        panel.sendPrompt('hello', [], true);
        panel.handleIncomingMessage('chat.startTask', { prompt: 'fix the run', mode: 'build', name: 'Fix' });
        panel.handleIncomingMessage('chat.sessionCreated', { session: { id: 'ses_1', name: 'Session 1' }, forMessage: true });
        expect(panel.currentSessionId).toBeNull();
        expect(panel.isLoadingSession).toBe(true);
        expect(sent.filter((e) => e.type === 'chat.sendMessage').map((e) => e.data.text)).toEqual(['hello']);
        panel.handleIncomingMessage('chat.sessionCreated', { session: { id: 'ses_2', name: 'Fix' } });
        expect(panel.currentSessionId).toBe('ses_2');
        expect(sent.filter((e) => e.type === 'chat.sendMessage').map((e) => [e.data.text, e.data.sessionId])).toEqual([
            ['hello', null],
            ['fix the run', 'ses_2'],
        ]);
    });

    it('a "+" asked for meanwhile is the one shown, empty and not streaming', () => {
        const { panel } = makePanel();
        panel.sendPrompt('hello', [], true);
        panel.createNewSession();
        panel.handleIncomingMessage('chat.sessionCreated', { session: { id: 'ses_1', name: 'Session 1' }, forMessage: true });
        expect(panel.isLoadingSession).toBe(true);
        panel.handleIncomingMessage('chat.sessionCreated', { session: { id: 'ses_2', name: 'Session 2' } });
        expect(panel.currentSessionId).toBe('ses_2');
        expect(said(panel)).toEqual(['system: Created session: Session 2']);
        expect(panel.isStreaming).toBe(false);
        expect(panel.isLoadingSession).toBe(false);
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
