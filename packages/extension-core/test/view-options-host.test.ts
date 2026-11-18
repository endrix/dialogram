/**
 * The host's side of the view options: what the reader chose, per file, the
 * one place that changes it, and the way to it from the webview.
 *
 * The host holds the truth. These pin what that buys: a choice survives the
 * session (the store), it can be read and set with no diagram open (a chat
 * tool's `getViewOptions`/`setViewOptions`), every other diagram of the file
 * follows the lines turned and the one that turned them is not told again,
 * the product hears each change once, and a `reload` group has the model
 * asked for again.
 */
import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
    VIEW_OPTIONS_ARG,
    VIEW_OPTIONS_CHANGED_MESSAGE,
    VIEW_OPTIONS_TURNED_MESSAGE,
    type DiagramModelSource,
    type GraphDocument,
    type ViewOptionGroup,
    type ViewOptionsState
} from '@dialogram/shared';
import { ViewOptionsHost, type ViewOptionsHostOptions } from '../src/extension/diagram/view-options-host';
import type { DiagramProfile } from '../src/api';

const FILE = 'file:///w/top.sv';
const kinds: ViewOptionGroup = {
    id: 'kinds',
    label: 'Kinds',
    items: [
        { id: 'a', label: 'A', color: '#ff0000' },
        { id: 'b', label: 'B' },
        { id: 'c', label: 'C', disabled: 'Not drawn at this zoom' }
    ]
};
const detail: ViewOptionGroup = {
    id: 'detail',
    label: 'Detail',
    choice: 'one',
    items: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High', checked: false }]
};

function makeHost(overrides: Partial<ViewOptionsHostOptions> = {}, kept: Record<string, ViewOptionsState> = {}) {
    const posted: Array<{ sourceUri: string; message: any; exceptEditor?: string }> = [];
    const refreshed: string[] = [];
    const changes: Array<{ file: string; event: any }> = [];
    const store = {
        load: vi.fn(async (file: string) => kept[file]),
        save: vi.fn(async (file: string, state: ViewOptionsState) => {
            kept[file] = state;
        })
    };
    const host = new ViewOptionsHost({
        store,
        keyOf: uri => uri.toLowerCase(),
        pathOf: uri => vscode.Uri.parse(uri).fsPath,
        post: (sourceUri, message, exceptEditor) => posted.push({ sourceUri, message, exceptEditor }),
        refresh: sourceUri => refreshed.push(sourceUri),
        onDidChange: (file, event) => changes.push({ file, event }),
        ...overrides
    });
    return { host, store, kept, posted, refreshed, changes };
}

function source(viewOptions?: ViewOptionGroup[]): DiagramModelSource & { seen: any[] } {
    const seen: any[] = [];
    return {
        seen,
        async getGraph(_uri: string, options: any): Promise<GraphDocument> {
            seen.push(options);
            return { version: '1', graph: { id: 'g', nodes: [], edges: [] }, ...(viewOptions ? { viewOptions } : {}) } as GraphDocument;
        },
        other(): string {
            return 'kept';
        }
    } as any;
}

const checked = (groups: ViewOptionGroup[], group: string): Record<string, boolean> =>
    Object.fromEntries(groups.find(g => g.id === group)!.items.map(item => [item.id, item.checked !== false]));

describe('the groups a graph is published with', () => {
    it('are the profile’s first, then the graph’s, with the file’s choices applied', async () => {
        const { host } = makeHost({ groups: [detail] }, { '/w/top.sv': { kinds: { a: false } } });
        const wrapped = host.wrapModelSource(source([kinds]));

        const doc = await wrapped.getGraph(FILE, {} as any);

        expect(doc!.viewOptions!.map(group => group.id)).toEqual(['detail', 'kinds']);
        expect(checked(doc!.viewOptions!, 'kinds')).toEqual({ a: false, b: true, c: true });
    });

    it('leave a document that declares none, under a profile that declares none, as it was', async () => {
        const { host } = makeHost();
        const plain = source();
        const doc = await host.wrapModelSource(plain).getGraph(FILE, { networkName: 'top' } as any);

        expect(doc!.viewOptions).toBeUndefined();
        expect(plain.seen).toEqual([{ networkName: 'top' }]);
        expect((host.wrapModelSource(plain) as any).other()).toBe('kept');
    });

    it('hand getGraph the reader’s choices, for a group the producer applies itself', async () => {
        const { host } = makeHost({}, { '/w/top.sv': { kinds: { b: false } } });
        const producer = source([kinds]);
        await host.wrapModelSource(producer).getGraph(FILE, {} as any);

        expect(producer.seen[0].viewOptions).toEqual({ kinds: { b: false } });
    });
});

