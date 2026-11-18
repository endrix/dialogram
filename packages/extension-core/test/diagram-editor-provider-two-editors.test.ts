// Two diagram editors on one file.
//
// "View: Split Editor Right" on a diagram makes a second editor of the same
// file, with a panel and a client of its own. The provider kept one entry per
// FILE, written by each editor that opened and deleted by any that closed:
// closing one of two editors took the other's entry with it, and the editor
// left open stopped hearing saves and changes on disk. These pin the fix: an entry per editor, the file's state
// going only with its last editor, and every reader of the old map doing the
// right thing with two.
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

const FILE = vscode.Uri.file('/w/top.dsl');
const OTHER = vscode.Uri.file('/w/other.dsl');

interface FakeEditor {
    panel: vscode.WebviewPanel;
    posted: unknown[];
    close(): void;
    focus(): void;
}

function makeProvider(profile: Partial<DiagramProfile> = {}) {
    const dispatched: Array<{ action: any; clientId: string }> = [];
    const sent: Array<{ clientId: string; message: any }> = [];
    const connector = {
        onDidChangeCustomDocument: undefined,
        dispatchAction: (action: any, clientId: string) => dispatched.push({ action, clientId }),
        sendMessageToClient: (clientId: string, message: unknown) => sent.push({ clientId, message })
    } as any;
    const context = { subscriptions: [] as Array<{ dispose(): void }> } as unknown as vscode.ExtensionContext;
    const provider: any = new WorkflowEditorProvider(
        context,
        connector,
        { key: 'fixture', settingsNamespace: 'fixture', sourceExtensions: ['.dsl'], ...profile } as unknown as DiagramProfile,
        vscode.Uri.file('/fake-ext')
    );

    /** Open an editor on `uri` as VS Code does: a panel, resolved with a client of its own. */
    const open = (uri: vscode.Uri, clientId: string): FakeEditor => {
        const posted: unknown[] = [];
        const disposeCbs: Array<() => void> = [];
        const viewStateCbs: Array<(e: { webviewPanel: vscode.WebviewPanel }) => void> = [];
        const webview = {
            cspSource: 'vscode-webview://webview',
            asWebviewUri: (u: vscode.Uri) => vscode.Uri.parse(`https://webview${u.fsPath}`),
            onDidReceiveMessage: () => ({ dispose() {} }),
            postMessage: async (message: unknown) => { posted.push(message); return true; },
            options: {},
            html: ''
        };
        const panel: any = {
            webview,
            active: false,
            onDidDispose: (cb: () => void) => { disposeCbs.push(cb); return { dispose() {} }; },
            onDidChangeViewState: (cb: (e: { webviewPanel: vscode.WebviewPanel }) => void) => { viewStateCbs.push(cb); return { dispose() {} }; }
        };
        provider.setUpWebview({ uri } as vscode.CustomDocument, panel, {} as vscode.CancellationToken, clientId);
        return {
            panel,
            posted,
            close: () => disposeCbs.forEach(cb => cb()),
            focus: () => {
                panel.active = true;
                viewStateCbs.forEach(cb => cb({ webviewPanel: panel }));
            }
        };
    };
    const save = (uri: vscode.Uri): void => provider.handleDocumentSave({ uri } as vscode.TextDocument);
    const refreshedClients = (): string[] => dispatched.filter(d => d.action?.kind === 'requestModel').map(d => d.clientId);
    return { provider, dispatched, sent, open, save, refreshedClients };
}

