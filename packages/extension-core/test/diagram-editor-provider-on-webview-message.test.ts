// SP4 Task 1: `DiagramProfile.onWebviewMessage` is the inbound-message seam that
// lets a custom-view consumer (mlir-viewer) handle webview messages the provider's
// built-in debug / `dialogram.ui.*` handlers do not consume. These tests pin:
//  (1) an unhandled message is forwarded to `onWebviewMessage(uri, message, ctx)`;
//      returning true marks it consumed;
//  (2) a built-in `dialogram.ui.*` message is NOT forwarded (handled in-provider);
//  (3) absent hook → the message is ignored with no throw (byte-identical parity);
//  (4) the ctx exposes `postToWebview` (posts to this webview) and `revealRange`
//      (opens the source and selects the range).
//
// The provider is exercised through the same GLSP-base stub the client-assets
// test uses, so it constructs in plain Node without the real GLSP barrel.
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

const DOCUMENT_URI = 'file:///workspace/pipeline.py';
const CLIENT_ID = 'client-0';

/** Webview double that captures the registered onDidReceiveMessage handler and
 *  every postMessage payload. */
function makeWebviewPanel() {
    const captured: { onMessage?: (m: unknown) => unknown; posted: unknown[] } = { posted: [] };
    const webview = {
        cspSource: 'vscode-webview://webview',
        asWebviewUri: (uri: vscode.Uri) => vscode.Uri.parse(`https://webview${uri.fsPath}`),
        onDidReceiveMessage: (cb: (m: unknown) => unknown) => {
            captured.onMessage = cb;
            return { dispose() {} };
        },
        postMessage: async (m: unknown) => {
            captured.posted.push(m);
            return true;
        },
        set options(_value: any) {},
        get options() {
            return {};
        },
        set html(_value: string) {},
        get html() {
            return '';
        }
    };
    const panel = {
        webview,
        onDidDispose: (_cb: () => void) => ({ dispose() {} })
    } as unknown as vscode.WebviewPanel;
    return { panel, captured };
}

function makeProvider(profile: DiagramProfile) {
    const connector = { onDidChangeCustomDocument: undefined, dispatchAction: () => {} } as any;
    const context = { subscriptions: [] as Array<{ dispose(): void }> } as unknown as vscode.ExtensionContext;
    const provider = new WorkflowEditorProvider(context, connector, profile, vscode.Uri.file('/fake-ext'));
    const { panel, captured } = makeWebviewPanel();
    const document = { uri: vscode.Uri.parse(DOCUMENT_URI) } as vscode.CustomDocument;
    provider.setUpWebview(document, panel, {} as vscode.CancellationToken, CLIENT_ID);
    return { provider, captured };
}

function baseProfile(overrides: Partial<DiagramProfile> = {}): DiagramProfile {
    return {
        key: 'test',
        settingsNamespace: 'test',
        commands: undefined,
        operationKinds: undefined,
        clientBehavior: undefined,
        ...overrides
    } as unknown as DiagramProfile;
}

