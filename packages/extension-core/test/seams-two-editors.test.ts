// The seams together, with two diagram editors on one file.
//
// The editor provider keeps one record per editor ("View: Split Editor
// Right" makes a second editor of the same file, with a client of its own).
// The view options and the outline on demand were written when it kept one
// per file: a reader's change was told to "the file's other editors" by the
// file's URI, which is also the second editor's, so the second editor of the
// same file never heard it; and an outline row the product revealed went to
// the file, not to each editor showing it. These pin each message to where it
// belongs: a view option to every editor of the file, the one it came from
// too (with what the host made of it), an outline page to the editor that
// asked, a revealed row to each editor showing the file once.
import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
    applyViewOptionTurns,
    normalizeViewOptionGroups,
    turnsOf,
    type ViewOptionChange,
    OUTLINE_REPLY_MESSAGE,
    OUTLINE_REQUEST_MESSAGE,
    OUTLINE_REVEAL_MESSAGE,
    VIEW_OPTIONS_CHANGED_MESSAGE,
    VIEW_OPTIONS_TURNED_MESSAGE,
    type DiagramModelSource,
    type GraphDocument,
    type OutlinePage,
    type ViewOptionGroup,
    type ViewOptionsState
} from '@dialogram/shared';
import { ViewOptionsHost } from '../src/extension/diagram/view-options-host';
import { OutlineHost } from '../src/extension/diagram/outline-host';
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
const kinds: ViewOptionGroup = {
    id: 'kinds',
    label: 'Kinds',
    items: [
        { id: 'a', label: 'A', color: '#ff0000' },
        { id: 'b', label: 'B' },
        { id: 'c', label: 'C' }
    ]
};

interface FakeEditor {
    posted: any[];
    send(message: unknown): Promise<unknown>;
    close(): void;
}

function makeProvider(profile: Partial<DiagramProfile> = {}) {
    const dispatched: Array<{ action: any; clientId: string }> = [];
    const connector = {
        onDidChangeCustomDocument: undefined,
        dispatchAction: (action: any, clientId: string) => dispatched.push({ action, clientId }),
        sendMessageToClient: () => undefined
    } as any;
    const provider: any = new WorkflowEditorProvider(
        { subscriptions: [] } as unknown as vscode.ExtensionContext,
        connector,
        { key: 'fixture', settingsNamespace: 'fixture', sourceExtensions: ['.dsl'], ...profile } as unknown as DiagramProfile,
        vscode.Uri.file('/fake-ext')
    );
    const open = (uri: vscode.Uri, clientId: string): FakeEditor => {
        const posted: any[] = [];
        const disposeCbs: Array<() => void> = [];
        let onMessage: ((message: unknown) => Promise<unknown>) | undefined;
        const webview = {
            cspSource: 'vscode-webview://webview',
            asWebviewUri: (u: vscode.Uri) => vscode.Uri.parse(`https://webview${u.fsPath}`),
            onDidReceiveMessage: (cb: any) => {
                onMessage = cb;
                return { dispose() {} };
            },
            postMessage: async (message: unknown) => {
                posted.push(message);
                return true;
            },
            options: {},
            html: ''
        };
        const panel: any = {
            webview,
            active: false,
            onDidDispose: (cb: () => void) => {
                disposeCbs.push(cb);
                return { dispose() {} };
            },
            onDidChangeViewState: () => ({ dispose() {} })
        };
        provider.setUpWebview({ uri } as vscode.CustomDocument, panel, {} as vscode.CancellationToken, clientId);
        return { posted, send: message => onMessage!(message), close: () => disposeCbs.forEach(cb => cb()) };
    };
    return { provider, dispatched, open };
}

/** The host wired to the provider as glsp-activation.ts wires it. */
function viewOptionsFor(provider: any, kept: Record<string, ViewOptionsState> = {}) {
    const host = new ViewOptionsHost({
        groups: [kinds],
        store: {
            load: async file => kept[file],
            save: async (file, state) => {
                kept[file] = state;
            }
        },
        keyOf: uri => provider.canonicalizeUriString(uri),
        pathOf: uri => vscode.Uri.parse(uri).fsPath,
        post: (sourceUri, message) => {
            for (const editor of provider.clientsShowing(sourceUri)) {
                provider.postToClient(editor.clientId, message(editor.sourceUri));
            }
        },
        refresh: sourceUri => provider.refreshFromHost(sourceUri)
    });
    provider.viewOptionsHost = host;
    return host;
}

