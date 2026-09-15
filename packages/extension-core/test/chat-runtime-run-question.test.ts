/**
 * The run driver's human port through the chat: `askRunQuestion` posts the
 * question to the panel on the diagram's URI and resolves with its
 * `chat.runAnswer`; no panel there means `undefined` (the driver then asks
 * through VS Code); the question's own timeout declines it.
 */
import { describe, it, expect, vi } from 'vitest';
import { ChatRuntime } from '../src/extension/chat/chat-runtime';
import type { ChatPayload } from '../src/api';

const URI = 'file:///tmp/flow.py';

function makeRuntime(canReach?: (uri: string) => boolean) {
    const posts: Array<{ uri: string; payload: ChatPayload }> = [];
    const memento = {
        get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue,
        update: async (): Promise<void> => undefined,
        keys: (): string[] => []
    };
    const context = { workspaceState: memento } as any;
    const runtime = new ChatRuntime(
        context,
        { key: 'test', displayName: 'Test', settingsSection: 'test.chat' } as any,
        (uri, payload) => posts.push({ uri, payload }),
        canReach
    );
    return { runtime, posts };
}

describe('ChatRuntime.askRunQuestion', () => {
    it('posts the question and resolves with the panel\'s answer', async () => {
        const { runtime, posts } = makeRuntime(() => true);
        const pending = runtime.askRunQuestion(URI, { id: 3, agent: 'planner', question: 'Apply?', choices: ['Allow', 'Reject'] });
        expect(posts).toEqual([{ uri: URI, payload: { type: 'chat.runQuestion', data: { id: 3, agent: 'planner', question: 'Apply?', choices: ['Allow', 'Reject'] } } }]);
        await runtime.handleMessage(URI, { type: 'chat.runAnswer', data: { id: 3, answer: 'Reject' } });
        await expect(pending).resolves.toEqual({ answer: 'Reject' });
    });

    it('relays a decline, and ignores an answer to nothing', async () => {
        const { runtime } = makeRuntime();
        const pending = runtime.askRunQuestion(URI, { id: 'q-4', agent: 'planner', question: 'Free?' });
        await runtime.handleMessage(URI, { type: 'chat.runAnswer', data: { id: 'other', answer: 'x' } });
        await runtime.handleMessage(URI, { type: 'chat.runAnswer', data: { id: 'q-4', declined: true, reason: 'no' } });
        await expect(pending).resolves.toEqual({ declined: true, reason: 'no' });
    });

    it('is undefined when no panel can be reached on that diagram', async () => {
        const { runtime, posts } = makeRuntime(() => false);
        await expect(runtime.askRunQuestion(URI, { id: 1, agent: 'a', question: 'q' })).resolves.toBeUndefined();
        expect(posts).toEqual([]);
    });

    it('declines on the question\'s timeout', async () => {
        vi.useFakeTimers();
        try {
            const { runtime } = makeRuntime();
            const pending = runtime.askRunQuestion(URI, { id: 9, agent: 'a', question: 'q', timeoutMs: 1000 });
            vi.advanceTimersByTime(1001);
            await expect(pending).resolves.toEqual({ declined: true, reason: 'timeout' });
        } finally {
            vi.useRealTimers();
        }
    });
});