describe('WorkflowEditorProvider onWebviewMessage routing', () => {
    it('forwards an unhandled message to profile.onWebviewMessage and marks it consumed', async () => {
        const onWebviewMessage = vi.fn(async () => true);
        const { captured } = makeProvider(baseProfile({ onWebviewMessage }));

        const message = { type: 'mlir.revealInEditor', payload: { line: 3 } };
        await captured.onMessage!(message);

        expect(onWebviewMessage).toHaveBeenCalledTimes(1);
        const [uri, forwarded, ctx] = onWebviewMessage.mock.calls[0] as unknown as [string, unknown, any];
        expect(uri).toBe(DOCUMENT_URI);
        expect(forwarded).toEqual(message);
        expect(typeof ctx.postToWebview).toBe('function');
        expect(typeof ctx.revealRange).toBe('function');
    });

    it('does NOT forward a built-in dialogram.ui.* message to onWebviewMessage', async () => {
        const onWebviewMessage = vi.fn(async () => true);
        const { captured } = makeProvider(baseProfile({ onWebviewMessage }));

        await captured.onMessage!({ type: 'dialogram.ui.infoMessage', payload: { message: 'hi' } });

        expect(onWebviewMessage).not.toHaveBeenCalled();
    });

    it('ignores an unhandled message with no throw when the hook is absent (parity)', async () => {
        const { captured } = makeProvider(baseProfile());
        await expect(captured.onMessage!({ type: 'mlir.somethingCustom' })).resolves.toBeUndefined();
    });

    it('ctx.postToWebview posts to this webview; ctx.revealRange opens the source and selects the range', async () => {
        const showTextDocument = vi.fn(async () => undefined);
        (vscode.window as any).showTextDocument = showTextDocument;

        const onWebviewMessage = vi.fn(async (_uri: string, _msg: unknown, ctx: any) => {
            ctx.postToWebview({ type: 'ack' });
            await ctx.revealRange('file:///workspace/other.py', { startLine: 10, startColumn: 4 });
            return true;
        });
        const { captured } = makeProvider(baseProfile({ onWebviewMessage }));

        await captured.onMessage!({ type: 'mlir.custom' });

        expect(captured.posted).toContainEqual({ type: 'ack' });
        expect(showTextDocument).toHaveBeenCalledTimes(1);
        const [uriArg, opts] = showTextDocument.mock.calls[0] as unknown as [vscode.Uri, any];
        expect(uriArg.toString()).toBe('file:///workspace/other.py');
        expect(opts.selection.start.line).toBe(10);
        expect(opts.selection.start.character).toBe(4);
    });
});

describe('WorkflowEditorProvider host→client webview send methods', () => {
    it('postToWebview posts a raw message to the panel registered for the URI', () => {
        const { provider, captured } = makeProvider(baseProfile());
        provider.postToWebview(DOCUMENT_URI, { type: 'mlir.syncCursor', line: 7 });
        expect(captured.posted).toContainEqual({ type: 'mlir.syncCursor', line: 7 });
    });

    it('postToWebview is a no-op for an unregistered URI', () => {
        const { provider } = makeProvider(baseProfile());
        expect(() => provider.postToWebview('file:///workspace/unknown.py', { type: 'x' })).not.toThrow();
    });

    it('dispatchToWebview sends over the ungated sendMessageToClient path for the URI', () => {
        const sendMessageToClient = vi.fn();
        const connector = { onDidChangeCustomDocument: undefined, dispatchAction: () => {}, sendMessageToClient } as any;
        const context = { subscriptions: [] as Array<{ dispose(): void }> } as unknown as vscode.ExtensionContext;
        const provider = new WorkflowEditorProvider(context, connector, baseProfile(), vscode.Uri.file('/fake-ext'));
        const { panel } = makeWebviewPanel();
        provider.setUpWebview(
            { uri: vscode.Uri.parse(DOCUMENT_URI) } as vscode.CustomDocument,
            panel,
            {} as vscode.CancellationToken,
            CLIENT_ID
        );

        provider.dispatchToWebview(DOCUMENT_URI, { kind: 'mlir.markErrors', markers: [] });

        expect(sendMessageToClient).toHaveBeenCalledTimes(1);
        const [clientId, msg] = sendMessageToClient.mock.calls[0] as unknown as [string, any];
        expect(clientId).toBe(CLIENT_ID);
        expect(msg.clientId).toBe(CLIENT_ID);
        expect(msg.action).toEqual({ kind: 'mlir.markErrors', markers: [] });
    });

    it('dispatchToWebview is a no-op when no client is registered for the URI', () => {
        const sendMessageToClient = vi.fn();
        const connector = { onDidChangeCustomDocument: undefined, dispatchAction: () => {}, sendMessageToClient } as any;
        const context = { subscriptions: [] as Array<{ dispose(): void }> } as unknown as vscode.ExtensionContext;
        const provider = new WorkflowEditorProvider(context, connector, baseProfile(), vscode.Uri.file('/fake-ext'));
        provider.dispatchToWebview('file:///workspace/unknown.py', { kind: 'x' });
        expect(sendMessageToClient).not.toHaveBeenCalled();
    });
});
