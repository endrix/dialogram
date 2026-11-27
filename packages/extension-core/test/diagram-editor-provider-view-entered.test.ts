/**
 * The view an editor shows, by each way a view comes to be shown, and what
 * the refreshes after it ask for.
 *
 * The ways a view of an open file is entered:
 * - the diagram's own navigation (a drill-down), and a row of the platform's
 *   outline (`hierarchy-outline.ts` `openView`): both a model request the
 *   diagram sends, which the host records as what the editor shows
 *   (glsp-activation.ts `onBeforeReceiveMessageFromClient`); recorded here as
 *   that hook records it;
 * - an entry by name from the host (`refreshFromHost` with `open: true`):
 *   the refresh command with `{ sourceUri, workflowName, open: true }`, from
 *   a row that is the product's (`outline.activate`), and the open command
 *   with `{ sourceUri, networkName }` on an editor that is open already; the
 *   view is the editor's root (its crumbs start over at it, with no crumb
 *   back to the file's root) and is recorded;
 * - a refresh that names a view (the refresh command with `workflowName`
 *   alone): it draws that view where no name is on record and records
 *   nothing (#197: a refresh never changes which view an editor shows).
 *
 * Each is followed by a refresh that names none (a view option marked
 * `reload`, a save) and by a refresh that names another view.
 */
import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { DiagramProfile } from '../src/api';
import { ViewOptionsHost } from '../src/extension/diagram/view-options-host';

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

const ROOT = vscode.Uri.file('/w/top.src');

/** An editor of ROOT (two with `second`) that has shown its default view: the diagram's first request named none. */
function editorOnRoot(second = false) {
    const dispatched: Array<{ action: any; clientId: string }> = [];
    const connector = {
        onDidChangeCustomDocument: undefined,
        dispatchAction: (action: any, clientId: string) => dispatched.push({ action, clientId })
    } as any;
    const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
    const provider: any = new WorkflowEditorProvider(context, connector, {} as unknown as DiagramProfile);
    const clients = second ? ['client-1', 'client-2'] : ['client-1'];
    for (const clientId of clients) {
        provider.trackEditor(ROOT, clientId);
        // As the hook records the diagram's first request: its file, no name.
        provider.setRefreshContextForClient(clientId, { shownSourceUri: ROOT.toString(), queueTraceVisible: true });
    }
    const viewOptions = new ViewOptionsHost({
        groups: [{ id: 'kinds', label: 'Kinds', reload: true, items: [{ id: 'b', label: 'B' }] }],
        store: { load: async () => undefined, save: async () => undefined } as any,
        keyOf: uri => provider.canonicalizeUriString(uri),
        pathOf: uri => vscode.Uri.parse(uri).fsPath,
        post: () => undefined,
        refresh: sourceUri => provider.refreshFromHost(sourceUri)
    });
    let ticks = 0;
    return {
        provider,
        dispatched,
        /** The views the editors were asked for since the last call, by name (`-` for none). */
        asked(): string[] {
            const names = dispatched.filter(entry => entry.action.kind === 'requestModel')
                .map(entry => (second ? `${entry.clientId}:` : '') + (entry.action.options.networkName ?? '-'));
            dispatched.length = 0;
            return names;
        },
        /** A tick of a view option marked `reload`. */
        async tick(): Promise<void> {
            ticks += 1;
            await viewOptions.set(ROOT.toString(), { group: 'kinds', item: 'b', checked: ticks % 2 === 0 });
        },
        /** A save of the file, as `onDidSaveTextDocument` refreshes each editor. */
        save(clientId = 'client-1'): void {
            provider.dispatchModelRefresh(clientId, provider.canonicalizeUriString(ROOT), { forceReloadFromDisk: true });
        }
    };
}

/** The trail a drill-down or an outline row gives a view of the root's: the root, then it. */
const trailTo = (name: string) => JSON.stringify([
    { sourceUri: ROOT.toString(), workflowName: 'top' },
    { sourceUri: ROOT.toString(), workflowName: name, workflowInstanceName: name }
]);

type Way = { way: string; enter: (made: ReturnType<typeof editorOnRoot>, name: string) => void };

const WAYS: Way[] = [
    {
        way: 'the diagram\'s own navigation',
        enter: ({ provider }, name) => provider.setRefreshContextForClient('client-1', { shownSourceUri: ROOT.toString(), networkName: name, navTrail: trailTo(name) })
    },
    {
        // The row's double click is the diagram's model request, as a drill-down's (hierarchy-outline.ts `openView`).
        way: 'a row of the platform\'s outline',
        enter: ({ provider }, name) => provider.setRefreshContextForClient('client-1', { shownSourceUri: ROOT.toString(), networkName: name, navTrail: trailTo(name) })
    },
    { way: 'an entry by name from the host', enter: ({ provider }, name) => provider.refreshFromHost(ROOT, { workflowName: name, open: true }) },
    { way: 'a refresh with a name', enter: ({ provider }, name) => provider.refreshFromHost(ROOT, { workflowName: name }) }
];

/** What each way gives: the view asked for at a reload tick, at a save, and at a refresh naming `part2`. */
const TODAY: Record<string, { tick: string; save: string; namedAnother: string }> = {
    'the diagram\'s own navigation': { tick: 'part', save: 'part', namedAnother: 'part' },
    'a row of the platform\'s outline': { tick: 'part', save: 'part', namedAnother: 'part' },
    'an entry by name from the host': { tick: 'part', save: 'part', namedAnother: 'part' },
    'a refresh with a name': { tick: '-', save: '-', namedAnother: 'part2' }
};

