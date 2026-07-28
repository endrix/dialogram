/**
 * GLSP-MCP context hint (id/sessionId semantics). Agents driving the GLSP-MCP
 * tools waste calls guessing element IDs (using the `<clientId>_` prefixed DOM
 * ids exported by diagram-svg/-png, or fabricated numeric ids). When — and only
 * when — the GLSP-MCP server is actually advertised to the agent, the runtime
 * teaches the correct id/sessionId semantics through the session context. With
 * the profile gate off (or the per-user rollback off, or no URL) no hint leaks.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { ChatRuntime } from '../src/extension/chat/chat-runtime';

function makeRuntime(config: Record<string, any> = {}): ChatRuntime {
    const memento = {
        get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue,
        update: async (): Promise<void> => undefined,
        keys: (): string[] => []
    };
    const context = { workspaceState: memento } as any;
    const fullConfig = {
        key: 'test',
        displayName: 'Test',
        settingsSection: 'test.chat',
        ...config
    } as any;
    return new ChatRuntime(context, fullConfig, () => undefined);
}

function hintProviderOf(runtime: ChatRuntime): (file?: string) => string | undefined {
    return (runtime as any).acp.glspToolHintProvider as (file?: string) => string | undefined;
}

describe('ChatRuntime GLSP-MCP context hint', () => {
    afterEach(() => vi.restoreAllMocks());

    it('teaches id/sessionId semantics when the GLSP server is advertised', () => {
        const runtime = makeRuntime({
            glspMcpEnabled: true,
            mcpServerUrl: 'http://127.0.0.1:9/mcp'
        });
        const hint = hintProviderOf(runtime)('file:///a.py');
        expect(hint).toBeDefined();
        // Names the advertised server so the agent can find its tools.
        expect(hint).toContain('test-glsp');
        // The sessionId source.
        expect(hint).toContain('session-info');
        // The authoritative id sources.
        expect(hint).toContain('query-elements');
        // The caveat about diagram-svg/-png embedded ids carrying a prefix.
        expect(hint).toMatch(/prefix/i);
        expect(hint).toContain('diagram-svg');
        // Undoable edit tools.
        expect(hint!.toLowerCase()).toContain('undo');
        runtime.dispose();
    });

    it('omits the hint when the profile did not opt into GLSP-MCP', () => {
        const runtime = makeRuntime({
            glspMcpEnabled: false,
            mcpServerUrl: 'http://127.0.0.1:9/mcp'
        });
        expect(hintProviderOf(runtime)('file:///a.py')).toBeUndefined();
        runtime.dispose();
    });

    it('omits the hint when the useGlspMcp rollback setting is off', () => {
        vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
            get: (key: string, def?: unknown) => (key === 'useGlspMcp' ? false : def)
        } as any);
        const runtime = makeRuntime({
            glspMcpEnabled: true,
            mcpServerUrl: 'http://127.0.0.1:9/mcp'
        });
        expect(hintProviderOf(runtime)('file:///a.py')).toBeUndefined();
        runtime.dispose();
    });

    it('omits the hint when no GLSP url is advertised', () => {
        const runtime = makeRuntime({ glspMcpEnabled: true, mcpServerUrl: '' });
        expect(hintProviderOf(runtime)('file:///a.py')).toBeUndefined();
        runtime.dispose();
    });
});
