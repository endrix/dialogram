/**
 * A confirmation put to the person in the chat (resuming a run the chat
 * fixed): `confirmInChat` posts a card to the panel on the diagram's URI and
 * resolves with the button pressed; no panel there means `undefined`, so the
 * caller asks another way.
 */
import { describe, it, expect } from 'vitest';
import { ChatRuntime } from '../src/extension/chat/chat-runtime';
import type { ChatPayload } from '../src/api';

const URI = 'file:///w/top.py';

function makeRuntime(canReach?: (uri: string) => boolean) {
    const posts: Array<{ uri: string; payload: ChatPayload }> = [];
    const memento = {
        get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue,
        update: async (): Promise<void> => undefined,
        keys: (): string[] => []
    };
    const runtime = new ChatRuntime(
        { workspaceState: memento } as any,
        { key: 'test', displayName: 'Test', settingsSection: 'test.chat' } as any,
        (uri, payload) => posts.push({ uri, payload }),
        canReach
    );
    return { runtime, posts };
}

const confirm = { title: 'Resume the failed run', text: 'Resume?', choices: ['Resume', 'Not now'] };

describe('ChatRuntime.confirmInChat', () => {
    it('posts the card and resolves with the button pressed', async () => {
        const { runtime, posts } = makeRuntime(() => true);
        const pending = runtime.confirmInChat(URI, confirm);
        expect(posts).toHaveLength(1);
        expect(posts[0].uri).toBe(URI);
        expect(posts[0].payload).toMatchObject({ type: 'chat.confirm', data: confirm });
        const id = (posts[0].payload as any).data.id;

        await runtime.handleMessage(URI, { type: 'chat.confirmAnswer', data: { id: 'other', choice: 'Not now' } });
        await runtime.handleMessage(URI, { type: 'chat.confirmAnswer', data: { id, choice: 'Resume' } });
        await expect(pending).resolves.toEqual({ choice: 'Resume' });
    });

    it('resolves with no choice when declined', async () => {
        const { runtime, posts } = makeRuntime();
        const pending = runtime.confirmInChat(URI, confirm);
        await runtime.handleMessage(URI, { type: 'chat.confirmAnswer', data: { id: (posts[0].payload as any).data.id } });
        await expect(pending).resolves.toEqual({});
    });

    it('is undefined when no panel can be reached on that diagram', async () => {
        const { runtime, posts } = makeRuntime(() => false);
        await expect(runtime.confirmInChat(URI, confirm)).resolves.toBeUndefined();
        expect(posts).toEqual([]);
    });
});
