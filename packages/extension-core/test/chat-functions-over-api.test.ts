// The chat functions a product declares on its profile survive the
// cross-extension API (`DialogramApi.activateDiagramProfile`), and are called.
//
// `api.ts` said otherwise: that the function-valued fields of `chat` were safe
// only in library mode and never populated over the API. Every extension runs
// in the one extension-host realm, and the API hands the platform the
// consumer's profile object itself, so a plain function crosses as written.
// Only DI objects do not (a GLSP DiagramModule, a ContainerModule), and the
// boundary refuses those.
//
// The path here is the real one from the API inward: the extension's
// `activate()` (packages/extension/src/main.ts), loading a platform module
// from `dist/platform.cjs` as it does in VS Code, whose `activateProfileRuntime`
// is the real one; the chat runtime it builds is the real one. Only the GLSP
// integration is stubbed (no diagram server), and the agent is never started
// and never sent a prompt: no model turn is taken.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { DiagramProfile, DialogramApi, InProcessChatTool } from '../src/api';

const hoisted = vi.hoisted(() => ({
    runtime: undefined as any,
    toHost: undefined as ((env: any, sender: any) => void) | undefined,
    sent: [] as Array<{ type: string; data: any }>
}));

vi.mock('../src/extension/diagram/glsp-activation', () => ({
    activateGlspIntegration: vi.fn(async () => ({
        // The chat travels over the GLSP connector's messenger.
        connector: {
            messenger: {
                onNotification: (_type: unknown, handler: (env: any, sender: any) => void) => { hoisted.toHost = handler; },
                sendNotification: (_type: unknown, _to: unknown, payload: { type: string; data: any }) => { hoisted.sent.push(payload); }
            }
        },
        editorProvider: { postLoadingToDocument: () => undefined, postToWebview: () => undefined, dispatchToWebview: () => undefined },
        executionOverlay: {},
        mcpServerUrl: undefined,
        setRunQuestionHandler: () => undefined,
        setChatTaskHandler: () => undefined,
        setChatConfirmHandler: () => undefined,
        dispose: () => undefined
    }))
}));

// The real chat runtime, kept where the test can reach it.
vi.mock('../src/extension/chat/chat-runtime', async (importOriginal) => {
    const original = await importOriginal<typeof import('../src/extension/chat/chat-runtime')>();
    class KeptChatRuntime extends original.ChatRuntime {
        constructor(...args: ConstructorParameters<typeof original.ChatRuntime>) {
            super(...args);
            hoisted.runtime = this;
        }
    }
    return { ...original, ChatRuntime: KeptChatRuntime };
});

const { activateProfileRuntime } = await import('../src/extension/profile-runtime');
const { activate } = await import('../../extension/src/main');

let scratch: string;
let sourceFile: string;

beforeAll(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dialogram-chat-api-'));
    // What `activate()` loads: the platform bundle. Here a module that hands
    // over the platform's own `activateProfileRuntime`.
    fs.mkdirSync(path.join(scratch, 'dist'));
    fs.writeFileSync(path.join(scratch, 'dist', 'platform.cjs'), 'module.exports = globalThis.__dialogramChatApiTestPlatform;\n');
    (globalThis as any).__dialogramChatApiTestPlatform = {
        activateProfileRuntime,
        createSidecarDiagramProfile: () => { throw new Error('not used'); }
    };
    sourceFile = path.join(scratch, 'top.dsl');
    fs.writeFileSync(sourceFile, 'module top\n');
});

afterAll(() => {
    hoisted.runtime?.dispose?.();
    delete (globalThis as any).__dialogramChatApiTestPlatform;
    fs.rmSync(scratch, { recursive: true, force: true });
});

function consumerContext() {
    return {
        subscriptions: [] as { dispose(): void }[],
        workspaceState: {
            get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue,
            update: async (): Promise<void> => undefined,
            keys: (): string[] => []
        }
    } as any;
}

