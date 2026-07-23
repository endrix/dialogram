import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachAcpEventForwarding, type AcpEventSinks } from '../src/extension/chat/acp-event-forwarding';

class FakeAcp {
    private listeners = new Map<string, Array<(...a: any[]) => void>>();
    on(ev: string, fn: (...a: any[]) => void) {
        const arr = this.listeners.get(ev) ?? [];
        arr.push(fn);
        this.listeners.set(ev, arr);
        return this;
    }
    off(ev: string, fn: (...a: any[]) => void) {
        this.listeners.set(ev, (this.listeners.get(ev) ?? []).filter(f => f !== fn));
        return this;
    }
    emit(ev: string, ...a: any[]) {
        for (const fn of this.listeners.get(ev) ?? []) fn(...a);
    }
    count(ev: string) {
        return (this.listeners.get(ev) ?? []).length;
    }
}

const chunk = (sessionId: string, kind: string, text: string) => ({
    sessionId,
    update: { sessionUpdate: kind, content: { type: 'text', text } }
});

describe('attachAcpEventForwarding', () => {
    let acp: FakeAcp;
    let posts: Array<{ sessionId: string; payload: any }>;
    let broadcasts: any[];
    let turns: any[];
    let dispose: () => void;

    beforeEach(() => {
        vi.useFakeTimers();
        acp = new FakeAcp();
        posts = [];
        broadcasts = [];
        turns = [];
        const sinks: AcpEventSinks = {
            postToSession: (sessionId, payload) => posts.push({ sessionId, payload }),
            broadcast: payload => broadcasts.push(payload),
            onTurnComplete: data => turns.push(data)
        };
        dispose = attachAcpEventForwarding(acp as any, sinks);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('coalesces consecutive message chunks into one sessionUpdate', () => {
        acp.emit('sessionUpdate', chunk('s1', 'agent_message_chunk', 'Hel'));
        acp.emit('sessionUpdate', chunk('s1', 'agent_message_chunk', 'lo'));
        expect(posts).toHaveLength(0);
        vi.advanceTimersByTime(50);
        expect(posts).toHaveLength(1);
        expect(posts[0].payload.data.notification.update.content.text).toBe('Hello');
    });

    it('flushes buffered chunks before a non-chunk update to preserve order', () => {
        acp.emit('sessionUpdate', chunk('s1', 'agent_message_chunk', 'partial'));
        acp.emit('sessionUpdate', { sessionId: 's1', update: { sessionUpdate: 'tool_call' } });
        expect(posts.map(p => p.payload.data.notification.update.sessionUpdate)).toEqual([
            'agent_message_chunk',
            'tool_call'
        ]);
    });

    it('switching chunk kind (answer↔thinking) flushes the previous buffer', () => {
        acp.emit('sessionUpdate', chunk('s1', 'agent_thought_chunk', 'think'));
        acp.emit('sessionUpdate', chunk('s1', 'agent_message_chunk', 'answer'));
        expect(posts).toHaveLength(1);
        expect(posts[0].payload.data.notification.update.sessionUpdate).toBe('agent_thought_chunk');
    });

    it('turnComplete flushes then delegates to the sink', () => {
        acp.emit('sessionUpdate', chunk('s1', 'agent_message_chunk', 'tail'));
        acp.emit('turnComplete', { sessionId: 's1', text: 'tail' });
        expect(posts).toHaveLength(1); // the flushed chunk
        expect(turns).toEqual([{ sessionId: 's1', text: 'tail' }]);
    });

    it('broadcasts connection status and errors', () => {
        acp.emit('connected');
        acp.emit('disconnected');
        acp.emit('error', new Error('boom'));
        expect(broadcasts).toEqual([
            { type: 'chat.connectionStatus', data: { connected: true } },
            { type: 'chat.connectionStatus', data: { connected: false, reason: 'opencode disconnected' } },
            { type: 'chat.error', data: { message: 'boom' } }
        ]);
    });

    it('disposer removes every listener and pending timer', () => {
        acp.emit('sessionUpdate', chunk('s1', 'agent_message_chunk', 'x'));
        dispose();
        vi.advanceTimersByTime(100);
        expect(posts).toHaveLength(0);
        for (const ev of ['sessionUpdate', 'modeChanged', 'providerChanged', 'turnComplete', 'permissionRequest', 'connected', 'disconnected', 'error']) {
            expect(acp.count(ev)).toBe(0);
        }
    });
});
