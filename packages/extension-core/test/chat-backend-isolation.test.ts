/**
 * Two ChatBackend instances must be fully isolated — this is the property
 * that lets the host load ONE platform module for all profiles instead of a
 * fresh require() per consumer.
 *
 * The vscode mock has no workspaceFolders, so initialize() takes its early
 * "No workspace folder open" exit — no opencode process is ever spawned.
 */
import { describe, it, expect } from 'vitest';
import { ChatBackend } from '../src/extension/chat/chat-backend';

function makeContext() {
    const store = new Map<string, unknown>();
    return {
        workspaceState: {
            get: <T>(key: string, defaultValue?: T): T | undefined =>
                (store.has(key) ? (store.get(key) as T) : defaultValue),
            update: async (key: string, value: unknown): Promise<void> => {
                store.set(key, value);
            }
        },
        subscriptions: [] as { dispose(): void }[]
    } as any;
}

function makeProfile(key: string) {
    return {
        key,
        displayName: key,
        settingsNamespace: `${key}Lang`,
        chat: { name: key, fullName: key.toUpperCase(), operationPrefix: key, skill: 'skill' },
        commands: { layoutDiagram: `${key}.layout`, layoutDiagramIfNeeded: `${key}.layoutIfNeeded` }
    } as any;
}

const STUB_EDIT_BACKEND = {
    exportGraph: async () => undefined,
    listCapabilities: async () => undefined,
    supportsOp: async () => true,
    applyNamedEdit: async () => ({ ok: true }),
    mcpServers: () => [],
    scopeArgs: () => ({})
} as any;
const NO_DEPS = { getConnector: () => undefined, getEditorProvider: () => undefined, editBackend: STUB_EDIT_BACKEND };

describe('ChatBackend per-profile isolation', () => {
    it('two instances hold independent state', async () => {
        const a = new ChatBackend(makeContext(), makeProfile('wfpy'), NO_DEPS);
        const b = new ChatBackend(makeContext(), makeProfile('calpy'), NO_DEPS);

        // No workspace folder in the mock → early-exit init failure, per instance.
        await a.initialize();
        expect(a.getStatus().connected).toBe(false);
        expect(a.getStatus().reason).toContain('No workspace folder');
        // b never initialized — its distinct default reason proves the state
        // is not shared between instances.
        expect(b.getStatus().reason).toBe('Chat backend not initialized');
    });

    it('preferred model is stored per instance context', () => {
        const a = new ChatBackend(makeContext(), makeProfile('wfpy'), NO_DEPS);
        const b = new ChatBackend(makeContext(), makeProfile('calpy'), NO_DEPS);
        a.setPreferredModel('provider/model-a');
        expect(a.getPreferredModel()).toBe('provider/model-a');
        expect(b.getPreferredModel()).toBeUndefined();
    });

    it('profile accessor returns the constructor profile', () => {
        const p = makeProfile('wfpy');
        const backend = new ChatBackend(makeContext(), p, NO_DEPS);
        expect(backend.getProfile()).toBe(p);
    });
});
