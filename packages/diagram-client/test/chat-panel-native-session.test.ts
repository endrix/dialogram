/**
 * The session header's "open in the agent's CLI" and "copy session id"
 * buttons ask the host, naming the shown session; nothing without one.
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { ChatPanel } from '../src/chat-panel-integrated';

function makePanel() {
    const panel = new ChatPanel();
    const sent: Array<{ type: string; data: any }> = [];
    (panel as any).channel = { sendToHost: (_method: string, env: any) => void sent.push(env) };
    return { panel, sent };
}

describe('the session’s native-CLI buttons', () => {
    it('ask the host to open, or copy, the shown session', () => {
        const { panel, sent } = makePanel();
        (panel as any).currentSessionId = 's1';
        (panel as any).openSessionNatively();
        (panel as any).copySessionId();
        expect(sent.map(m => [m.type, m.data])).toEqual([
            ['chat.openSessionNatively', { sessionId: 's1' }],
            ['chat.copySessionId', { sessionId: 's1' }]
        ]);
    });

    it('do nothing without a session', () => {
        const { panel, sent } = makePanel();
        (panel as any).openSessionNatively();
        expect(sent).toEqual([]);
    });
});