function outlineFor(provider: any) {
    let release: (() => void) | undefined;
    const held = new Promise<void>(resolve => {
        release = resolve;
    });
    let hold = false;
    const host = new OutlineHost({
        outline: {
            async page(_file, request): Promise<OutlinePage> {
                if (hold) {
                    await held;
                }
                return { total: 100_000, offset: request.offset, rows: [{ id: `r${request.offset}`, label: `row ${request.offset}` }] };
            }
        },
        pathOf: uri => vscode.Uri.parse(uri).fsPath,
        editorsOf: uri => provider.clientIdsShowing(uri),
        post: (clientId, message) => {
            provider.postToClient(clientId, message);
        }
    });
    provider.outlineHost = host;
    return {
        host,
        holdPages: () => {
            hold = true;
        },
        releasePages: () => release?.()
    };
}

const turned = (editor: FakeEditor) => editor.posted.filter(message => message?.type === VIEW_OPTIONS_TURNED_MESSAGE);

describe('view options, with two editors on one file', () => {
    it('a line the reader turns in one editor is shown in the other, and the first hears what the host made of it', async () => {
        const { provider, open } = makeProvider();
        const first = open(FILE, 'client-0');
        const second = open(FILE, 'client-1');
        viewOptionsFor(provider);

        await first.send({
            type: VIEW_OPTIONS_CHANGED_MESSAGE,
            payload: { sourceUri: FILE.toString(), changes: [{ group: 'kinds', item: 'b', checked: false }] }
        });

        expect(turned(second)).toHaveLength(1);
        expect(turned(second)[0].payload.turns).toEqual([{ group: 'kinds', item: 'b', checked: false }]);
        expect(turned(first)).toEqual(turned(second));
    });

    it('a reader’s click racing a change the host made: every diagram ends as the host holds it', async () => {
        const { provider, open } = makeProvider();
        const first = open(FILE, 'client-0');
        const second = open(FILE, 'client-1');
        const host = viewOptionsFor(provider);
        // Each webview's copy, as the diagram's ViewOptionsService keeps it:
        // a click in force at once, then the lines the host turned, in order.
        const shown = normalizeViewOptionGroups([kinds]);
        const copy = { first: shown, second: shown };

        // The reader picks Only A while a chat tool's "hide A" reaches the host first.
        const clicked: ViewOptionChange = { group: 'kinds', only: 'a' };
        copy.first = applyViewOptionTurns(copy.first, turnsOf(copy.first, clicked));
        await host.set(FILE.toString(), { group: 'kinds', item: 'a', checked: false });
        await first.send({ type: VIEW_OPTIONS_CHANGED_MESSAGE, payload: { sourceUri: FILE.toString(), changes: [clicked] } });
        for (const message of turned(first)) {
            copy.first = applyViewOptionTurns(copy.first, message.payload.turns);
        }
        for (const message of turned(second)) {
            copy.second = applyViewOptionTurns(copy.second, message.payload.turns);
        }

        const states = (groups: ViewOptionGroup[]) => groups[0].items.map(item => `${item.id}:${item.checked !== false}`).join(' ');
        const held = states(await host.get(FILE.toString()));
        expect(held).toBe('a:true b:false c:false');
        expect(states(copy.second)).toBe(held);
        expect(states(copy.first)).toBe(held);
    });

    it('each editor is told the file as it names it, whatever spelling the host was handed', async () => {
        const { provider, open } = makeProvider();
        const first = open(FILE, 'client-0');
        const host = viewOptionsFor(provider);

        await host.set('file:///w/./top.dsl', { group: 'kinds', item: 'a', checked: false });

        expect(turned(first).map(message => message.payload.sourceUri)).toEqual([FILE.toString()]);
    });

    it('a change the host makes reaches both editors', async () => {
        const { provider, open } = makeProvider();
        const first = open(FILE, 'client-0');
        const second = open(FILE, 'client-1');
        const host = viewOptionsFor(provider);

        await host.set(FILE.toString(), { group: 'kinds', item: 'a', checked: false });

        expect(turned(first)).toHaveLength(1);
        expect(turned(second)).toHaveLength(1);
    });

    it('the editor left open after the other closes still hears the host', async () => {
        const { provider, open } = makeProvider();
        const first = open(FILE, 'client-0');
        const second = open(FILE, 'client-1');
        const host = viewOptionsFor(provider);
        first.close();

        await host.set(FILE.toString(), { group: 'kinds', item: 'a', checked: false });

        expect(turned(first)).toEqual([]);
        expect(turned(second)).toHaveLength(1);
    });
});