describe('two editors on one file', () => {
    it('the one left open still reloads on save after the other closes', () => {
        const { open, save, refreshedClients } = makeProvider();
        const first = open(FILE, 'client-0');
        open(FILE, 'client-1');

        first.close();
        save(FILE);

        expect(refreshedClients()).toEqual(['client-1']);
    });

    it('the newer of the two keeps its entry when the older closes after it opened', () => {
        // "Reopen Editor With…" and the like: the new panel is made, then the old one disposed.
        const { provider, open } = makeProvider();
        const old = open(FILE, 'client-0');
        open(FILE, 'client-1');
        old.close();

        expect(provider.getClientIdForDocumentUri(FILE)).toBe('client-1');
        expect(provider.getClientIdsForDocumentUri(FILE)).toEqual(['client-1']);
    });

    it('both reload on save while both are open, and nothing does once the last has closed', () => {
        const { provider, open, save, refreshedClients, dispatched } = makeProvider();
        const first = open(FILE, 'client-0');
        const second = open(FILE, 'client-1');

        save(FILE);
        expect(refreshedClients().sort()).toEqual(['client-0', 'client-1']);

        dispatched.length = 0;
        first.close();
        second.close();
        save(FILE);
        expect(refreshedClients()).toEqual([]);
        expect(provider.getClientIdForDocumentUri(FILE)).toBeUndefined();
        expect(provider.getDocumentUriForClientId('client-1')).toBeUndefined();
    });

    it('both reload on a change made on disk, each to the view it shows', () => {
        vi.useFakeTimers();
        try {
            const { provider, open, dispatched } = makeProvider();
            open(FILE, 'client-0');
            open(FILE, 'client-1');
            provider.setRefreshContextForClient('client-0', { shownSourceUri: FILE.toString(), networkName: 'alpha' });
            provider.setRefreshContextForClient('client-1', { shownSourceUri: FILE.toString(), networkName: 'beta' });

            provider.handleExternalFileChange(FILE);
            vi.advanceTimersByTime(300);

            const byClient = Object.fromEntries(dispatched.map(d => [d.clientId, d.action.options.networkName]));
            expect(byClient).toEqual({ 'client-0': 'alpha', 'client-1': 'beta' });
        } finally {
            vi.useRealTimers();
        }
    });

    it('both preview an edit made in the text editor', () => {
        vi.useFakeTimers();
        try {
            const { provider, open, refreshedClients } = makeProvider();
            open(FILE, 'client-0');
            open(FILE, 'client-1');

            provider.handleDocumentChange({
                document: { uri: FILE, getText: () => 'node a' },
                contentChanges: [{}]
            } as unknown as vscode.TextDocumentChangeEvent);
            vi.advanceTimersByTime(600);

            expect(refreshedClients().sort()).toEqual(['client-0', 'client-1']);
        } finally {
            vi.useRealTimers();
        }
    });

    it('"the" diagram of the file is the active editor, or else the one used last', () => {
        const { provider, open } = makeProvider();
        const first = open(FILE, 'client-0');
        const second = open(FILE, 'client-1');
        expect(provider.getClientIdForDocumentUri(FILE)).toBe('client-1');

        first.focus();
        expect(provider.getClientIdForDocumentUri(FILE)).toBe('client-0');

        (first.panel as any).active = false;
        expect(provider.getClientIdForDocumentUri(FILE), 'the one used last, when neither is active').toBe('client-0');
        second.focus();
        expect(provider.getClientIdForDocumentUri(FILE)).toBe('client-1');
    });

    it('a host refresh asks both; an open asks the current one', () => {
        const { provider, open, dispatched } = makeProvider();
        open(FILE, 'client-0');
        open(FILE, 'client-1');

        expect(provider.refreshFromHost(FILE)).toBe(2);
        dispatched.length = 0;
        expect(provider.refreshFromHost(FILE, { workflowName: 'beta', open: true })).toBe(1);
        expect(dispatched.map(d => d.clientId)).toEqual(['client-1']);
        // And the open is on record as what THAT editor shows, not the other.
        expect(provider.getRefreshContextForClient('client-1')?.networkName).toBe('beta');
        expect(provider.getRefreshContextForClient('client-0')).toBeUndefined();
    });

    it('a load\'s words go to the editor whose load it is', () => {
        const { provider, open } = makeProvider();
        const first = open(FILE, 'client-0');
        const second = open(FILE, 'client-1');

        provider.postLoading('client-0', { state: 'progress', message: 'Reading top.dsl' });

        expect(first.posted).toEqual([{ type: LOADING_MESSAGE_TYPE, payload: { state: 'progress', message: 'Reading top.dsl' } }]);
        expect(second.posted).toEqual([]);
    });

    it('what a product posts or dispatches to the file reaches both editors', () => {
        const { provider, open, sent } = makeProvider();
        const first = open(FILE, 'client-0');
        const second = open(FILE, 'client-1');
        open(OTHER, 'client-2');

        provider.postToWebview(FILE.toString(), { type: 'product.cursor', line: 3 });
        provider.dispatchToWebview(FILE.toString(), { kind: 'product.mark' });

        expect(first.posted).toEqual([{ type: 'product.cursor', line: 3 }]);
        expect(second.posted).toEqual([{ type: 'product.cursor', line: 3 }]);
        expect(sent.map(s => s.clientId).sort()).toEqual(['client-0', 'client-1']);
    });

    it('a post to one editor reaches that one only, and says when it has gone', () => {
        const { provider, open } = makeProvider();
        const first = open(FILE, 'client-0');
        const second = open(FILE, 'client-1');

        expect(provider.postToClient('client-1', { type: 'dialogram.svg.extract' })).toBe(true);
        expect(first.posted).toEqual([]);
        expect(second.posted).toEqual([{ type: 'dialogram.svg.extract' }]);
        second.close();
        expect(provider.postToClient('client-1', { type: 'dialogram.svg.extract' })).toBe(false);
    });

    it('reloading from disk after an edit made by the chat reloads both', () => {
        const { provider, open, refreshedClients } = makeProvider();
        open(FILE, 'client-0');
        open(FILE, 'client-1');

        expect(provider.refreshModelFromDisk(FILE)).toBe(true);
        expect(refreshedClients().sort()).toEqual(['client-0', 'client-1']);
    });

    it('the run\'s overlay is watched once per file, and stops with the last editor', () => {
        const { provider, open } = makeProvider();
        let watches = 0;
        let active = 0;
        provider.setLiveOverlaySignatureSource({
            watch: () => { watches += 1; active += 1; return { dispose: () => { active -= 1; } }; },
            onSignature: () => ({ dispose() {} })
        });
        const first = open(FILE, 'client-0');
        const second = open(FILE, 'client-1');
        expect(watches).toBe(1);

        first.close();
        expect(active).toBe(1);
        second.close();
        expect(active).toBe(0);
    });

    it('an overlay change redraws both editors', () => {
        const { provider, open, refreshedClients } = makeProvider();
        open(FILE, 'client-0');
        open(FILE, 'client-1');

        provider.onLiveOverlaySignatureUpdate(FILE.toString(), 'r1|1');

        expect(refreshedClients().sort()).toEqual(['client-0', 'client-1']);
    });

    it('names the editor that registered, for the replay of a run that only it has not seen', () => {
        const { provider, open } = makeProvider();
        const seen: Array<{ uri: string; clientId: string }> = [];
        provider.onDidRegisterEditor((e: { uri: string; clientId: string }) => seen.push(e));
        open(FILE, 'client-0');
        open(FILE, 'client-1');

        expect(seen).toEqual([
            { uri: FILE.toString(), clientId: 'client-0' },
            { uri: FILE.toString(), clientId: 'client-1' }
        ]);
    });
});

