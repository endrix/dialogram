/**
 * A session handed over to the agent's own CLI: the panel says where it is,
 * sends nothing meanwhile, and offers the way back. The host stopped the
 * chat's agent for as long (extension-core's chat-runtime-hand-over.test.ts).
 */
import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nothing } from 'lit';
import { ChatPanel } from '../src/chat-panel-integrated';

function makePanel() {
    const panel = new ChatPanel();
    const sent: Array<{ type: string; data: any }> = [];
    (panel as any).channel = { sendToHost: (_method: string, env: any) => void sent.push(env) };
    (panel as any).show = () => undefined;
    const receive = (type: string, data?: any) => (panel as any).handleIncomingMessage(type, data);
    const lines = (): string[] => (panel as any).timeline.map((row: any) => String(row.content ?? ''));
    const banner = (): string => {
        const template = (panel as any).handOverBannerTemplate();
        return template === nothing ? '' : JSON.stringify(template.values);
    };
    return { panel, sent, receive, lines, banner };
}

beforeEach(() => {
    (globalThis as any).requestAnimationFrame = () => 1;
    (globalThis as any).cancelAnimationFrame = () => undefined;
});
afterEach(() => {
    delete (globalThis as any).requestAnimationFrame;
    delete (globalThis as any).cancelAnimationFrame;
});

const HANDED_OVER = { sessionId: 's1', agent: 'codex', terminalOpen: true };

describe('a click on the CLI button while a turn is running', () => {
    it('asks the host for nothing, says why, and keeps the turn', () => {
        const { panel, sent, receive, lines } = makePanel();
        receive('chat.connectionStatus', { connected: true, agent: 'codex' });
        (panel as any).currentSessionId = 's1';
        (panel as any).setStreaming(true);
        (panel as any).streamingText = 'So far';
        sent.length = 0;
        (panel as any).openSessionNatively();
        expect(sent.filter(m => m.type === 'chat.openSessionNatively')).toEqual([]);
        expect((panel as any).isStreaming).toBe(true);
        // The turn's text so far, then the line: in the order they came.
        expect(lines().slice(-2)).toEqual([
            'So far',
            "Not opened: a turn is running. The session can be opened in codex's CLI once the turn has ended, or after you stop it."
        ]);
    });

    it('opens it once the turn has ended', () => {
        const { panel, sent } = makePanel();
        (panel as any).currentSessionId = 's1';
        (panel as any).setStreaming(true);
        (panel as any).openSessionNatively();
        (panel as any).setStreaming(false);
        (panel as any).openSessionNatively();
        expect(sent.filter(m => m.type === 'chat.openSessionNatively').map(m => m.data)).toEqual([{ sessionId: 's1' }]);
    });
});

