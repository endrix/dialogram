/**
 * What a client's reader is waiting for reaches the diagram that reader is
 * looking at.
 *
 * The server says it by client: a view opened in place is of another file
 * than its editor's, and the webview is the editor's. So the host looks the
 * editor up by its client, and posts the words to that editor's webview as a
 * message of their own.
 */
import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { LOADING_MESSAGE_TYPE } from '@dialogram/shared';
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

const TOP = vscode.Uri.file('/w/top.py');
const OTHER = vscode.Uri.file('/w/other.py');

function makeProvider() {
    const connector = { onDidChangeCustomDocument: undefined, dispatchAction: () => undefined } as any;
    const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
    const provider: any = new WorkflowEditorProvider(context, connector, {} as unknown as DiagramProfile);
    const posted = new Map<string, unknown[]>();
    const open = (uri: vscode.Uri, clientId: string): void => {
        posted.set(clientId, []);
        provider.trackEditor(uri, clientId, { postMessage: async (message: unknown) => posted.get(clientId)!.push(message) });
    };
    return { provider, posted, open };
}

describe('what a load is doing, posted to its diagram', () => {
    it('goes to the webview of the editor whose client it is, as a message of its own', () => {
        const { provider, posted, open } = makeProvider();
        open(TOP, 'client-top');
        open(OTHER, 'client-other');

        provider.postLoading('client-top', { state: 'progress', message: 'Reading core.py', detail: '177 nodes, 565 edges' });
        provider.postLoading('client-top', { state: 'done', model: true });

        expect(posted.get('client-top')).toEqual([
            { type: LOADING_MESSAGE_TYPE, payload: { state: 'progress', message: 'Reading core.py', detail: '177 nodes, 565 edges' } },
            { type: LOADING_MESSAGE_TYPE, payload: { state: 'done', model: true } }
        ]);
        // Not to the diagram beside it.
        expect(posted.get('client-other')).toEqual([]);
    });

    it('is said to nobody when the editor has gone', () => {
        const { provider, posted, open } = makeProvider();
        open(TOP, 'client-top');

        expect(() => provider.postLoading('client-of-a-closed-editor', { state: 'done' })).not.toThrow();

        expect(posted.get('client-top')).toEqual([]);
    });
});
