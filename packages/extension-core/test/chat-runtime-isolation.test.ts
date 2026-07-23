/**
 * Two ChatRuntime instances must be fully isolated — the property that lets
 * the host load ONE platform module for all profiles. (Successor to the
 * retired chat-backend-isolation test.)
 */
import { describe, expect, it } from 'vitest';
import { ChatRuntime } from '../src/extension/chat/chat-runtime';

function makeContext() {
    const store = new Map<string, unknown>();
    return {
        workspaceState: {
            get: <T>(key: string, defaultValue?: T): T | undefined =>
                store.has(key) ? (store.get(key) as T) : defaultValue,
            update: async (key: string, value: unknown): Promise<void> => {
                store.set(key, value);
            }
        },
        subscriptions: [] as Array<{ dispose(): void }>
    } as any;
}

describe('ChatRuntime isolation', () => {
    it('two runtimes keep separate selection state and sinks', async () => {
        const postsA: any[] = [];
        const postsB: any[] = [];
        const a = new ChatRuntime(makeContext(), { key: 'a', displayName: 'A', settingsSection: 'a.chat' }, (uri, p) => postsA.push({ uri, p }));
        const b = new ChatRuntime(makeContext(), { key: 'b', displayName: 'B', settingsSection: 'b.chat' }, (uri, p) => postsB.push({ uri, p }));

        a.setSelection('file:///x.py', ['n1']);
        await a.handleMessage('file:///x.py', { type: 'chat.getCommands', data: { mode: 'build' } });
        await b.handleMessage('file:///x.py', { type: 'chat.getCommands', data: { mode: 'build' } });

        expect(postsA).toHaveLength(1);
        expect(postsB).toHaveLength(1);
        a.dispose();
        b.dispose();
    });
});