describe('the profile told of a file\'s editors (onEditorOpened, onEditorClosed)', () => {
    it('is told once when the first opens, and once when the last closes', () => {
        const opened = vi.fn();
        const closed = vi.fn();
        const { open } = makeProvider({ onEditorOpened: opened, onEditorClosed: closed });

        const first = open(FILE, 'client-0');
        const second = open(FILE, 'client-1');
        expect(opened.mock.calls).toEqual([[FILE.toString()]]);

        first.close();
        expect(closed).not.toHaveBeenCalled();
        second.close();
        expect(closed.mock.calls).toEqual([[FILE.toString()]]);

        // A file opened again is a first editor again.
        open(FILE, 'client-2');
        expect(opened).toHaveBeenCalledTimes(2);
    });

    it('is told of each file on its own', () => {
        const closed = vi.fn();
        const { open } = makeProvider({ onEditorClosed: closed });
        open(FILE, 'client-0');
        const other = open(OTHER, 'client-1');

        other.close();

        expect(closed.mock.calls).toEqual([[OTHER.toString()]]);
    });

    it('never keeps an editor from opening or closing when the hook fails', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            const { provider, open, save, refreshedClients } = makeProvider({
                onEditorOpened: () => { throw new Error('opened failed'); },
                onEditorClosed: async () => { throw new Error('closed failed'); }
            });
            const editor = open(FILE, 'client-0');
            save(FILE);
            expect(refreshedClients()).toEqual(['client-0']);

            editor.close();
            await new Promise(resolve => setTimeout(resolve, 0));
            expect(provider.getClientIdForDocumentUri(FILE)).toBeUndefined();
            expect(warn.mock.calls.map(c => String(c[0])).filter(m => m.includes('onEditor'))).toHaveLength(2);
        } finally {
            warn.mockRestore();
        }
    });
});

describe('what a product says its diagram is doing (DiagramProfileHandle.loading)', () => {
    it('reaches every editor of the file, as one trimmed line, and its end too', () => {
        const { provider, open } = makeProvider();
        const first = open(FILE, 'client-0');
        const second = open(FILE, 'client-1');
        const other = open(OTHER, 'client-2');

        provider.postLoadingToDocument(FILE.toString(), { state: 'progress', message: ' Placing cells\n', detail: 'stage 2 of 3' });
        provider.postLoadingToDocument(FILE.toString(), { state: 'done' });

        const expected = [
            { type: LOADING_MESSAGE_TYPE, payload: { state: 'progress', message: 'Placing cells', detail: 'stage 2 of 3' } },
            { type: LOADING_MESSAGE_TYPE, payload: { state: 'done' } }
        ];
        expect(first.posted).toEqual(expected);
        expect(second.posted).toEqual(expected);
        expect(other.posted).toEqual([]);
    });

    it('shows nothing for words with no message', () => {
        const { provider, open } = makeProvider();
        const editor = open(FILE, 'client-0');

        provider.postLoadingToDocument(FILE.toString(), { state: 'progress', message: '  ' });

        expect(editor.posted).toEqual([]);
    });
});
