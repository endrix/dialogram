import { describe, expect, it, vi } from 'vitest';

// `profile-runtime` imports `glsp-activation`, which pulls in
// `@eclipse-glsp/vscode-integration` (a CJS `require('vscode')` that escapes the
// vitest alias). `assembleChatRuntimeConfig` is a pure function that never
// touches the GLSP layer, so stub the module out — matching the guard in the
// sibling `profile-runtime-*.test.ts` suites — to import the module cleanly.
vi.mock('../src/extension/diagram/glsp-activation', () => ({
    activateGlspIntegration: vi.fn(async () => ({
        connector: {},
        editorProvider: {},
        executionOverlay: {},
        dispose: () => undefined
    }))
}));

import { assembleChatRuntimeConfig } from '../src/extension/profile-runtime';

function makeProfile(chat: Record<string, any>): any {
    return {
        key: 'mlirViewer',
        displayName: 'MLIR Viewer',
        settingsNamespace: 'mlir',
        commands: {},
        edits: 'read-only',
        chat: { name: 'mlir', fullName: 'MLIR Chat', operationPrefix: 'mlir', ...chat }
    };
}

function makeCapability(): any {
    return {
        slashCommands: [
            { command: 'create-task', description: 'cap', modes: ['build'], handler: async () => ({ success: true }) },
            { command: 'layout', description: 'cap-layout', handler: async () => ({ success: true }) }
        ],
        graphContextProvider: vi.fn(async () => 'capability-graph'),
        stdioMcpServers: vi.fn(() => []),
        postTurnHook: vi.fn(async () => undefined),
        dispose: () => undefined
    };
}

describe('assembleChatRuntimeConfig', () => {
    it('passes the profile chat-only fields through (read-only profile, no capability)', async () => {
        const tools = [{ name: 't', description: 'd', inputSchema: {}, handler: () => 'x' }];
        const turn = async () => [{ type: 'text', text: 'turn' }];
        const selection = { render: () => 'sel' };
        const slash = [{ command: 'explain', description: 'Explain an op' }];
        const cfg = assembleChatRuntimeConfig(
            makeProfile({ tools, turnContextProvider: turn, selectionContext: selection, slashCommands: slash, graphContextProvider: async () => 'profile-graph' }),
            undefined
        );
        expect(cfg.key).toBe('mlirViewer');
        expect(cfg.displayName).toBe('MLIR Chat');
        expect(cfg.settingsSection).toBe('mlir.chat');
        expect(cfg.tools).toBe(tools);
        expect(cfg.turnContextProvider).toBe(turn);
        expect(cfg.selectionContext).toBe(selection);
        expect(cfg.slashCommands).toEqual(slash);
        await expect(Promise.resolve(cfg.graphContextProvider!('/f.mlir'))).resolves.toBe('profile-graph');
        expect(cfg.stdioMcpServers).toBeUndefined();
        expect(cfg.postTurnHook).toBeUndefined();
    });

    it('capability graph provider wins over the profile field', async () => {
        const cfg = assembleChatRuntimeConfig(
            makeProfile({ graphContextProvider: async () => 'profile-graph' }),
            makeCapability()
        );
        await expect(Promise.resolve(cfg.graphContextProvider!('/f.py'))).resolves.toBe('capability-graph');
    });

    it('slash merge: capability first, profile appended (so profile can override by name)', () => {
        const cfg = assembleChatRuntimeConfig(
            makeProfile({ slashCommands: [{ command: 'layout', description: 'profile-layout' }] }),
            makeCapability()
        );
        expect(cfg.slashCommands!.map(c => c.command)).toEqual(['create-task', 'layout', 'layout']);
        expect(cfg.slashCommands![2].description).toBe('profile-layout');
    });

    it('absent optional fields stay undefined', () => {
        const cfg = assembleChatRuntimeConfig(makeProfile({}), undefined);
        expect(cfg.tools).toBeUndefined();
        expect(cfg.turnContextProvider).toBeUndefined();
        expect(cfg.selectionContext).toBeUndefined();
        expect(cfg.slashCommands).toEqual([]);
    });

    it('threads the GLSP-MCP url and marks glspMcpEnabled when the profile opts in', () => {
        const profile = { ...makeProfile({}), mcp: { enabled: true } };
        const cfg = assembleChatRuntimeConfig(profile, undefined, 'http://127.0.0.1:5123/mcp');
        expect(cfg.glspMcpEnabled).toBe(true);
        expect(cfg.mcpServerUrl).toBe('http://127.0.0.1:5123/mcp');
    });

    it('leaves glspMcpEnabled false when the profile omits mcp (0.4.x parity)', () => {
        const cfg = assembleChatRuntimeConfig(makeProfile({}), undefined, undefined);
        expect(cfg.glspMcpEnabled).toBe(false);
        expect(cfg.mcpServerUrl).toBeUndefined();
    });
});
