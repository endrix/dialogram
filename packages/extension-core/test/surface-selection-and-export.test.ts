/**
 * The host's side of a diagram surface: its selection, as the webview's chat
 * panel reports it, becomes turn context, reaches a profile's `render` and
 * turn hook as an extra argument and a slash command's context; a surface's
 * PNG is saved through the export dialog the SVG uses; and Center keeps the
 * zoom.
 */
import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { ChatRuntime, readSurfaceSelection, surfaceSelectionText } from '../src/extension/chat/chat-runtime';
import { centerKeepingZoom } from '../src/extension/diagram/viewport-commands';
import type { DiagramProfile } from '../src/api';

vi.mock('@eclipse-glsp/vscode-integration', () => ({
    GlspEditorProvider: class {
        constructor(protected readonly glspVscodeConnector: any) {}
        get onDidChangeCustomDocument(): unknown {
            return this.glspVscodeConnector?.onDidChangeCustomDocument;
        }
    },
    GlspVscodeConnector: class {}
}));

const { WorkflowEditorProvider } = await import('../src/extension/diagram/diagram-editor-provider');

const URI = 'file:///ws/shapes.txt';
const FILE = vscode.Uri.parse(URI).fsPath;

const summary = {
    ids: ['shape:42'],
    title: 'Rectangle 42',
    kind: 'Rectangle',
    rows: [
        { section: 'Geometry', label: 'Width', value: '12' },
        { section: 'Geometry', label: 'Next', value: 'Rectangle 43' }
    ]
};

function makeRuntime(config: Record<string, any> = {}) {
    const memento = { get: <T>(_k: string, d?: T) => d, update: async () => undefined, keys: () => [] };
    const runtime = new ChatRuntime({ workspaceState: memento } as any, {
        key: 'test',
        displayName: 'Test',
        settingsSection: 'test.chat',
        ...config
    } as any, () => undefined);
    const acp = (runtime as any).acp;
    acp.isClientConnected = () => true;
    acp.warmUpModelCatalog = async () => undefined;
    acp.listProviders = async () => [];
    acp.start = async () => undefined;
    acp.createSession = async () => 'session-1';
    acp.getSession = () => ({ id: 'session-1' });
    acp.setSessionMode = async () => undefined;
    acp.setProvider = async () => undefined;
    acp.sendPrompt = async () => undefined;
    const turnContext = (): Promise<any[]> => acp.turnContextBlocksProvider(FILE);
    return { runtime, turnContext };
}

describe('a surface selection in the chat', () => {
    it('is the turn context when no node is selected, said plainly', async () => {
        const { runtime, turnContext } = makeRuntime();
        await runtime.handleMessage(URI, { type: 'chat.selection', data: { selectedNodeIds: [], surfaceSelection: summary } });
        const texts = (await turnContext()).map(block => block.text);
        expect(texts).toEqual([surfaceSelectionText(summary)]);
        expect(texts[0]).toContain('Rectangle "Rectangle 42" selected');
        expect(texts[0]).toContain('(id: shape:42)');
        expect(texts[0]).toContain('Geometry:\n- Width: 12\n- Next: Rectangle 43');
    });

    it('goes when the panel says the selection is gone', async () => {
        const { runtime, turnContext } = makeRuntime();
        await runtime.handleMessage(URI, { type: 'chat.selection', data: { selectedNodeIds: [], surfaceSelection: summary } });
        await runtime.handleMessage(URI, { type: 'chat.selection', data: { selectedNodeIds: [] } });
        expect(await turnContext()).toEqual([]);
    });

    it('reaches a profile\'s render and turn hook as a third argument, and only when there is one', async () => {
        const render = vi.fn((_file: string, _ids: string[], surface?: any) => surface ? `custom: ${surface.title}` : undefined);
        const turnContextProvider = vi.fn(async () => []);
        const { runtime, turnContext } = makeRuntime({ selectionContext: { render }, turnContextProvider });
        await turnContext();
        expect(turnContextProvider).toHaveBeenLastCalledWith(FILE, []);

        await runtime.handleMessage(URI, { type: 'chat.selection', data: { selectedNodeIds: [], surfaceSelection: summary } });
        expect((await turnContext()).map(block => block.text)).toEqual(['custom: Rectangle 42']);
        expect(render).toHaveBeenLastCalledWith(FILE, [], summary);
        expect(turnContextProvider).toHaveBeenLastCalledWith(FILE, [], summary);
    });

    it('reaches a slash command\'s context', async () => {
        const handler = vi.fn(async () => ({ success: true }));
        const { runtime } = makeRuntime({ slashCommands: [{ command: 'sel', description: 't', modes: ['build'], handler }] });
        await runtime.handleMessage(URI, {
            type: 'chat.sendMessage',
            data: { text: '/sel', mode: 'build', selectedNodeIds: [], surfaceSelection: summary }
        });
        expect(handler).toHaveBeenCalledWith({}, expect.objectContaining({ surfaceSelection: summary }));
    });

    it('is checked and capped on the way in', () => {
        expect(readSurfaceSelection({ ids: ['a'] })).toBeUndefined();
        expect(readSurfaceSelection('x')).toBeUndefined();
        const big = readSurfaceSelection({
            ids: Array.from({ length: 80 }, (_, i) => i),
            title: 'Many',
            kind: '',
            rows: [...Array.from({ length: 60 }, (_, i) => ({ label: `r${i}`, value: i })), { value: 'no label' }]
        })!;
        expect(big.ids).toHaveLength(50);
        expect(big.ids[0]).toBe('0');
        expect(big.rows).toHaveLength(40);
        expect(big.kind).toBeUndefined();
    });
});

