/**
 * Chat panel connection handshake retry (client half of the "disconnected" race).
 *
 * If the extension host hasn't wired its chat messenger yet (it is still spawning
 * opencode), the panel's first `chat.ready` is dropped and no `connectionStatus`
 * ever arrives. Instead of giving up at 5s, the panel re-posts `chat.ready` with
 * backoff (attempts at 5s and 10s, 3 total) and only then surfaces the timeout —
 * and any `connectionStatus` that arrives cancels the pending retries.
 *
 * See .superpowers/sdd/chat-race-fix-report.md.
 */
import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatPanel } from '../src/chat-panel-integrated';

interface Sent {
    type: string;
    data: any;
}

/**
 * Build a panel wired to a recording messenger, with the DOM host left null
 * (all render/show paths guard on `this.panel`, so they are inert). Returns the
 * panel and the list of envelopes it posts to the host.
 */
function makePanel(): { panel: ChatPanel; sent: Sent[] } {
    const sent: Sent[] = [];
    // Stand in for the canonical channel: record what the panel sends to the host.
    const channel = {
        sendToHost: (_method: string, payload: Sent) => {
            sent.push(payload);
        }
    };
    const panel = new ChatPanel();
    (panel as any).channel = channel;
    return { panel, sent };
}

const readyPosts = (sent: Sent[]): Sent[] => sent.filter((m) => m.type === 'chat.ready');
const logsWith = (sent: Sent[], needle: string): Sent[] =>
    sent.filter((m) => m.type === 'chat.log' && String(m.data?.message ?? '').includes(needle));

describe('chat panel handshake retry', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('re-posts chat.ready at 5s and 10s, then surfaces the timeout after 3 attempts', () => {
        const { panel, sent } = makePanel();

        (panel as any).requestState();
        expect(readyPosts(sent).length).toBe(1); // initial attempt

        // 5s: no status yet → retry (attempt 2).
        vi.advanceTimersByTime(5000);
        expect(readyPosts(sent).length).toBe(2);
        expect(logsWith(sent, 'retrying chat.ready (attempt 2)').length).toBe(1);

        // 10s: still nothing → retry (attempt 3).
        vi.advanceTimersByTime(5000);
        expect(readyPosts(sent).length).toBe(3);
        expect(logsWith(sent, 'retrying chat.ready (attempt 3)').length).toBe(1);

        // 15s: final attempt unanswered → declare disconnected, no further posts.
        vi.advanceTimersByTime(5000);
        expect(readyPosts(sent).length).toBe(3);
        expect(logsWith(sent, 'TIMEOUT').length).toBe(1);
        expect((panel as any).connection).toBe('disconnected');
        expect((panel as any).connectionReason).toBe('No response from extension host');
    });

    it('a connectionStatus arrival cancels pending retries', () => {
        const { panel, sent } = makePanel();

        (panel as any).requestState();
        expect(readyPosts(sent).length).toBe(1);

        // One retry fires at 5s…
        vi.advanceTimersByTime(5000);
        expect(readyPosts(sent).length).toBe(2);

        // …then the host answers. This must cancel all remaining retries.
        (panel as any).handleIncomingMessage('chat.connectionStatus', { connected: true });
        expect((panel as any).connection).toBe('connected');

        vi.advanceTimersByTime(60000);
        expect(readyPosts(sent).length).toBe(2); // no attempt 3
        expect(logsWith(sent, 'TIMEOUT').length).toBe(0);
    });
});