describe('a session handed over to the agent’s CLI', () => {
    it('is said once, in the timeline and in a banner that offers the return', () => {
        const { receive, lines, banner } = makePanel();
        expect(banner()).toBe('');
        receive('chat.handedOver', HANDED_OVER);
        receive('chat.handedOver', HANDED_OVER);
        expect(lines().filter(line => line.includes("open in codex's CLI"))).toHaveLength(1);
        expect(banner()).toContain("The session continues in codex's CLI");
    });

    it('does not read the disconnect that follows as a fault', () => {
        const { receive, lines, panel } = makePanel();
        receive('chat.connectionStatus', { connected: true, agent: 'codex' });
        receive('chat.handedOver', HANDED_OVER);
        receive('chat.connectionStatus', { connected: false, reason: 'codex disconnected', agent: 'codex' });
        expect(lines().some(line => line.startsWith('Not connected'))).toBe(false);
        expect(JSON.stringify((panel as any).topbarTemplate().values)).toContain('In the CLI · codex');
    });

    it('still reads a disconnect without a hand-over as one', () => {
        const { receive, lines } = makePanel();
        receive('chat.connectionStatus', { connected: false, reason: 'codex disconnected', agent: 'codex' });
        expect(lines().some(line => line.startsWith('Not connected: codex disconnected'))).toBe(true);
    });

    it('sends no message: it stays in the composer, and the reason is said', () => {
        const { panel, sent, receive, lines } = makePanel();
        (panel as any).currentSessionId = 's1';
        receive('chat.handedOver', HANDED_OVER);
        (panel as any).inputValue = 'and now?';
        (panel as any).sendMessage();
        expect(sent.filter(m => m.type === 'chat.sendMessage')).toEqual([]);
        expect((panel as any).inputValue).toBe('and now?');
        expect(lines()[lines().length - 1]).toBe("Not sent: a session is open in codex's CLI. Return to the chat first.");
    });

    it('asks the host for nothing its stopped agent would have to do', () => {
        const { panel, sent, receive, lines } = makePanel();
        (panel as any).currentSessionId = 's1';
        receive('chat.handedOver', HANDED_OVER);
        sent.length = 0;
        (panel as any).createNewSession();
        (panel as any).loadSession('s2');
        (panel as any).deleteCurrentSession();
        (panel as any).requestRevert('m1');
        (panel as any).requestUnrevert();
        (panel as any).switchProvider('model-b');
        // The panel's own log lines aside, nothing went to the host.
        const asked = () => sent.filter(m => m.type !== 'chat.log').map(m => m.type);
        expect(asked()).toEqual([]);
        expect((panel as any).isLoadingSession).toBe(false);
        expect((panel as any).currentModel).toBe('');
        expect(lines()[lines().length - 1]).toBe("Not done: a session is open in codex's CLI. Return to the chat first.");
        // Its id is still copied, and its terminal shown again.
        (panel as any).copySessionId();
        (panel as any).openSessionNatively();
        expect(asked()).toEqual(['chat.copySessionId', 'chat.openSessionNatively']);
    });

    it('says when the terminal is closed, and keeps the way back', () => {
        const { receive, banner } = makePanel();
        receive('chat.handedOver', HANDED_OVER);
        receive('chat.handedOver', { ...HANDED_OVER, terminalOpen: false });
        expect(banner()).toContain("The terminal of codex's CLI is closed.");
    });

    it('asks the host for the return, naming the session', () => {
        const { panel, sent, receive } = makePanel();
        (panel as any).returnToChat();
        expect(sent).toEqual([]);
        receive('chat.handedOver', HANDED_OVER);
        (panel as any).returnToChat();
        expect(sent.map(m => [m.type, m.data])).toEqual([['chat.returnToChat', { sessionId: 's1' }]]);
    });

    it('is over when the host says the chat has the session back: models and sessions are asked for again', () => {
        const { panel, sent, receive, lines, banner } = makePanel();
        (panel as any).currentSessionId = 's1';
        receive('chat.handedOver', HANDED_OVER);
        sent.length = 0;
        receive('chat.returnedToChat', { sessionId: 's1', agent: 'codex' });
        expect(banner()).toBe('');
        expect(lines()[lines().length - 1]).toContain("Back from codex's CLI.");
        expect(sent.map(m => m.type)).toEqual(expect.arrayContaining(['chat.getProviders', 'chat.getSessions']));
        (panel as any).inputValue = 'back';
        (panel as any).sendMessage();
        expect(sent.some(m => m.type === 'chat.sendMessage')).toBe(true);
    });
});

describe('a later word on the same hand-over', () => {
    it('gives up nothing the panel waits for since: the terminal closed, a return that failed', () => {
        const { panel, receive, lines } = makePanel();
        receive('chat.handedOver', HANDED_OVER);
        const said = lines().length;
        // Asked for after the hand-over was said: a later word on it leaves it waiting.
        (panel as any).isLoadingSession = true;
        (panel as any).createRequest = 'r2';
        receive('chat.handedOver', { ...HANDED_OVER, terminalOpen: false });
        expect((panel as any).isLoadingSession).toBe(true);
        expect((panel as any).createRequest).toBe('r2');
        expect(lines()).toHaveLength(said);
    });
});

