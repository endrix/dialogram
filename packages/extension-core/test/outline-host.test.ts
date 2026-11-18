/**
 * The host's half of the outline on demand: a panel's request for rows is
 * answered from the profile's `outline.page` to that panel alone, a filter
 * goes to the producer as typed, a click on a row that is the product's
 * reaches `outline.activate` with the row's id, and the product's "show this
 * row" reaches every diagram of the file.
 */
import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
    OUTLINE_ACTIVATE_MESSAGE,
    OUTLINE_REPLY_MESSAGE,
    OUTLINE_REQUEST_MESSAGE,
    OUTLINE_REVEAL_MESSAGE,
    type OutlinePage,
    type OutlinePageRequest
} from '@dialogram/shared';
import { asUriString, OutlineHost, type OutlineProducer } from '../src/extension/diagram/outline-host';
import type { DiagramProfile } from '../src/api';

const FILE = 'file:///w/top.x';
const ROWS = 200_000;

function producer(): OutlineProducer & { asked: OutlinePageRequest[]; activated: any[] } {
    const asked: OutlinePageRequest[] = [];
    const activated: any[] = [];
    const name = (index: number): string => `row ${index}`;
    const found = (query: string): number[] =>
        Array.from({ length: ROWS }, (_, index) => index).filter(index => query === '' || name(index).includes(query));
    return {
        asked,
        activated,
        page(_file, request): OutlinePage {
            asked.push(request);
            const matching = found(request.query);
            return {
                total: matching.length,
                offset: request.offset,
                rows: matching.slice(request.offset, request.offset + request.limit).map(index => ({ id: `r${index}`, label: name(index) }))
            };
        },
        locate(_file, row) {
            const at = found(row.query).indexOf(Number(row.id.slice(1)));
            return at >= 0 ? at : undefined;
        },
        activate(file, row) {
            activated.push({ file, row });
        }
    };
}

function makeHost(outline: OutlineProducer | undefined = producer(), editors: string[] = [FILE]) {
    const posted: Array<{ editor: string; message: any }> = [];
    const log = vi.fn();
    const host = new OutlineHost({
        outline,
        pathOf: uri => vscode.Uri.parse(uri).fsPath,
        editorsOf: () => editors,
        post: (editor, message) => posted.push({ editor, message }),
        log
    });
    return { host, posted, log, outline };
}

const ask = async (host: OutlineHost, payload: Record<string, unknown>): Promise<any> => {
    const replies: any[] = [];
    await host.onWebviewRequest({ requestId: 'q1', sourceUri: FILE, ...payload }, reply => replies.push(reply));
    expect(replies).toHaveLength(1);
    expect(replies[0].type).toBe(OUTLINE_REPLY_MESSAGE);
    return replies[0].payload;
};

describe('a request for rows', () => {
    it('is answered with the page the producer gives, for the file of the outline, timed', async () => {
        const { host, outline } = makeHost();
        const reply = await ask(host, { op: 'page', group: 'rows', offset: 150_000, limit: 100, query: '' });

        expect(reply.requestId).toBe('q1');
        expect(reply.page.total).toBe(ROWS);
        expect(reply.page.offset).toBe(150_000);
        expect(reply.page.rows[0]).toEqual({ id: 'r150000', label: 'row 150000' });
        expect(reply.page.rows).toHaveLength(100);
        expect(typeof reply.ms).toBe('number');
        expect((outline as any).asked[0]).toEqual({ group: 'rows', offset: 150_000, limit: 100, query: '' });
    });

    it('carries the filter to the producer, which answers it', async () => {
        const { host } = makeHost();
        const reply = await ask(host, { op: 'page', group: 'rows', offset: 0, limit: 100, query: ' 199999 ' });
        expect(reply.page).toEqual({ total: 1, offset: 0, rows: [{ id: 'r199999', label: 'row 199999' }] });
    });

    it('keeps what is asked within bounds', async () => {
        const { host, outline } = makeHost();
        await ask(host, { op: 'page', group: 'rows', offset: -3, limit: 1e9, query: '' });
        expect((outline as any).asked[0]).toMatchObject({ offset: 0, limit: 1000 });
    });

    it('asks where a row is', async () => {
        const { host } = makeHost();
        expect((await ask(host, { op: 'locate', group: 'rows', id: 'r123', query: '' })).index).toBe(123);
        expect((await ask(host, { op: 'locate', group: 'rows', id: 'r123', query: 'row 7' })).index).toBeUndefined();
    });

    it('is answered with why, when the producer throws or there is none, so the panel stops waiting', async () => {
        const failing = makeHost({ page: () => { throw new Error('index not built'); } });
        expect((await ask(failing.host, { op: 'page', group: 'rows', offset: 0, limit: 10, query: '' })).error).toBe('index not built');
        expect(failing.log).toHaveBeenCalled();
        // A default parameter would take `undefined` for the producer: say so plainly.
        const none = new OutlineHost({ pathOf: uri => uri, editorsOf: () => [], post: () => undefined });
        expect((await ask(none, { op: 'page', group: 'rows', offset: 0, limit: 10, query: '' })).error).toBeDefined();
    });
});