describe('the outline on demand, with two editors on one file', () => {
    it('a page goes to the editor that asked for it, not to the other', async () => {
        const { provider, open } = makeProvider();
        const first = open(FILE, 'client-0');
        const second = open(FILE, 'client-1');
        outlineFor(provider);

        await second.send({
            type: OUTLINE_REQUEST_MESSAGE,
            payload: { requestId: 'q1', sourceUri: FILE.toString(), op: 'page', group: 'rows', offset: 40, limit: 1, query: '' }
        });

        const replies = (editor: FakeEditor) => editor.posted.filter(message => message?.type === OUTLINE_REPLY_MESSAGE);
        expect(replies(first)).toEqual([]);
        expect(replies(second)).toHaveLength(1);
        expect(replies(second)[0].payload.page.rows[0].id).toBe('r40');
    });

    it('a page that comes after its editor closed goes nowhere', async () => {
        const { provider, open } = makeProvider();
        const first = open(FILE, 'client-0');
        const second = open(FILE, 'client-1');
        const outline = outlineFor(provider);
        outline.holdPages();

        const asked = second.send({
            type: OUTLINE_REQUEST_MESSAGE,
            payload: { requestId: 'q2', sourceUri: FILE.toString(), op: 'page', group: 'rows', offset: 0, limit: 1, query: '' }
        });
        second.close();
        outline.releasePages();
        await asked;

        expect(second.posted.filter(message => message?.type === OUTLINE_REPLY_MESSAGE)).toEqual([]);
        expect(first.posted.filter(message => message?.type === OUTLINE_REPLY_MESSAGE)).toEqual([]);
    });

    it('a row the product reveals is shown in each editor of the file, once', () => {
        const { provider, open } = makeProvider();
        const first = open(FILE, 'client-0');
        const second = open(FILE, 'client-1');
        const { host } = outlineFor(provider);

        expect(host.reveal(FILE.fsPath, { group: 'rows', id: 'r7', index: 7 })).toBe(2);

        const reveals = (editor: FakeEditor) => editor.posted.filter(message => message?.type === OUTLINE_REVEAL_MESSAGE);
        expect(reveals(first)).toHaveLength(1);
        expect(reveals(second)).toHaveLength(1);
    });
});

describe('a model source wrapped for the view options', () => {
    function source(viewOptions: ViewOptionGroup[] | undefined, gate?: Promise<void>): DiagramModelSource & { seen: any[] } {
        const seen: any[] = [];
        return {
            seen,
            async getGraph(_uri: string, options: any): Promise<GraphDocument> {
                seen.push(options);
                if (gate) {
                    await gate;
                }
                return { graph: { nodes: [], edges: [] }, ...(viewOptions ? { viewOptions } : {}) } as GraphDocument;
            }
        };
    }

    it('hands the producer the platform’s progress and signal as they came', async () => {
        const host = new ViewOptionsHost({
            store: { load: async () => ({ kinds: { a: false } }), save: async () => undefined },
            keyOf: uri => uri,
            pathOf: uri => uri,
            post: () => undefined,
            refresh: () => undefined
        });
        const inner = source([kinds]);
        const wrapped = host.wrapModelSource(inner);
        const progress = vi.fn();
        const controller = new AbortController();

        await wrapped.getGraph('file:///w/top.dsl', { requestOptions: {}, progress, signal: controller.signal });

        expect(inner.seen[0].progress).toBe(progress);
        expect(inner.seen[0].signal).toBe(controller.signal);
        expect(inner.seen[0].viewOptions).toEqual({ kinds: { a: false } });
    });

    it('does not take the groups of a load that was abandoned as the file’s', async () => {
        const host = new ViewOptionsHost({
            store: { load: async () => undefined, save: async () => undefined },
            keyOf: uri => uri,
            pathOf: uri => uri,
            post: () => undefined,
            refresh: () => undefined
        });
        const uri = 'file:///w/top.dsl';
        // A first, complete load declares `kinds`.
        await host.wrapModelSource(source([kinds])).getGraph(uri, { requestOptions: {} });
        // A second is abandoned (its editor closed) and comes back with a partial declaration.
        let open: () => void = () => undefined;
        const gate = new Promise<void>(resolve => {
            open = resolve;
        });
        const controller = new AbortController();
        const partial: ViewOptionGroup = { id: 'half', label: 'Half', items: [{ id: 'x', label: 'X' }] };
        const loading = host.wrapModelSource(source([partial], gate)).getGraph(uri, { requestOptions: {}, signal: controller.signal });
        controller.abort();
        open();
        await loading;

        expect((await host.get(uri)).map(group => group.id)).toEqual(['kinds']);
    });
});
