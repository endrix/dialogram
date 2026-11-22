// @vitest-environment happy-dom
/**
 * A message sent with no chat open: the panel asks for a session first (no
 * name asked), shows "Creating session…", and sends the message once the
 * session exists, as a task's message is sent. Each request carries an id
 * the host says back, so the panel tells the session it waits for from one
 * it left. Until it comes another message waits in the composer; a chat
 * picked, or a task, meanwhile wins, and the waiting message goes back to
 * the composer, as it does when the host says the session was not made.
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

/** The host's answer to the request the panel waits for, unless another is named. */
const created = (panel: any, id: string, name: string, requestId: string = panel.createRequest) =>
    panel.handleIncomingMessage('chat.sessionCreated', { session: { id, name }, requestId });

const asked = (of: (type: string) => any[]) => of('chat.createSession').map(({ requestId: _id, ...rest }) => rest);

beforeEach(() => {
    (globalThis as any).requestAnimationFrame = () => 1;
    (globalThis as any).cancelAnimationFrame = () => undefined;
});

describe('the first message, sent with no chat open', () => {
    it('asks for a session (no name asked), and is sent into it once it exists, after the line that says so', () => {
        const { panel, of } = makePanel();
        panel.pushMessage('system', 'This chat was deleted in another window.');
        type(panel, 'Remember the word HERON.');

        expect(asked(of)).toEqual([{ mode: 'build', ask: false }]);
        expect(of('chat.createSession')[0].requestId).toEqual(expect.any(String));
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

    it('a task asked for meanwhile gets its own session, named and in its mode; the typed message goes back', () => {
        const { panel, of } = makePanel();
        type(panel, 'hello');
        const first = panel.createRequest;
        panel.handleIncomingMessage('chat.startTask', { prompt: 'fix the run', mode: 'plan', name: 'Fix' });
        expect(panel.inputValue).toBe('hello');
        expect(asked(of)).toEqual([{ mode: 'build', ask: false }, { mode: 'plan', name: 'Fix' }]);
        // The first one, made after all: listed, not shown.
        created(panel, 'ses_1', 'Session 1', first);
        expect(panel.currentSessionId).toBeNull();
        created(panel, 'ses_2', 'Fix');
        expect(panel.currentSessionId).toBe('ses_2');
        expect(of('chat.sendMessage').map((d) => [d.text, d.sessionId, d.mode])).toEqual([['fix the run', 'ses_2', 'plan']]);
    });

    it('a task asked for while "+" waits on its name: the task\'s own session; a cancelled name drops nothing', () => {
        const { panel, of } = makePanel();
        panel.currentSessionId = 'ses_0';
        panel.createNewSession();
        const plus = panel.createRequest;
        panel.handleIncomingMessage('chat.startTask', { prompt: 'fix the run', mode: 'build', name: 'Fix' });
        panel.handleIncomingMessage('chat.sessionCreateAborted', { requestId: plus });
        expect(panel.isLoadingSession).toBe(true);
        created(panel, 'ses_2', 'Fix');
        expect(of('chat.sendMessage').map((d) => [d.text, d.sessionId])).toEqual([['fix the run', 'ses_2']]);
    });

    it('an error that is not the session\'s does not stop the wait: "+" still shows the session it made', () => {
        const { panel } = makePanel();
        panel.currentSessionId = 'ses_0';
        panel.sendPrompt('in the old session', [], true);
        panel.createNewSession();
        panel.handleIncomingMessage('chat.error', { message: 'the turn failed' });
        panel.handleIncomingMessage('chat.connectionStatus', { connected: false, reason: 'restarting' });
        created(panel, 'ses_1', 'Session 2');
        expect(panel.currentSessionId).toBe('ses_1');
    });

    it('a "+" meanwhile asks for its own session, and the message goes there; the first one is only listed', () => {
        const { panel, of } = makePanel();
        type(panel, 'hello');
        const first = panel.createRequest;
        panel.createNewSession();
        expect(of('chat.createSession')).toHaveLength(2);
        created(panel, 'ses_1', 'Session 1', first);
        expect(panel.currentSessionId).toBeNull();
        created(panel, 'ses_2', 'Named');
        expect(of('chat.sendMessage').map((d) => [d.text, d.sessionId])).toEqual([['hello', 'ses_2']]);
    });

    it('handed back, the message goes before what was written since, not instead of it', () => {
        const { panel } = makePanel();
        type(panel, 'first');
        type(panel, 'second');
        panel.handleIncomingMessage('chat.sessionCreateAborted', { requestId: panel.createRequest });
        expect(panel.inputValue).toBe('first\n\nsecond');
    });

    it('a chat drawn meanwhile (no chat was open) leaves the session asked for', () => {
        const { panel } = makePanel();
        type(panel, 'hello');
        const asked = panel.createRequest;
        panel.handleIncomingMessage('chat.sessionHistory', { sessionId: 'ses_X', messages: [] });
        expect(panel.inputValue).toBe('hello');
        created(panel, 'ses_new', 'Session 1', asked);
        expect(panel.currentSessionId).toBe('ses_X');
    });

    it('an error keeps "Creating session…" while the session is awaited, and the session still comes', () => {
        const { panel, of } = makePanel();
        type(panel, 'hello');
        panel.handleIncomingMessage('chat.error', { message: 'something else failed' });
        expect(panel.isLoadingSession).toBe(true);
        created(panel, 'ses_1', 'Session 1');
        expect(of('chat.sendMessage').map((d) => [d.text, d.sessionId])).toEqual([['hello', 'ses_1']]);
    });

    it('an answer that names no session hands the message back', () => {
        const { panel } = makePanel();
        type(panel, 'hello');
        panel.handleIncomingMessage('chat.sessionCreated', { requestId: panel.createRequest, session: {} });
        expect(panel.inputValue).toBe('hello');
        expect(panel.pendingSend).toBeUndefined();
    });

    it('not asked (no way to the host): the message goes back, and says why', () => {
        const { panel } = makePanel();
        panel.channel = undefined;
        type(panel, 'hello');
        expect(panel.inputValue).toBe('hello');
        expect(panel.isLoadingSession).toBe(false);
        expect(panel.createRequest).toBeUndefined();
        expect(said(panel)).toEqual(['system: Error: VS Code API not available in webview']);
    });

    it.each([
        ['says it was not made', (panel: any) => panel.handleIncomingMessage('chat.sessionCreateAborted', { requestId: panel.createRequest })],
        ['names no request (an older host)', (panel: any) => panel.handleIncomingMessage('chat.sessionCreateAborted', {})],
    ])('the message goes back to the composer, and can be sent again, when the host %s', (_why, end) => {
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

describe('from a host that names no request', () => {
    it('"+" is shown, though a chat was', () => {
        const { panel } = makePanel();
        panel.currentSessionId = 'ses_0';
        panel.createNewSession();
        panel.handleIncomingMessage('chat.sessionCreated', { session: { id: 'ses_1', name: 'Session 2' } });
        expect(panel.currentSessionId).toBe('ses_1');
    });
});

describe('a refusal for a chat not shown', () => {
    it('leaves the message sent since in the chat shown', () => {
        const { panel } = makePanel();
        panel.currentSessionId = 'ses_A';
        type(panel, 'in A');
        panel.handleIncomingMessage('chat.turnEnd', { sessionId: 'ses_A' });
        panel.loadSession('ses_B');
        panel.handleIncomingMessage('chat.sessionHistory', { sessionId: 'ses_B', messages: [] });
        type(panel, 'in B');
        panel.handleIncomingMessage('chat.messageNotSent', { sessionId: 'ses_A', reason: 'the agent does not read images', images: false });
        expect(said(panel)).toEqual(['user: in B']);
        expect(panel.inputValue).toBe('');
    });

    it('is not said in the one shown; the message goes back to the composer, and what it says of the agent is kept', () => {
        const { panel } = makePanel();
        panel.currentSessionId = 'ses_A';
        type(panel, 'look at this');
        panel.handleIncomingMessage('chat.turnEnd', { sessionId: 'ses_A' });
        panel.loadSession('ses_B');
        panel.handleIncomingMessage('chat.sessionHistory', { sessionId: 'ses_B', messages: [] });
        panel.handleIncomingMessage('chat.messageNotSent', { sessionId: 'ses_A', reason: 'the agent does not read images', images: false });
        expect(said(panel)).toEqual([]);
        expect(panel.inputValue).toBe('look at this');
        expect(panel.agentTakesImages).toBe(false);
    });
});

describe('a history for a chat left since', () => {
    it('comes late, and is not drawn over the chat shown', () => {
        const { panel } = makePanel();
        panel.loadSession('ses_A');
        panel.createNewSession();
        created(panel, 'ses_new', 'Session 2');
        panel.handleIncomingMessage('chat.sessionHistory', { sessionId: 'ses_A', messages: [{ role: 'user', content: 'old' }] });
        expect(panel.currentSessionId).toBe('ses_new');
        expect(said(panel)).toEqual(['system: Created session: Session 2']);
    });
});
