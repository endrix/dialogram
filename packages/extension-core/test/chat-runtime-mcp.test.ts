/**
 * GLSP-MCP parallel-run wiring (API 0.5.0). When the profile opts into GLSP-MCP
 * and surfaces a loopback URL, the chat runtime must hand opencode the GLSP-MCP
 * http descriptor ALONGSIDE the legacy MCP servers (parallel-run), gated by the
 * per-user `<ns>.chat.useGlspMcp` rollback setting. With the profile gate off the
 * descriptor list stays byte-identical to 0.4.x.
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

function providerOf(runtime: ChatRuntime): (file?: string) => any[] {
    return (runtime as any).acp.mcpServersProvider as (file?: string) => any[];
}

describe('ChatRuntime GLSP-MCP parallel-run', () => {
    afterEach(() => vi.restoreAllMocks());

    it('advertises the GLSP-MCP http descriptor alongside legacy servers when enabled', () => {
        const runtime = makeRuntime({
            glspMcpEnabled: true,
            mcpServerUrl: 'http://127.0.0.1:9/mcp',
            stdioMcpServers: () => [{ name: 'legacy-stdio', command: 'c', args: [] }]
        });
        const servers = providerOf(runtime)('file:///a.py');
        const glsp = servers.find(s => s.type === 'http' && s.url === 'http://127.0.0.1:9/mcp');
        expect(glsp).toBeDefined();
        expect(glsp.name).toBe('test-glsp');
        // opencode http shape: headers is an ARRAY (not a record).
        expect(Array.isArray(glsp.headers)).toBe(true);
        expect(glsp.headers).toEqual([]);
        // Parallel-run: the legacy stdio descriptor is still advertised.
        expect(servers.some(s => s.name === 'legacy-stdio')).toBe(true);
        runtime.dispose();
    });

    it('omits the GLSP-MCP descriptor when the profile did not opt in (0.4.x parity)', () => {
        const runtime = makeRuntime({
            glspMcpEnabled: false,
            mcpServerUrl: 'http://127.0.0.1:9/mcp',
            stdioMcpServers: () => [{ name: 'legacy-stdio', command: 'c', args: [] }]
        });
        const servers = providerOf(runtime)('file:///a.py');
        expect(servers.some(s => s.type === 'http')).toBe(false);
        expect(servers).toEqual([{ name: 'legacy-stdio', command: 'c', args: [] }]);
        runtime.dispose();
    });

    it('respects the useGlspMcp rollback setting when off', () => {
        vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
            get: (key: string, def?: unknown) => (key === 'useGlspMcp' ? false : def)
        } as any);
        const runtime = makeRuntime({
            glspMcpEnabled: true,
            mcpServerUrl: 'http://127.0.0.1:9/mcp'
        });
        const servers = providerOf(runtime)('file:///a.py');
        expect(servers.some(s => s.type === 'http')).toBe(false);
        runtime.dispose();
    });

    it('does not advertise an empty GLSP-MCP url', () => {
        const runtime = makeRuntime({ glspMcpEnabled: true, mcpServerUrl: '' });
        const servers = providerOf(runtime)('file:///a.py');
        expect(servers.some(s => s.type === 'http')).toBe(false);
        runtime.dispose();
    });

    it('honours the legacy workflow.chat.useGlspMcp kill-switch (no glsp entry AND no hint)', () => {
        // Reproduces the reported break: the user set the rollback lever under the
        // legacy `workflow.chat.useGlspMcp` key (the id historically advertised by
        // the platform manifest) — NOT the profile-namespaced `<ns>.chat` section.
        // The kill-switch must read through the neutral compat resolver so a legacy
        // `workflow.chat.useGlspMcp` value is honoured and both the MCP descriptor
        // and the usage hint are withheld.
        vi.spyOn(vscode.workspace, 'getConfiguration').mockImplementation(((section?: string) => {
            if (section === 'workflow.chat') {
                return {
                    get: (key: string, def?: unknown) => (key === 'useGlspMcp' ? false : def),
                    inspect: (key: string) =>
                        key === 'useGlspMcp' ? { workspaceValue: false } : undefined
                };
            }
            // Neutral `dialogram.chat` unset, and the profile settings section carries
            // no override either.
            return { get: (_key: string, def?: unknown) => def, inspect: (_key: string) => undefined };
        }) as any);
        const runtime = makeRuntime({
            glspMcpEnabled: true,
            mcpServerUrl: 'http://127.0.0.1:9/mcp'
        });
        const servers = providerOf(runtime)('file:///a.py');
        expect(servers.some(s => s.type === 'http')).toBe(false);
        const hintProvider = (runtime as any).acp.glspToolHintProvider as (f?: string) => string | undefined;
        expect(hintProvider('file:///a.py')).toBeUndefined();
        runtime.dispose();
    });
});
