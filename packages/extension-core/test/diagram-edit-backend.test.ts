/**
 * The diagram chat consumes an injected {@link DiagramEditBackend} (the neutral
 * seam) rather than importing sidecar functions directly. These tests inject a
 * fake backend and assert the five behaviors the chat backend owns around it:
 *   (a) named-edit dispatch → applyNamedEdit(kind, built args, expectedRevision)
 *   (b) a conflict result → refresh-from-disk + actualRevision cached
 *   (c) supportsOp=false → op refused with the runtime-specific message
 *   (d) the session graph provider → exportGraph
 *   (e) the MCP provider → the backend's descriptors (verbatim, env as pairs)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

const hoisted = vi.hoisted(() => ({
    graphProvider: undefined as undefined | ((workflowFile: string) => Promise<string | undefined>),
    mcpProvider: undefined as undefined | ((workflowFile?: string) => any[])
}));

vi.mock('../src/extension/acp-client', () => {
    class ACPClientService {
        on() {
            return this;
        }
        off() {
            return this;
        }
        emit() {
            return true;
        }
        async start(): Promise<void> {}
        isClientConnected(): boolean {
            return true;
        }
        async warmUpModelCatalog(): Promise<void> {}
        setChatSkill(): void {}
        setSourceMimeType(): void {}
        setWorkflowGraphProvider(p: (workflowFile: string) => Promise<string | undefined>): void {
            hoisted.graphProvider = p;
        }
        setMcpServersProvider(p: (workflowFile?: string) => any[]): void {
            hoisted.mcpProvider = p;
        }
        stop(): void {}
    }
    return { ACPClientService };
});

import { ChatBackend } from '../src/extension/chat/chat-backend';
import { OperationDispatcher } from '../src/extension/operation-dispatcher';

const WF_FILE = '/ws/pipeline.py';

function makeContext() {
    const store = new Map<string, unknown>();
    return {
        extensionUri: { fsPath: '/ext' },
        workspaceState: {
            get: <T>(key: string, defaultValue?: T): T | undefined =>
                store.has(key) ? (store.get(key) as T) : defaultValue,
            update: async (key: string, value: unknown): Promise<void> => {
                store.set(key, value);
            }
        },
        subscriptions: [] as { dispose(): void }[]
    } as any;
}

function makeProfile(key = 'wfpy') {
    return {
        key,
        displayName: 'WorkflowPy',
        settingsNamespace: `${key}Lang`,
        chat: { name: key, fullName: key.toUpperCase(), operationPrefix: key, skill: 'skill' },
        commands: { layoutDiagram: `${key}.layout`, layoutDiagramIfNeeded: `${key}.layoutIfNeeded` }
    } as any;
}

function makeEditBackend() {
    return {
        exportGraph: vi.fn(async () => JSON.stringify({ nodes: [] })),
        listCapabilities: vi.fn(async () => undefined),
        supportsOp: vi.fn(async () => true),
        applyNamedEdit: vi.fn(async () => ({ ok: true, revision: 'rev-new' })),
        mcpServers: vi.fn(() => [
            {
                name: 'wfpy',
                command: 'node',
                args: ['/assets/dist/sidecar-mcp-server.cjs'],
                env: { MCP_WORKFLOW_FILE: WF_FILE, MCP_NETWORK: 'top' }
            }
        ]),
        scopeArgs: vi.fn((_uri: string, network: string | undefined) =>
            network ? { workflow: network } : {})
    };
}

function makeEditorProvider(networkName?: string) {
    return {
        getRefreshContext: vi.fn(() => (networkName ? { networkName } : undefined)),
        refreshModelFromDisk: vi.fn()
    };
}

const NO_CONNECTOR = { messenger: { onNotification: () => {}, sendNotification: () => {} } };

afterEach(() => {
    hoisted.graphProvider = undefined;
    hoisted.mcpProvider = undefined;
    (vscode.window as any).activeTextEditor = undefined;
    (vscode.workspace as any).workspaceFolders = undefined;
    (vscode.workspace as any).getConfiguration = (_section?: string) => ({
        get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue
    });
    vi.clearAllMocks();
});

/** Wire the sidecar op table onto a fresh dispatcher (no ACP needed). */
function wireDispatcher(backend: ChatBackend): OperationDispatcher {
    const dispatcher = new OperationDispatcher();
    (backend as any).wireEditBackendOperations(dispatcher);
    return dispatcher;
}