describe('the view an editor shows, by the way it was entered', () => {
    for (const { way, enter } of WAYS) {
        describe(way, () => {
            it('is what a view option marked `reload` asks for, or not', async () => {
                const made = editorOnRoot();
                enter(made, 'part');
                made.asked();
                await made.tick();
                expect(made.asked()).toEqual([TODAY[way].tick]);
            });

            it('is what a save asks for, or not', () => {
                const made = editorOnRoot();
                enter(made, 'part');
                made.asked();
                made.save();
                expect(made.asked()).toEqual([TODAY[way].save]);
            });

            it('gives way, or not, to a refresh that names another view', () => {
                const made = editorOnRoot();
                enter(made, 'part');
                made.asked();
                made.provider.refreshFromHost(ROOT, { workflowName: 'part2' });
                expect(made.asked()).toEqual([TODAY[way].namedAnother]);
            });
        });
    }
});

describe('entering views of an open file one after another', () => {
    it('by name from the host: each is shown, the next replaces the one before, and is kept through a tick and a save', async () => {
        const made = editorOnRoot();
        made.provider.refreshFromHost(ROOT, { workflowName: 'part', open: true });
        made.provider.refreshFromHost(ROOT, { workflowName: 'part2', open: true });
        expect(made.asked()).toEqual(['part', 'part2']);
        await made.tick();
        made.save();
        expect(made.asked()).toEqual(['part2', 'part2']);
    });

    it('by refreshes with names: each is shown, and none is kept', async () => {
        const made = editorOnRoot();
        made.provider.refreshFromHost(ROOT, { workflowName: 'part' });
        made.provider.refreshFromHost(ROOT, { workflowName: 'part2' });
        expect(made.asked()).toEqual(['part', 'part2']);
        await made.tick();
        expect(made.asked()).toEqual(['-']);
        expect(made.provider.getRefreshContextForClient('client-1')?.networkName).toBeUndefined();
    });

    it('by name from the host into one of two editors of the file: the one used last, and the other keeps its view', async () => {
        const made = editorOnRoot(true);
        made.provider.refreshFromHost(ROOT, { workflowName: 'part', open: true });
        const entered = made.asked();
        expect(entered).toHaveLength(1);
        const [clientId] = entered[0].split(':');
        const other = clientId === 'client-1' ? 'client-2' : 'client-1';
        expect(made.provider.getRefreshContextForClient(clientId)?.networkName).toBe('part');
        expect(made.provider.getRefreshContextForClient(other)?.networkName).toBeUndefined();
        made.save(clientId);
        made.save(other);
        expect(made.asked()).toEqual([`${clientId}:part`, `${other}:-`]);
    });

    it('back to the root by the diagram\'s own navigation, then a tick: the root', async () => {
        const made = editorOnRoot();
        made.provider.refreshFromHost(ROOT, { workflowName: 'part', open: true });
        // The root asked for by the diagram (its outline's root row, a crumb), by name: the hook records it.
        made.provider.setRefreshContextForClient('client-1', { shownSourceUri: ROOT.toString(), networkName: 'top', navTrail: JSON.stringify([{ sourceUri: ROOT.toString(), workflowName: 'top' }]) });
        made.asked();
        await made.tick();
        expect(made.asked()).toEqual(['top']);
    });
});

describe('an entry is the editor\'s root', () => {
    /** The crumbs each editor was asked for since the last call, by name. */
    const crumbsAsked = (made: ReturnType<typeof editorOnRoot>) => {
        const asked = made.dispatched.filter(entry => entry.action.kind === 'requestModel')
            .map(entry => (JSON.parse(entry.action.options['wf:navTrail'] ?? '[]') as Array<{ workflowName: string }>).map(crumb => crumb.workflowName));
        made.dispatched.length = 0;
        return asked;
    };

    it('its crumbs start over at it, with none back to the file\'s root, through a tick and a save', async () => {
        const made = editorOnRoot();
        made.provider.refreshFromHost(ROOT, { workflowName: 'part', open: true });
        await made.tick();
        made.save();
        expect(crumbsAsked(made)).toEqual([['part'], ['part'], ['part']]);
    });

    it('a trail a caller passes with it is ignored, and does no harm', () => {
        const made = editorOnRoot();
        made.provider.refreshFromHost(ROOT, { workflowName: 'part', open: true, trail: ['top', 'part'] } as never);
        const record = made.provider.getRefreshContextForClient('client-1');
        expect(crumbsAsked(made)).toEqual([['part']]);
        made.provider.refreshFromHost(ROOT, { workflowName: 'part', open: true });
        expect(made.provider.getRefreshContextForClient('client-1')).toEqual(record);
    });
});

describe('a refresh with a name leaves nothing on record', () => {
    it('the run toolbar\'s eye toggle, which names the view it is on', () => {
        const made = editorOnRoot();
        const before = made.provider.getRefreshContextForClient('client-1');
        made.provider.refreshFromHost(ROOT, { workflowName: 'top', agentContextOnly: true });
        expect(made.provider.getRefreshContextForClient('client-1')).toEqual(before);
        made.asked();
        made.save();
        expect(made.asked()).toEqual(['-']);
    });

    it('so a graph renamed or gone since is not asked for again', () => {
        const made = editorOnRoot();
        made.provider.refreshFromHost(ROOT, { workflowName: 'part' });
        made.asked();
        // The producer no longer has `part`: the next refresh names nothing.
        made.save();
        expect(made.asked()).toEqual(['-']);
    });

    it('nor takes the name where two editors of the file are asked', () => {
        const made = editorOnRoot(true);
        made.provider.refreshFromHost(ROOT, { workflowName: 'part' });
        expect(made.asked()).toEqual(['client-1:-', 'client-2:-']);
        expect(made.provider.getRefreshContextForClient('client-1')?.networkName).toBeUndefined();
        expect(made.provider.getRefreshContextForClient('client-2')?.networkName).toBeUndefined();
    });
});
