// The order in which a closing editor is let go of: the load still running
// for it is aborted, and only then is the product told the editor closed.
//
// `DiagramProfile.onEditorClosed` says that a load still running for the file
// "has been told already" (`ModelSourceOptions.signal`). That holds because of
// GLSP's own order, not the platform's: GLSP's connector listens for the
// panel's disposal before the editor provider's `setUpWebview` does, and the
// session it disposes there is the in-process server's, whose dispatcher
// aborts the load (`LoadCancellingActionDispatcher.dispose`) in the same
// turn. This runs GLSP's real connector, editor-provider base, webview
// endpoint and in-process server, with the platform's editor provider and
// server modules, and a webview played through the messenger; only VS Code
// itself is the test's mock.
import { afterAll, describe, expect, it } from 'vitest';
import Module from 'node:module';
import * as vscodeMock from 'vscode';
import { RequestModelAction } from '@eclipse-glsp/protocol';
import type { DiagramModelSource, GraphDocument } from '@dialogram/shared';
import type { DiagramProfile } from '../src/api';

// GLSP's VS Code integration is CommonJS and requires `vscode` itself, out of
// reach of the test's alias: it is handed the same mock, with the two things
// the connector makes at construction.
const vscodeForGlsp = {
    ...vscodeMock,
    languages: { createDiagnosticCollection: () => ({ set() {}, delete() {}, clear() {}, dispose() {} }) }
};
const moduleLoader = Module as unknown as { _load(request: string, ...rest: unknown[]): unknown };
const load = moduleLoader._load;
moduleLoader._load = function (request: string, ...rest: unknown[]) {
    return request === 'vscode' ? vscodeForGlsp : load.call(this, request, ...rest);
};
afterAll(() => {
    moduleLoader._load = load;
});

const { GlspVscodeConnector } = await import('@eclipse-glsp/vscode-integration');
const { createWorkflowGlspVscodeServer } = await import('@dialogram/diagram-server');
const { WorkflowEditorProvider } = await import('../src/extension/diagram/diagram-editor-provider');

const FILE = vscodeMock.Uri.file('/w/top.dsl');

/** The webview's side of `vscode-messenger`, as GLSP's endpoint registers it. */
function fakeMessenger() {
    const requests = new Map<string, (params: unknown) => unknown>();
    const notifications = new Map<string, (params: unknown) => void>();
    const messenger = {
        registerWebviewPanel: () => ({ webviewId: 'panel-1' }),
        onRequest: (type: { method: string }, handler: (params: unknown) => unknown) => {
            requests.set(type.method, handler);
            return { dispose() {} };
        },
        onNotification: (type: { method: string }, handler: (params: unknown) => void) => {
            notifications.set(type.method, handler);
            return { dispose() {} };
        },
        sendNotification: () => undefined,
        sendRequest: async () => undefined
    };
    return { messenger, requests, notifications };
}

/** A panel whose disposal calls its listeners in the order they were added, as VS Code's does. */
function fakePanel() {
    const disposeListeners: Array<() => void> = [];
    const webview = {
        cspSource: 'vscode-webview://webview',
        asWebviewUri: (uri: vscodeMock.Uri) => vscodeMock.Uri.parse(`https://webview${uri.fsPath}`),
        onDidReceiveMessage: () => ({ dispose() {} }),
        postMessage: async () => true,
        options: {},
        html: ''
    };
    const panel = {
        webview,
        active: true,
        visible: true,
        onDidDispose: (listener: () => void) => {
            disposeListeners.push(listener);
            return { dispose() {} };
        },
        onDidChangeViewState: () => ({ dispose() {} })
    };
    return { panel, dispose: () => disposeListeners.slice().forEach(listener => listener()) };
}

describe('closing the last editor of a file', () => {
    it('aborts the load still running for it, and only then tells the product the editor closed', async () => {
        let handed: AbortSignal | undefined;
        let release!: (doc: GraphDocument | undefined) => void;
        let asked!: () => void;
        const productAsked = new Promise<void>(resolve => { asked = resolve; });
        const source: DiagramModelSource = {
            getGraph: (_uri, options) => {
                handed = options.signal;
                asked();
                return new Promise(resolve => { release = resolve; });
            }
        };
        const abortedWhenClosed: Array<boolean | undefined> = [];
        const profile = {
            key: 'fixture',
            settingsNamespace: 'fixture',
            sourceExtensions: ['.dsl'],
            onEditorClosed: () => { abortedWhenClosed.push(handed?.aborted); }
        } as unknown as DiagramProfile;

        // With the host's loading indicator, as in production: GLSP's own progress notices are not started.
        const server = createWorkflowGlspVscodeServer({ clientId: 'fixture', clientName: 'fixture', modelSourceFactory: () => source, loadProgress: () => undefined });
        void server.start();
        const { messenger, requests, notifications } = fakeMessenger();
        const connector = new GlspVscodeConnector({ server, messenger: messenger as any });
        const context = { subscriptions: [] as Array<{ dispose(): void }> } as unknown as vscodeMock.ExtensionContext;
        const provider = new WorkflowEditorProvider(context as any, connector, profile, vscodeMock.Uri.file('/fake-ext') as any);
        const log = { log: console.log, info: console.info, warn: console.warn, debug: console.debug };
        console.log = console.info = console.debug = console.warn = () => undefined;
        try {
            const { panel, dispose } = fakePanel();
            await provider.resolveCustomEditor({ uri: FILE } as any, panel as any, {} as any);
            // The connector hooks the endpoint up to the server once the server is ready.
            for (let i = 0; i < 50 && !requests.has('initializeClientSession'); i++) {
                await new Promise(resolve => setTimeout(resolve, 10));
            }
            const clientId = `${provider.diagramType}_0`;
            await requests.get('initializeServer')!({ applicationId: 'test', protocolVersion: '1.0.0' });
            // What a GLSP client takes from the server while a model loads.
            const clientActionKinds = ['status', 'startProgress', 'updateProgress', 'endProgress', 'requestBounds', 'setModel', 'updateModel', 'setDirtyState', 'serverMessage'];
            await requests.get('initializeClientSession')!({ clientSessionId: clientId, diagramType: provider.diagramType, clientActionKinds });
            // The webview asks for its model.
            notifications.get('actionMessage')!({
                clientId,
                action: RequestModelAction.create({ options: { sourceUri: FILE.toString(), diagramType: provider.diagramType } })
            });
            await productAsked;
            expect(handed?.aborted).toBe(false);

            dispose();

            expect(abortedWhenClosed).toEqual([true]);
            release(undefined);
        } finally {
            Object.assign(console, log);
            server.dispose();
        }
    }, 30_000);
});
