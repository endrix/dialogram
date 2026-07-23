// Task 4: the editor provider announces each webview (re)registration via
// `onDidRegisterClient` so the host can drain the execution-overlay replay buffer
// into a webview reopened mid-run. This pins the seam: the event fires on every
// setUpWebview with the document URI string (the same representation run drivers
// emit with), and it fires again on reopen. The provider is exercised through the
// same GLSP-base stub the sibling provider tests use.
import { describe, it, expect, vi } from 'vitest';
import * as vscode from 'vscode';
import type { DiagramProfile } from '../src/api';

vi.mock('@eclipse-glsp/vscode-integration', () => ({
    GlspEditorProvider: class {
        onDidChangeCustomDocument: unknown;
        constructor(protected readonly glspVscodeConnector: any) {
            this.onDidChangeCustomDocument = glspVscodeConnector?.onDidChangeCustomDocument;
        }
    },
    GlspVscodeConnector: class {}
}));

const { WorkflowEditorProvider } = await import('../src/extension/diagram/diagram-editor-provider');
type WorkflowEditorProvider = InstanceType<typeof WorkflowEditorProvider>;

const STOCK_PROFILE = { key: 'test', settingsNamespace: 'test' } as unknown as DiagramProfile;
const DOCUMENT_URI = 'file:///workspace/pipeline.py';

function makeWebviewPanel() {
    const webview = {
        cspSource: 'vscode-webview://webview',
        asWebviewUri: (uri: vscode.Uri) => vscode.Uri.parse(`https://webview${uri.fsPath}`),
        onDidReceiveMessage: (_cb: (...a: any[]) => any) => ({ dispose() {} }),
        postMessage: async (_m: unknown) => true,
        set options(_value: any) { /* captured elsewhere; unused here */ },
        get options() { return {}; },
        set html(_value: string) { /* unused here */ },
        get html() { return ''; }
    };
    const disposeCbs: Array<() => void> = [];
    const panel = {
        webview,
        onDidDispose: (cb: () => void) => { disposeCbs.push(cb); return { dispose() {} }; }
    } as unknown as vscode.WebviewPanel;
    return { panel, fireDispose: () => disposeCbs.forEach(cb => cb()) };
}

function makeProvider() {
    const connector = { onDidChangeCustomDocument: undefined, dispatchAction: () => {} } as any;
    const context = { subscriptions: [] as Array<{ dispose(): void }> } as unknown as vscode.ExtensionContext;
    return new WorkflowEditorProvider(context, connector, STOCK_PROFILE, vscode.Uri.file('/fake-ext'));
}

describe('WorkflowEditorProvider.onDidRegisterClient (Task 4 replay seam)', () => {
    it('fires with the document URI string when a webview registers', () => {
        const provider = makeProvider();
        const seen: string[] = [];
        provider.onDidRegisterClient(uri => seen.push(uri));

        const { panel } = makeWebviewPanel();
        const document = { uri: vscode.Uri.parse(DOCUMENT_URI) } as vscode.CustomDocument;
        provider.setUpWebview(document, panel, {} as vscode.CancellationToken, 'client-0');

        expect(seen).toEqual([DOCUMENT_URI]);
    });

    it('fires again on reopen (close then re-register the same source)', () => {
        const provider = makeProvider();
        const seen: string[] = [];
        provider.onDidRegisterClient(uri => seen.push(uri));
        const document = { uri: vscode.Uri.parse(DOCUMENT_URI) } as vscode.CustomDocument;

        const first = makeWebviewPanel();
        provider.setUpWebview(document, first.panel, {} as vscode.CancellationToken, 'client-0');
        first.fireDispose(); // webview closed

        const second = makeWebviewPanel();
        provider.setUpWebview(document, second.panel, {} as vscode.CancellationToken, 'client-1');

        expect(seen).toEqual([DOCUMENT_URI, DOCUMENT_URI]);
    });
});