describe('a click on a row that is the product’s', () => {
    it('reaches outline.activate with the file, the row’s id and its group', async () => {
        const { host, outline } = makeHost();
        await host.onWebviewActivate({ sourceUri: FILE, id: 'r7', group: 'rows', open: true });
        await host.onWebviewActivate({ sourceUri: FILE, id: 'part-1', open: false });
        await host.onWebviewActivate({ sourceUri: FILE });
        expect((outline as any).activated).toEqual([
            { file: '/w/top.x', row: { id: 'r7', group: 'rows', open: true } },
            { file: '/w/top.x', row: { id: 'part-1', open: false } }
        ]);
    });
});

describe('a row the product names', () => {
    it('is posted to every diagram of the file, which says how many there were', () => {
        const { host, posted } = makeHost(producer(), [FILE, 'file:///w/other-editor.x']);
        expect(host.reveal(FILE, { group: 'rows', id: 'r150000', index: 150_000, show: true })).toBe(2);
        expect(posted.map(post => post.editor)).toEqual([FILE, 'file:///w/other-editor.x']);
        expect(posted[0].message).toEqual({
            type: OUTLINE_REVEAL_MESSAGE,
            payload: { sourceUri: FILE, group: 'rows', id: 'r150000', index: 150_000, show: true }
        });
    });

    it('takes a path for the file, and reaches nobody with no diagram open', () => {
        expect(asUriString('/w/top.x')).toBe(FILE);
        expect(asUriString(FILE)).toBe(FILE);
        const { host, posted } = makeHost(producer(), []);
        expect(host.reveal('/w/top.x', { id: 'x' })).toBe(0);
        expect(posted).toEqual([]);
        expect(host.reveal(FILE, { id: '' })).toBe(0);
    });
});

// ── The provider routes the panel's messages to the host ────────────────

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
    it('answers a request to the webview that asked, hands a click to the host, and not to the product’s hook', async () => {
        const { WorkflowEditorProvider } = await import('../src/extension/diagram/diagram-editor-provider');
        let onMessage: ((message: unknown) => Promise<unknown>) | undefined;
        const posted: unknown[] = [];
        const webview = {
            cspSource: 'vscode-webview://webview',
            asWebviewUri: (uri: vscode.Uri) => uri,
            onDidReceiveMessage: (callback: any) => {
                onMessage = callback;
                return { dispose() {} };
            },
            postMessage: async (message: unknown) => {
                posted.push(message);
                return true;
            },
            options: {},
            html: ''
        };
        const onWebviewMessage = vi.fn();
        const provider = new WorkflowEditorProvider(
            { subscriptions: [] } as unknown as vscode.ExtensionContext,
            { onDidChangeCustomDocument: undefined, dispatchAction: () => {} } as any,
            { key: 'test', settingsNamespace: 'test', onWebviewMessage } as unknown as DiagramProfile,
            vscode.Uri.file('/fake-ext')
        );
        const { host, outline } = makeHost();
        provider.outlineHost = host;
        provider.setUpWebview(
            { uri: vscode.Uri.parse(FILE) } as vscode.CustomDocument,
            { webview, onDidDispose: () => ({ dispose() {} }) } as unknown as vscode.WebviewPanel,
            {} as vscode.CancellationToken,
            'client-0'
        );

        await onMessage!({ type: OUTLINE_REQUEST_MESSAGE, payload: { requestId: 'q9', sourceUri: FILE, op: 'page', group: 'rows', offset: 0, limit: 5, query: '' } });
        await new Promise(resolve => setTimeout(resolve, 0));
        await onMessage!({ type: OUTLINE_ACTIVATE_MESSAGE, payload: { sourceUri: FILE, id: 'r1', group: 'rows', open: false } });

        expect(posted).toHaveLength(1);
        expect((posted[0] as any).type).toBe(OUTLINE_REPLY_MESSAGE);
        expect((posted[0] as any).payload.requestId).toBe('q9');
        expect((posted[0] as any).payload.page.rows).toHaveLength(5);
        expect((outline as any).activated).toEqual([{ file: '/w/top.x', row: { id: 'r1', group: 'rows', open: false } }]);
        expect(onWebviewMessage).not.toHaveBeenCalled();
    });
});