describe('what a panel was waiting for when the session is handed over', () => {
    it('gives up a session being made: a message that waited goes back to the composer', () => {
        const { panel, sent, receive } = makePanel();
        (panel as any).inputValue = 'my question';
        (panel as any).sendMessage();
        expect((panel as any).isLoadingSession).toBe(true);
        receive('chat.handedOver', HANDED_OVER);
        expect((panel as any).isLoadingSession).toBe(false);
        expect((panel as any).pendingSend).toBeUndefined();
        expect((panel as any).inputValue).toBe('my question');
        // The session the host made after all is not sent the message.
        sent.length = 0;
        receive('chat.returnedToChat', { sessionId: 's1', agent: 'codex' });
        expect(sent.filter(m => m.type === 'chat.sendMessage')).toEqual([]);
    });

    it('drops a task’s prompt: it is not sent into the next session', () => {
        const { panel, sent, receive } = makePanel();
        receive('chat.startTask', { prompt: 'Fix the run', mode: 'build', name: 'Fix' });
        expect((panel as any).pendingSend?.text).toBe('Fix the run');
        receive('chat.handedOver', HANDED_OVER);
        expect((panel as any).pendingSend).toBeUndefined();
        expect((panel as any).isLoadingSession).toBe(false);
        expect((panel as any).inputValue).toBe('');
        receive('chat.returnedToChat', { sessionId: 's1', agent: 'codex' });
        sent.length = 0;
        receive('chat.sessionCreated', { sessionId: 's9', mode: 'plan' });
        expect(sent.filter(m => m.type === 'chat.sendMessage')).toEqual([]);
    });

    it('starts no task during the hand-over, and says why', () => {
        const { panel, sent, receive, lines } = makePanel();
        receive('chat.handedOver', HANDED_OVER);
        sent.length = 0;
        receive('chat.startTask', { prompt: 'Fix the run', mode: 'build', name: 'Fix' });
        expect(sent.filter(m => m.type === 'chat.createSession')).toEqual([]);
        expect((panel as any).pendingSend).toBeUndefined();
        expect((panel as any).isLoadingSession).toBe(false);
        expect(lines().at(-1)).toBe("Not done: a session is open in codex's CLI. Return to the chat first.");
    });

    it('asks the host for no mode during the hand-over: it goes with the next message', () => {
        const { panel, sent, receive } = makePanel();
        (panel as any).currentSessionId = 's1';
        receive('chat.handedOver', HANDED_OVER);
        sent.length = 0;
        (panel as any).switchMode('plan');
        expect(sent.filter(m => m.type === 'chat.setMode')).toEqual([]);
        expect((panel as any).currentMode).toBe('plan');
    });
});

describe('a chat with no message that the agent did not keep through a hand-over', () => {
    const NOT_KEPT =
        'This chat had no message yet, and the agent did not keep it when it was stopped for its CLI. Send again to start a new chat.';

    it('has its message back in the composer, says why, and sends it into a new chat', () => {
        const { panel, sent, receive, lines } = makePanel();
        (panel as any).currentSessionId = 's2';
        (panel as any).inputValue = 'first words';
        (panel as any).sendMessage();
        expect(sent.filter(m => m.type === 'chat.sendMessage')).toHaveLength(1);
        // What the host answers for such a chat, in its order.
        receive('chat.messageNotSent', { sessionId: 's2', reason: 'the agent did not keep this chat' });
        receive('chat.turnEnd', { sessionId: 's2' });
        receive('chat.sessionDeleted', { sessionId: 's2', reason: NOT_KEPT });
        expect((panel as any).inputValue).toBe('first words');
        expect((panel as any).isStreaming).toBe(false);
        expect((panel as any).currentSessionId).toBeNull();
        expect(lines()).toEqual([NOT_KEPT]);
        sent.length = 0;
        (panel as any).sendMessage();
        expect(sent.filter(m => m.type === 'chat.createSession')).toHaveLength(1);
    });
});
