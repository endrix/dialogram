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