describe('reading and setting them from the host', () => {
    it('reads the profile’s groups before any diagram of the file was opened', async () => {
        const { host } = makeHost({ groups: [detail] });
        expect(checked(await host.get(FILE), 'detail')).toEqual({ low: true, high: false });
    });

    it('sets a line, keeps it for the file, and tells every diagram of it and the product', async () => {
        const { host, kept, posted, changes } = makeHost();
        await host.wrapModelSource(source([kinds])).getGraph(FILE, {} as any);

        const groups = await host.set(FILE, { group: 'kinds', item: 'a', checked: false });

        expect(checked(groups, 'kinds')).toEqual({ a: false, b: true, c: true });
        expect(kept['/w/top.sv']).toEqual({ kinds: { a: false } });
        expect(posted).toEqual([{
            sourceUri: FILE,
            message: { type: VIEW_OPTIONS_TURNED_MESSAGE, payload: { sourceUri: FILE, turns: [{ group: 'kinds', item: 'a', checked: false }] } },
            exceptEditor: undefined
        }]);
        expect(changes).toHaveLength(1);
        expect(changes[0].file).toBe('/w/top.sv');
        expect(changes[0].event.origin).toBe('host');
        expect(changes[0].event.turns).toEqual([{ group: 'kinds', item: 'a', checked: false }]);
    });

    it('does all, none and only, passing a line that cannot change by', async () => {
        const { host } = makeHost();
        await host.wrapModelSource(source([kinds])).getGraph(FILE, {} as any);

        expect(checked(await host.set(FILE, { group: 'kinds', all: false }), 'kinds')).toEqual({ a: false, b: false, c: true });
        expect(checked(await host.set(FILE, { group: 'kinds', only: 'b' }), 'kinds')).toEqual({ a: false, b: true, c: true });
        expect(checked(await host.set(FILE, { group: 'kinds', all: true }), 'kinds')).toEqual({ a: true, b: true, c: true });
        expect(checked(await host.set(FILE, { group: 'kinds', only: 'c' }), 'kinds')).toEqual({ a: true, b: true, c: true });
    });

    it('keeps one line of a one-of group checked', async () => {
        const { host } = makeHost({ groups: [detail] });
        expect(checked(await host.set(FILE, { group: 'detail', item: 'high', checked: true }), 'detail')).toEqual({ low: false, high: true });
        expect(checked(await host.set(FILE, { group: 'detail', item: 'high', checked: false }), 'detail')).toEqual({ low: false, high: true });
        expect(checked(await host.set(FILE, { group: 'detail', all: false }), 'detail')).toEqual({ low: false, high: true });
    });

    it('keeps a choice for a group no graph has declared yet, and applies it when one does', async () => {
        const { host, kept } = makeHost();
        await host.set(FILE, { group: 'kinds', item: 'b', checked: false });
        expect(kept['/w/top.sv']).toEqual({ kinds: { b: false } });

        const doc = await host.wrapModelSource(source([kinds])).getGraph(FILE, {} as any);
        expect(checked(doc!.viewOptions!, 'kinds')).toEqual({ a: true, b: false, c: true });
    });

    it('survives the session: a new host reads what the last one kept', async () => {
        const first = makeHost();
        await first.host.wrapModelSource(source([kinds])).getGraph(FILE, {} as any);
        await first.host.set(FILE, { group: 'kinds', only: 'a' });

        const second = makeHost({}, first.kept);
        const doc = await second.host.wrapModelSource(source([kinds])).getGraph(FILE, {} as any);
        expect(checked(doc!.viewOptions!, 'kinds')).toEqual({ a: true, b: false, c: true });
        expect(checked(await second.host.get(FILE), 'kinds')).toEqual({ a: true, b: false, c: true });
    });

    it('does not keep a group that asks not to be kept, but holds it for the session', async () => {
        const { host, kept } = makeHost({ groups: [{ ...kinds, persist: false }] });
        const groups = await host.set(FILE, { group: 'kinds', item: 'a', checked: false });

        expect(kept['/w/top.sv']).toEqual({});
        expect(checked(groups, 'kinds').a).toBe(false);
        expect(checked(await host.get(FILE), 'kinds').a).toBe(false);
    });

    it('asks every diagram of the file for its model again when a reload group turns, and only then', async () => {
        const { host, refreshed } = makeHost({ groups: [kinds, { ...detail, reload: true }] });
        await host.set(FILE, { group: 'kinds', item: 'a', checked: false });
        expect(refreshed).toEqual([]);
        await host.set(FILE, { group: 'detail', item: 'high', checked: true });
        expect(refreshed).toEqual([FILE]);
    });

    it('tells nobody of a change that turns nothing', async () => {
        const { host, posted, changes, store } = makeHost({ groups: [kinds] });
        await host.set(FILE, { group: 'kinds', item: 'a', checked: true });
        await host.set(FILE, { group: 'kinds', item: 'c', checked: false });
        expect(posted).toEqual([]);
        expect(changes).toEqual([]);
        expect(store.save).not.toHaveBeenCalled();
    });

    it('logs a product that throws, and keeps the change', async () => {
        const log = vi.fn();
        const { host, kept } = makeHost({ groups: [kinds], log, onDidChange: () => { throw new Error('boom'); } });
        await host.set(FILE, { group: 'kinds', item: 'a', checked: false });
        expect(kept['/w/top.sv']).toEqual({ kinds: { a: false } });
        expect(log).toHaveBeenCalledWith(expect.stringContaining('boom'));
    });
});