describe('a surface\'s PNG export', () => {
    function makeProvider() {
        let onMessage: ((m: unknown) => unknown) | undefined;
        const webview = {
            cspSource: 'vscode-webview://webview',
            asWebviewUri: (uri: vscode.Uri) => uri,
            onDidReceiveMessage: (cb: (m: unknown) => unknown) => { onMessage = cb; return { dispose() {} }; },
            postMessage: async () => true,
            set options(_v: any) {},
            get options() { return {}; },
            set html(_v: string) {},
            get html() { return ''; }
        };
        const panel = { webview, onDidDispose: () => ({ dispose() {} }) } as unknown as vscode.WebviewPanel;
        const provider = new WorkflowEditorProvider(
            { subscriptions: [] } as unknown as vscode.ExtensionContext,
            { onDidChangeCustomDocument: undefined, dispatchAction: () => {} } as any,
            { key: 'test', settingsNamespace: 'test' } as unknown as DiagramProfile,
            vscode.Uri.file('/fake-ext')
        );
        provider.setUpWebview({ uri: vscode.Uri.parse(URI) } as vscode.CustomDocument, panel, {} as vscode.CancellationToken, 'client-0');
        return (message: unknown) => onMessage!(message);
    }

    it('is saved through the export dialog, as PNG bytes, beside the file', async () => {
        const showSaveDialog = vi.fn(async (_options: any) => vscode.Uri.file('/ws/shapes.png'));
        const writeFile = vi.fn(async () => undefined);
        (vscode.window as any).showSaveDialog = showSaveDialog;
        (vscode.workspace as any).fs = { writeFile };
        const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7]);

        await makeProvider()({ type: 'dialogram.png.extracted', payload: { data: png.toString('base64'), name: 'shapes', byteLength: png.length } });

        const options = showSaveDialog.mock.calls[0][0];
        expect(options.title).toBe('Export diagram as PNG');
        expect(options.filters).toEqual({ 'PNG image': ['png'] });
        expect(options.defaultUri.fsPath).toBe('/ws/shapes.png');
        const [target, bytes] = writeFile.mock.calls[0] as unknown as [vscode.Uri, Uint8Array];
        expect(target.fsPath).toBe('/ws/shapes.png');
        expect(Buffer.from(bytes)).toEqual(png);
    });

    it('refuses bytes that are not a PNG, and writes nothing', async () => {
        const showSaveDialog = vi.fn(async () => vscode.Uri.file('/ws/shapes.png'));
        const writeFile = vi.fn(async () => undefined);
        const showWarningMessage = vi.spyOn(vscode.window, 'showWarningMessage');
        (vscode.window as any).showSaveDialog = showSaveDialog;
        (vscode.workspace as any).fs = { writeFile };

        await makeProvider()({ type: 'dialogram.png.extracted', payload: { data: Buffer.from('<svg/>').toString('base64') } });

        expect(showSaveDialog).not.toHaveBeenCalled();
        expect(writeFile).not.toHaveBeenCalled();
        expect(showWarningMessage).toHaveBeenCalledWith('Could not export the diagram as PNG: the image is not a PNG.');
    });
});

describe('Center', () => {
    it('keeps the zoom, animated', () => {
        expect(centerKeepingZoom()).toMatchObject({ kind: 'center', elementIds: [], animate: true, retainZoom: true });
    });
});
