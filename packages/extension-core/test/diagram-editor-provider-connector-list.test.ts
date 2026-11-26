/**
 * The agent panel offers the ACP connectors the document's workspace sees,
 * posted to each diagram as `dialogram.clientBehavior.merge`. A connector
 * declared, or removed, in a connectors file is offered without opening the
 * diagram again: one watch serves every open diagram, and ends with the last.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
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

const PROFILE = {
    key: 'test',
    settingsNamespace: 'test',
    chat: { acpConnector: { settingKey: 'acp.connector', files: { user: 'test/connectors.toml', workspace: '.test/connectors.toml' } } }
} as unknown as DiagramProfile;

function openDiagram(provider: InstanceType<typeof WorkflowEditorProvider>, clientId: string) {
    const merges: unknown[] = [];
    let disposed: (() => void) | undefined;
    const webview = {
        cspSource: 'vscode-webview://webview',
        asWebviewUri: (uri: vscode.Uri) => vscode.Uri.parse(`https://webview${uri.fsPath}`),
        onDidReceiveMessage: () => ({ dispose() {} }),
        postMessage: async (message: { type: string; payload: unknown }) => {
            if (message.type === 'dialogram.clientBehavior.merge') merges.push(message.payload);
            return true;
        },
        options: {},
        html: ''
    };
    const panel = {
        webview,
        onDidDispose: (listener: () => void) => {
            const previous = disposed;
            disposed = () => { previous?.(); listener(); };
            return { dispose() {} };
        }
    } as unknown as vscode.WebviewPanel;
    provider.setUpWebview({ uri: vscode.Uri.parse(`file:///ws/${clientId}.py`) } as vscode.CustomDocument, panel, {} as vscode.CancellationToken, clientId);
    return { merges, close: () => disposed?.() };
}

/** Let the listing (file reads) settle. */
async function settle(): Promise<void> {
    for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
}

describe('the agent panel\'s connector list', () => {
    afterEach(() => vi.restoreAllMocks());

    it('is posted again to every open diagram when a connectors file changes, from one watch', async () => {
        const fileListeners: Array<() => void> = [];
        let live = 0;
        vi.spyOn(vscode.workspace, 'onDidChangeConfiguration').mockImplementation((() => { live++; return { dispose: () => { live--; } }; }) as any);
        vi.spyOn(vscode.workspace, 'createFileSystemWatcher').mockImplementation(((glob: unknown) => {
            // The connectors files' watchers only: the provider watches its sources too.
            const connectors = glob === '**/.test/connectors.toml' || (glob as { pattern?: string })?.pattern === 'connectors.toml';
            if (connectors) live++;
            const sub = (listener: () => void) => { if (connectors) fileListeners.push(listener); return { dispose() {} }; };
            return { onDidChange: sub, onDidCreate: sub, onDidDelete: sub, dispose: () => { if (connectors) live--; } };
        }) as any);
        const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
        const connector = { onDidChangeCustomDocument: undefined, dispatchAction: () => {} } as any;
        const provider = new WorkflowEditorProvider(context, connector, PROFILE, vscode.Uri.file('/fake-ext'));

        const a = openDiagram(provider, 'a');
        const b = openDiagram(provider, 'b');
        await settle();
        expect(a.merges).toHaveLength(1);
        expect(b.merges).toHaveLength(1);
        // One settings listener and the two files' watchers, for both diagrams.
        expect(live).toBe(3);

        fileListeners[0]();
        await settle();
        expect(a.merges).toHaveLength(2);
        expect(b.merges).toHaveLength(2);
        expect((a.merges[1] as { acpConnectors: Array<{ name: string }> }).acpConnectors.map(c => c.name)).toContain('opencode');

        a.close();
        expect(live).toBe(3);
        b.close();
        expect(live).toBe(0);
    });
});