describe('a reader’s change, from a webview', () => {
    it('is kept and told to the other diagrams of the file, not to the one it came from', async () => {
        const { host, kept, posted, changes } = makeHost({ groups: [kinds] });
        await host.onWebviewChange('file:///w/editor.sv', { sourceUri: FILE, changes: [{ group: 'kinds', item: 'b', checked: false }] });

        expect(kept['/w/top.sv']).toEqual({ kinds: { b: false } });
        expect(posted[0].exceptEditor).toBe('file:///w/editor.sv');
        expect(changes[0].event.origin).toBe('reader');
    });

    it('is applied in the order it came, each on what the one before left', async () => {
        const { host } = makeHost({ groups: [kinds] });
        await Promise.all([
            host.onWebviewChange('e', { sourceUri: FILE, changes: [{ group: 'kinds', all: false }] }),
            host.onWebviewChange('e', { sourceUri: FILE, changes: [{ group: 'kinds', item: 'a', checked: true }] }),
            host.set(FILE, { group: 'kinds', item: 'b', checked: true })
        ]);
        expect(checked(await host.get(FILE), 'kinds')).toEqual({ a: true, b: true, c: true });
    });

    it('ignores a message that is not one', async () => {
        const { host, posted } = makeHost({ groups: [kinds] });
        await host.onWebviewChange('e', { changes: [{ group: 'kinds', all: false }] });
        await host.onWebviewChange('e', { sourceUri: FILE, changes: [{ group: 'kinds' }, 'x'] });
        expect(posted).toEqual([]);
    });
});

// ── The provider routes the reader's change to the host ──────────────────

vi.mock('@eclipse-glsp/vscode-integration', () => ({
    GlspEditorProvider: class {
        constructor(protected readonly glspVscodeConnector: any) {}
        get onDidChangeCustomDocument(): unknown {
            return this.glspVscodeConnector?.onDidChangeCustomDocument;
        }
    },
    GlspVscodeConnector: class {}
}));

describe('the editor provider', () => {
    it('hands a view-options message to the host, and not to the product’s own hook', async () => {
        const { WorkflowEditorProvider } = await import('../src/extension/diagram/diagram-editor-provider');
        let onMessage: ((message: unknown) => Promise<unknown>) | undefined;
        const webview = {
            cspSource: 'vscode-webview://webview',
            asWebviewUri: (uri: vscode.Uri) => uri,
            onDidReceiveMessage: (callback: any) => {
                onMessage = callback;
                return { dispose() {} };
            },
            postMessage: async () => true,
            options: {},
            html: ''
        };
        const onWebviewMessage = vi.fn();
        const profile = { key: 'test', settingsNamespace: 'test', onWebviewMessage } as unknown as DiagramProfile;
        const provider = new WorkflowEditorProvider(
            { subscriptions: [] } as unknown as vscode.ExtensionContext,
            { onDidChangeCustomDocument: undefined, dispatchAction: () => {} } as any,
            profile,
            vscode.Uri.file('/fake-ext')
        );
        const onWebviewChange = vi.fn(async () => undefined);
        provider.viewOptionsHost = { onWebviewChange };
        provider.setUpWebview(
            { uri: vscode.Uri.parse(FILE) } as vscode.CustomDocument,
            { webview, onDidDispose: () => ({ dispose() {} }) } as unknown as vscode.WebviewPanel,
            {} as vscode.CancellationToken,
            'client-0'
        );

        const payload = { sourceUri: FILE, changes: [{ group: 'kinds', all: true }] };
        await onMessage!({ type: VIEW_OPTIONS_CHANGED_MESSAGE, payload });

        // Named by the editor's client, not its file: a file's second editor
        // is one of the diagrams the change has to reach.
        expect(onWebviewChange).toHaveBeenCalledWith('client-0', payload);
        expect(onWebviewMessage).not.toHaveBeenCalled();
    });
});

it('names the root argument the groups ride on', () => {
    expect(VIEW_OPTIONS_ARG).toBe('wf:viewOptions');
});
