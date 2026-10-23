/**
 * The diagram's context menu offers a status source's commands only if the
 * webview is told about them, and it is told by the platform, derived from
 * the profile, the way `chatBackend` is: the menu then offers exactly what
 * the host registered. Pinned: the label and the two command ids reach
 * `window.diagramIdentifier.clientBehavior.statusSource`, `collect` does not
 * (it is a host function and stays there), and a profile without a status
 * source puts nothing there.
 */
import { describe, expect, it, vi } from 'vitest';
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

/** The client behavior the webview is given, read back out of its HTML. */
function clientBehaviorFor(profile: DiagramProfile): Record<string, unknown> {
    let html = '';
    const webview = {
        cspSource: 'vscode-webview://webview',
        asWebviewUri: (uri: vscode.Uri) => vscode.Uri.parse(`https://webview${uri.fsPath}`),
        onDidReceiveMessage: () => ({ dispose() {} }),
        postMessage: async () => true,
        options: {},
        set html(value: string) {
            html = value;
        },
        get html() {
            return html;
        }
    };
    const panel = { webview, onDidDispose: () => ({ dispose() {} }) } as unknown as vscode.WebviewPanel;
    const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
    const connector = { onDidChangeCustomDocument: undefined, dispatchAction: () => {} } as any;
    const provider = new WorkflowEditorProvider(context, connector, profile, vscode.Uri.file('/fake-ext'));
    provider.setUpWebview({ uri: vscode.Uri.parse('file:///spec/doc.md') } as vscode.CustomDocument, panel, {} as vscode.CancellationToken, 'client-0');
    const literal = /window\.diagramIdentifier = (\{.*\});/.exec(html)?.[1];
    expect(literal, 'diagramIdentifier not found in the webview HTML').toBeDefined();
    return JSON.parse(literal!).clientBehavior;
}

const PROFILE = { key: 'test', settingsNamespace: 'test' } as unknown as DiagramProfile;

describe('the status source, as the webview sees it', () => {
    it('is the label and the two commands, without collect', () => {
        const behavior = clientBehaviorFor({
            ...PROFILE,
            statusSource: {
                label: 'Coverage',
                showCommand: 'product.coverage.show',
                clearCommand: 'product.coverage.clear',
                collect: async () => []
            }
        });

        expect(behavior.statusSource).toEqual({
            label: 'Coverage',
            showCommand: 'product.coverage.show',
            clearCommand: 'product.coverage.clear'
        });
    });

    it('is absent without one', () => {
        expect(clientBehaviorFor(PROFILE)).not.toHaveProperty('statusSource');
    });
});
