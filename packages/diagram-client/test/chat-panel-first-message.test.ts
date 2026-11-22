// @vitest-environment happy-dom
/**
 * A message sent with no chat open: the panel asks for a session first (no
 * name asked), shows "Creating session…", and sends the message once the
 * session exists, as a task's message is sent. Until then another message
 * waits in the composer; a chat picked meanwhile wins, and the waiting
 * message goes back to the composer, as it does when the session does not
 * come (name prompt cancelled, an error, the agent gone).
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
    const of = (type: string) => sent.filter((e) => e.type === type).map((e) => e.data);
    return { panel, sent, of };
}

const said = (panel: any) => panel.timeline.map((t: any) => `${t.role}: ${t.content}`);

function type(panel: any, text: string): void {
    panel.inputValue = text;
    panel.sendMessage();
}

const created = (panel: any, id: string, name: string) =>
    panel.handleIncomingMessage('chat.sessionCreated', { session: { id, name } });

beforeEach(() => {
    (globalThis as any).requestAnimationFrame = () => 1;
    (globalThis as any).cancelAnimationFrame = () => undefined;
});

describe('the first message, sent with no chat open', () => {
    it('asks for a session (no name asked), and is sent into it once it exists, after the line that says so', () => {
        const { panel, of } = makePanel();
        panel.pushMessage('system', 'This chat was deleted in another window.');
        type(panel, 'Remember the word HERON.');

        expect(of('chat.createSession')).toEqual([{ mode: 'build', ask: false }]);
        expect(of('chat.sendMessage')).toEqual([]);
        expect(panel.inputValue).toBe('');
        expect(panel.isLoadingSession).toBe(true);
        expect(panel.loadingLabel).toBe('Creating session…');

        created(panel, 'ses_1', 'Session 1');

        expect(of('chat.sendMessage').map((d) => [d.text, d.sessionId])).toEqual([['Remember the word HERON.', 'ses_1']]);
        expect(said(panel)).toEqual(['system: Created session: Session 1', 'user: Remember the word HERON.']);
        expect(panel.isLoadingSession).toBe(false);
        expect(panel.isStreaming).toBe(true);

        panel.handleIncomingMessage('chat.message', { role: 'assistant', content: 'OK' });
        expect(said(panel).at(-1)).toBe('assistant: OK');
    });

    it('goes back to the composer when the host does not take it', () => {
        const { panel } = makePanel();
        type(panel, 'hello');
        created(panel, 'ses_1', 'Session 1');
        panel.handleIncomingMessage('chat.messageNotSent', { sessionId: 'ses_1', reason: 'the agent does not read images', images: false });
        expect(said(panel)).not.toContain('user: hello');
        expect(panel.inputValue).toBe('hello');
    });
});

describe('while its session is being made', () => {
    it('a second message waits in the composer, and is sent to the same chat after', () => {
        const { panel, of } = makePanel();
        type(panel, 'first');
        type(panel, 'second');
        expect(panel.inputValue).toBe('second');
        expect(of('chat.createSession')).toHaveLength(1);
        created(panel, 'ses_1', 'Session 1');
        panel.handleIncomingMessage('chat.turnEnd', { sessionId: 'ses_1' });
        panel.sendMessage();
        expect(of('chat.sendMessage').map((d) => [d.text, d.sessionId])).toEqual([
            ['first', 'ses_1'],
            ['second', 'ses_1'],
        ]);
    });

    it('a chat picked meanwhile wins: the message goes back, the new chat is only listed, and sending works there', () => {
        const { panel, sent, of } = makePanel();
        type(panel, 'hello');
        panel.loadSession('ses_A');
        expect(panel.inputValue).toBe('hello');
        created(panel, 'ses_new', 'Session 2');
        expect(panel.currentSessionId).toBe('ses_A');
        expect(panel.isLoadingSession).toBe(true);
        expect(sent.at(-1)?.type).toBe('chat.getSessions');
        panel.handleIncomingMessage('chat.sessionHistory', { sessionId: 'ses_A', messages: [] });
        panel.sendMessage();
        expect(of('chat.sendMessage').map((d) => [d.text, d.sessionId])).toEqual([['hello', 'ses_A']]);
    });

    it('a task asked for meanwhile takes that session; the typed message goes back', () => {
        const { panel, of } = makePanel();
        type(panel, 'hello');
        panel.handleIncomingMessage('chat.startTask', { prompt: 'fix the run', mode: 'build', name: 'Fix' });
        expect(panel.inputValue).toBe('hello');
        expect(of('chat.createSession')).toHaveLength(1);
        created(panel, 'ses_1', 'Session 1');
        expect(of('chat.sendMessage').map((d) => [d.text, d.sessionId])).toEqual([['fix the run', 'ses_1']]);
    });

    it('a "+" meanwhile asks for no other session', () => {
        const { panel, of } = makePanel();
        type(panel, 'hello');
        panel.createNewSession();
        expect(of('chat.createSession')).toHaveLength(1);
    });

    it.each([
        ['the name prompt is cancelled', (panel: any) => panel.handleIncomingMessage('chat.sessionCreateAborted', {})],
        ['an error comes', (panel: any) => panel.handleIncomingMessage('chat.error', { message: 'agent failed to start' })],
        ['the agent goes', (panel: any) => panel.handleIncomingMessage('chat.connectionStatus', { connected: false, reason: 'exited' })],
    ])('the message goes back to the composer, and can be sent again, when %s', (_why, end) => {
        const { panel, of } = makePanel();
        type(panel, 'hello');
        end(panel);
        expect(panel.inputValue).toBe('hello');
        expect(panel.isLoadingSession).toBe(false);
        panel.sendMessage();
        expect(of('chat.createSession')).toHaveLength(2);
    });
});

describe('a session made with "+"', () => {
    it('starts on an empty transcript, not streaming a turn left in another', () => {
        const { panel } = makePanel();
        panel.currentSessionId = 'ses_0';
        panel.sendPrompt('in the old session', [], true);
        panel.createNewSession();
        created(panel, 'ses_1', 'Session 2');
        expect(said(panel)).toEqual(['system: Created session: Session 2']);
        expect(panel.isStreaming).toBe(false);
    });
});

describe('a refusal for a chat not shown', () => {
    it('is not said in the one shown, but what it says of the agent is kept', () => {
        const { panel } = makePanel();
        panel.currentSessionId = 'ses_A';
        panel.handleIncomingMessage('chat.messageNotSent', { sessionId: 'ses_B', reason: 'the agent does not read images', images: false });
        expect(said(panel)).toEqual([]);
        expect(panel.agentTakesImages).toBe(false);
    });
});