describe('a product\'s chat functions, over activateDiagramProfile', () => {
    const toolHandler = vi.fn(async (file: string, args: Record<string, unknown>) => `summary of ${path.basename(file)} at ${String(args.depth)}`);
    const graphContextProvider = vi.fn(async (file: string) => JSON.stringify({ file: path.basename(file), cells: 3 }));
    const turnContextProvider = vi.fn(async (file: string, selected: string[]) => [
        { type: 'text', text: `selected in ${path.basename(file)}: ${selected.join(',')}` }
    ]);
    const slashHandler = vi.fn(async (args: Record<string, any>) => ({ success: true, info: `explained ${String(args._raw)}` }));
    const tool: InProcessChatTool = {
        name: 'design_summary',
        description: 'Summarise the design',
        inputSchema: { type: 'object', properties: { depth: { type: 'number' } } },
        handler: toolHandler
    };
    const profile = {
        key: 'fixture',
        displayName: 'Fixture Viewer',
        settingsNamespace: 'fixture',
        customEditorViewType: 'fixture.diagram',
        glspClientId: 'fixture.glsp',
        glspClientName: 'fixture',
        commands: {} as DiagramProfile['commands'],
        edits: 'read-only',
        chat: {
            fullName: 'Fixture Chat',
            tools: [tool],
            graphContextProvider,
            turnContextProvider,
            slashCommands: [{ command: 'explain', description: 'Explain a cell', handler: slashHandler }]
        }
    } satisfies DiagramProfile;

    let api: DialogramApi;

    beforeAll(async () => {
        const platformContext = { extensionPath: scratch, extensionUri: vscode.Uri.file(scratch) } as unknown as vscode.ExtensionContext;
        api = activate(platformContext);
        await api.activateDiagramProfile(consumerContext(), profile);
    });

    it('passes the boundary, and the runtime holds the product\'s own functions', () => {
        const config = hoisted.runtime.config;
        expect(config.tools[0]).toBe(tool);
        expect(config.graphContextProvider).toBe(graphContextProvider);
        expect(config.turnContextProvider).toBe(turnContextProvider);
        expect(config.slashCommands.find((c: any) => c.command === 'explain')?.handler).toBe(slashHandler);
    });

    it('calls the tool when the agent calls it over the chat\'s MCP server', async () => {
        await hoisted.runtime.ensureMcpServer();
        const url = hoisted.runtime.mcpHttp.urlFor(sourceFile);
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'design_summary', arguments: { depth: 2 } } })
        });
        const reply = await response.json() as any;

        expect(toolHandler).toHaveBeenCalledWith(sourceFile, { depth: 2 });
        expect(reply.result.content[0].text).toBe('summary of top.dsl at 2');
    });

    it('calls the graph context provider when a session\'s context is put together', async () => {
        const acp = hoisted.runtime.acp;
        acp.sessions.set('s-graph', { id: 's-graph', workflowFile: sourceFile });

        const blocks: any[] = await acp.buildWorkflowContextBlocks('s-graph');

        expect(graphContextProvider).toHaveBeenCalledWith(sourceFile);
        expect(blocks.some(b => b.resource?.text === JSON.stringify({ file: 'top.dsl', cells: 3 }))).toBe(true);
    });

    it('calls the turn context provider for each turn, with the selection', async () => {
        hoisted.runtime.setSelection(vscode.Uri.file(sourceFile).toString(), ['u1', 'u2']);

        const blocks: any[] = await hoisted.runtime.acp.turnContextBlocksProvider(sourceFile);

        expect(turnContextProvider).toHaveBeenCalledWith(sourceFile, ['u1', 'u2']);
        expect(blocks.some(b => b.text === 'selected in top.dsl: u1,u2')).toBe(true);
    });

    it('calls the slash command\'s handler when the panel sends it, and sends no prompt', async () => {
        const runtime = hoisted.runtime;
        // No agent: the session already exists, and a prompt would be a failure.
        runtime.ensureStarted = async () => undefined;
        runtime.sessions = {
            getCurrentSessionId: () => 's-slash',
            setCurrentSession: () => undefined,
            addMessageToSession: () => undefined,
            loadSession: async () => undefined
        };
        runtime.acp.getSession = () => ({ id: 's-slash' });
        const sendPrompt = vi.fn(async () => { throw new Error('a prompt was sent to a model'); });
        runtime.acp.sendPrompt = sendPrompt;
        const uri = vscode.Uri.file(sourceFile).toString();

        // As the diagram's chat panel sends it, over the messenger.
        hoisted.toHost!(
            { type: 'chat.sendMessage', data: { workflowUri: uri, text: '/explain u1', sessionId: 's-slash', mode: 'build' } },
            { type: 'webview', webviewId: 'panel-1' }
        );
        await vi.waitFor(() => expect(slashHandler).toHaveBeenCalled());

        expect(slashHandler.mock.calls[0][0]._raw).toBe('u1');
        expect(sendPrompt).not.toHaveBeenCalled();
        await vi.waitFor(() =>
            expect(hoisted.sent.some(m => m.type === 'chat.message' && m.data?.content === 'explained u1')).toBe(true));
    });
});