describe('ChatBackend consumes an injected DiagramEditBackend', () => {
    it('(a) named-edit dispatch calls applyNamedEdit with kind, built + scoped args, and expectedRevision from the cache', async () => {
        const editBackend = makeEditBackend();
        const editorProvider = makeEditorProvider('top');
        (vscode.window as any).activeTextEditor = { document: { uri: vscode.Uri.file(WF_FILE) } };
        (vscode.workspace as any).getConfiguration = (_section?: string) => ({
            get: <T>(key: string, defaultValue?: T): T | undefined =>
                (key === 'checkSourceRevision' ? (true as unknown as T) : defaultValue)
        });

        const backend = new ChatBackend(makeContext(), makeProfile(), {
            getConnector: () => NO_CONNECTOR,
            getEditorProvider: () => editorProvider,
            editBackend
        } as any);
        (backend as any).sourceRevisionCache.set(WF_FILE, 'rev-known');

        const dispatcher = wireDispatcher(backend);
        const result = await dispatcher.dispatch('wfpy.createNode', { type: 'task', name: 'A', params: { x: 1 } });

        expect(result.success).toBe(true);
        expect(editBackend.supportsOp).toHaveBeenCalledWith(expect.stringContaining(WF_FILE), 'createNode');
        expect(editBackend.applyNamedEdit).toHaveBeenCalledWith(
            expect.stringContaining(WF_FILE),
            'createNode',
            { workflow: 'top', type: 'task', name: 'A', params: { x: 1 } },
            { expectedRevision: 'rev-known' }
        );
        // Successful edit refreshes the diagram and caches the new revision.
        expect(editorProvider.refreshModelFromDisk).toHaveBeenCalled();
        expect((backend as any).sourceRevisionCache.get(WF_FILE)).toBe('rev-new');
    });

    it('(b) a conflict result triggers refresh-from-disk and caches actualRevision', async () => {
        const editBackend = makeEditBackend();
        editBackend.applyNamedEdit = vi.fn(async () => ({
            ok: false,
            conflict: { actualRevision: 'rev-actual' }
        }));
        const editorProvider = makeEditorProvider();
        (vscode.window as any).activeTextEditor = { document: { uri: vscode.Uri.file(WF_FILE) } };

        const backend = new ChatBackend(makeContext(), makeProfile(), {
            getConnector: () => NO_CONNECTOR,
            getEditorProvider: () => editorProvider,
            editBackend
        } as any);

        const dispatcher = wireDispatcher(backend);
        const result = await dispatcher.dispatch('wfpy.connect', { source: 's', target: 't' });

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/changed since the chat last read it/i);
        expect(editorProvider.refreshModelFromDisk).toHaveBeenCalled();
        expect((backend as any).sourceRevisionCache.get(WF_FILE)).toBe('rev-actual');
    });

    it('(c) supportsOp=false refuses the op with the runtime-specific message', async () => {
        const editBackend = makeEditBackend();
        editBackend.supportsOp = vi.fn(async () => false);
        (vscode.window as any).activeTextEditor = { document: { uri: vscode.Uri.file(WF_FILE) } };

        const backend = new ChatBackend(makeContext(), makeProfile(), {
            getConnector: () => NO_CONNECTOR,
            getEditorProvider: () => makeEditorProvider(),
            editBackend
        } as any);

        const dispatcher = wireDispatcher(backend);
        const result = await dispatcher.dispatch('wfpy.deleteNode', { name: 'A' });

        expect(result.success).toBe(false);
        expect(result.error).toBe("'deleteNode' isn't supported by the WorkflowPy runtime.");
        expect(editBackend.applyNamedEdit).not.toHaveBeenCalled();
    });

    it('(d) the session graph provider uses exportGraph', async () => {
        (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/ws' } }];
        const editBackend = makeEditBackend();

        const backend = new ChatBackend(makeContext(), makeProfile(), {
            getConnector: () => NO_CONNECTOR,
            getEditorProvider: () => makeEditorProvider(),
            editBackend
        } as any);
        await backend.initialize();

        expect(hoisted.graphProvider).toBeDefined();
        const graph = await hoisted.graphProvider!(WF_FILE);
        expect(editBackend.exportGraph).toHaveBeenCalledWith(expect.stringContaining(WF_FILE));
        expect(graph).toBe(JSON.stringify({ nodes: [] }));
    });

    it('(e) the MCP provider returns the backend descriptors (env as name/value pairs)', async () => {
        (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/ws' } }];
        const editBackend = makeEditBackend();

        const backend = new ChatBackend(
            makeContext(),
            makeProfile(),
            {
                getConnector: () => NO_CONNECTOR,
                getEditorProvider: () => makeEditorProvider('top'),
                editBackend
            } as any,
            vscode.Uri.file('/assets')
        );
        await backend.initialize();

        expect(hoisted.mcpProvider).toBeDefined();
        const descriptors = hoisted.mcpProvider!(WF_FILE);
        expect(editBackend.mcpServers).toHaveBeenCalledWith(
            expect.stringContaining(WF_FILE),
            expect.objectContaining({ networkName: 'top', assetsPath: expect.stringContaining('/assets') })
        );
        expect(descriptors).toEqual([
            {
                name: 'wfpy',
                command: 'node',
                args: ['/assets/dist/sidecar-mcp-server.cjs'],
                env: [
                    { name: 'MCP_WORKFLOW_FILE', value: WF_FILE },
                    { name: 'MCP_NETWORK', value: 'top' }
                ]
            }
        ]);
    });
});
