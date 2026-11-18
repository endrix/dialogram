// Where `ctx.revealRange` (the profile's `onWebviewMessage` hook) shows a source.
//
// Left to itself it shows the file where it is open, else in the active group:
// the diagram's, so the text covers the diagram. A product's "Go to source"
// wants the diagram kept in sight, and opened the file itself beside it.
// `{ beside: true }` says so; without it nothing changes.
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { DiagramProfile, RevealRangeOptions } from '../src/api';

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

const DIAGRAM = vscode.Uri.file('/w/chip.dsl');
const SOURCE = vscode.Uri.file('/w/cells.dsl');

/** The diagram in group one, active; `textIn` names the groups the source is open in. */
function layout(textIn: number[]) {
    const diagramTab = { input: new vscode.TabInputCustom(DIAGRAM, 'fixture.diagram') };
    const textTab = { input: new vscode.TabInputText(SOURCE) };
    const groups = [1, 2].map(viewColumn => ({
        viewColumn,
        tabs: [...(viewColumn === 1 ? [diagramTab] : []), ...(textIn.includes(viewColumn) ? [textTab] : [])]
    }));
    (vscode.window as any).tabGroups = { all: groups, activeTabGroup: groups[0] };
}

/** Reveal through the hook's own `ctx`, as a product does; what `showTextDocument` was asked. */
async function reveal(options?: RevealRangeOptions): Promise<{ uri: string; options: vscode.TextDocumentShowOptions }> {
    const showTextDocument = vi.fn(async () => undefined);
    (vscode.window as any).showTextDocument = showTextDocument;
    const onWebviewMessage = vi.fn(async (_uri: string, _message: unknown, ctx: any) => {
        await ctx.revealRange(SOURCE.toString(), { startLine: 4, startColumn: 2 }, options);
        return true;
    });
    const profile = { key: 'fixture', settingsNamespace: 'fixture', onWebviewMessage } as unknown as DiagramProfile;
    const context = { subscriptions: [] as Array<{ dispose(): void }> } as unknown as vscode.ExtensionContext;
    const provider = new WorkflowEditorProvider(context, { dispatchAction: () => undefined } as any, profile, vscode.Uri.file('/ext'));
    let onMessage: ((message: unknown) => unknown) | undefined;
    const webview = {
        cspSource: 'vscode-webview://webview',
        asWebviewUri: (uri: vscode.Uri) => uri,
        onDidReceiveMessage: (cb: (message: unknown) => unknown) => { onMessage = cb; return { dispose() {} }; },
        postMessage: async () => true,
        options: {},
        html: ''
    };
    const panel = { webview, onDidDispose: () => ({ dispose() {} }) } as unknown as vscode.WebviewPanel;
    provider.setUpWebview({ uri: DIAGRAM } as vscode.CustomDocument, panel, {} as vscode.CancellationToken, 'client-1');

    await onMessage!({ type: 'fixture.goToSource' });

    expect(showTextDocument).toHaveBeenCalledTimes(1);
    const [uri, shown] = showTextDocument.mock.calls[0] as unknown as [vscode.Uri, vscode.TextDocumentShowOptions];
    expect((shown.selection as vscode.Range).start).toMatchObject({ line: 4, character: 2 });
    return { uri: uri.toString(), options: shown };
}

describe('revealRange from a diagram', () => {
    afterEach(() => { delete (vscode.window as any).tabGroups; });

    it('without options: in the active group, the diagram\'s, with the focus, as before', async () => {
        layout([]);
        const { uri, options } = await reveal();

        expect(uri).toBe(SOURCE.toString());
        expect(options.viewColumn).toBeUndefined();
        expect(options.preserveFocus).toBe(false);
    });

    it('without options: in the other group where the file is open there, as before', async () => {
        layout([2]);
        expect((await reveal()).options.viewColumn).toBe(2);
    });

    it('beside: in the group beside where the file is not open', async () => {
        layout([]);
        expect((await reveal({ beside: true })).options.viewColumn).toBe(vscode.ViewColumn.Beside);
    });

    it('beside: in the other group where the file is open there', async () => {
        layout([2]);
        expect((await reveal({ beside: true })).options.viewColumn).toBe(2);
    });

    it('beside: not over the diagram where the diagram\'s group holds the file in a tab behind', async () => {
        layout([1]);
        expect((await reveal({ beside: true })).options.viewColumn).toBe(vscode.ViewColumn.Beside);
    });

    it('preserveFocus: leaves the focus on the diagram', async () => {
        layout([]);
        const { options } = await reveal({ beside: true, preserveFocus: true });

        expect(options.preserveFocus).toBe(true);
        expect(options.viewColumn).toBe(vscode.ViewColumn.Beside);
    });
});
