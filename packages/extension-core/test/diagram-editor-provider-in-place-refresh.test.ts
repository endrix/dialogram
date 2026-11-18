/**
 * An editor refreshes the view it shows, which navigating in place can be a
 * workflow in another file than its own document.
 *
 * The refresh context is kept per editor (its own document) and remembers the
 * shown file. A refresh -- after a save, an external change, a live preview --
 * reloads that file at the view's workflow and trail. Live-preview content is
 * the editor document's text, so for another file the view reloads from disk.
 */
import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { DiagramProfile } from '../src/api';

vi.mock('@eclipse-glsp/vscode-integration', () => ({
    GlspEditorProvider: class {
        constructor(protected readonly glspVscodeConnector: any) {}
        // A getter, as in the real base: a provider may override it.
        get onDidChangeCustomDocument(): unknown {
            return this.glspVscodeConnector?.onDidChangeCustomDocument;
        }
    },
    GlspVscodeConnector: class {}
}));

const { WorkflowEditorProvider } = await import('../src/extension/diagram/diagram-editor-provider');

const ROOT = vscode.Uri.file('/w/top.py');
const CHILD = vscode.Uri.file('/w/layers/block.py');

function makeProvider() {
    const dispatched: Array<{ action: any; clientId: string }> = [];
    const connector = {
        onDidChangeCustomDocument: undefined,
        dispatchAction: (action: any, clientId: string) => dispatched.push({ action, clientId })
    } as any;
    const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
    const provider: any = new WorkflowEditorProvider(context, connector, {} as unknown as DiagramProfile);
    provider.uriToClientId.set(provider.canonicalizeUriString(ROOT), 'client-top');
    return { provider, dispatched };
}

const trail = JSON.stringify([
    { sourceUri: ROOT.toString(), workflowName: 'top' },
    { sourceUri: CHILD.toString(), workflowName: 'block', workflowInstanceName: 'b2' }
]);

describe('refreshing an editor that navigates in place', () => {
    it('finds the editor’s document from its client', () => {
        const { provider } = makeProvider();
        expect(provider.getDocumentUriForClientId('client-top')).toBe(provider.canonicalizeUriString(ROOT));
        expect(provider.getDocumentUriForClientId('nobody')).toBeUndefined();
    });

    it('reloads the shown file at the view’s workflow and trail', () => {
        const { provider, dispatched } = makeProvider();
        provider.setRefreshContext(ROOT, { shownSourceUri: CHILD.toString(), networkName: 'block', navTrail: trail });

        provider.dispatchModelRefresh('client-top', provider.canonicalizeUriString(ROOT), { forceReloadFromDisk: true });

        const options = dispatched[0].action.options;
        expect(dispatched[0].clientId).toBe('client-top');
        expect(options.sourceUri).toBe(CHILD.toString());
        expect(options.networkName).toBe('block');
        expect(options['wf:navTrail']).toBe(trail);
    });

    it('reloads another file from disk rather than with the editor document’s text', () => {
        const { provider, dispatched } = makeProvider();
        provider.setRefreshContext(ROOT, { shownSourceUri: CHILD.toString(), networkName: 'block' });

        provider.dispatchModelRefresh('client-top', provider.canonicalizeUriString(ROOT), { content: 'top.py text' });

        const options = dispatched[0].action.options;
        expect(options.content).toBeUndefined();
        expect(options.forceReloadFromDisk).toBe(true);
    });

    it('refreshes its own document as before when that is what it shows', () => {
        const { provider, dispatched } = makeProvider();
        provider.setRefreshContext(ROOT, { shownSourceUri: ROOT.toString(), networkName: 'top' });

        provider.dispatchModelRefresh('client-top', provider.canonicalizeUriString(ROOT), { content: 'top.py text' });

        const options = dispatched[0].action.options;
        expect(options.sourceUri).toBe(provider.canonicalizeUriString(ROOT));
        expect(options.content).toBe('top.py text');
    });
});

/**
 * The refresh command (a product's "Refresh Diagram", the diagram's own
 * controls, and whatever a product redraws a diagram with) is a refresh of
 * the view on screen too. The open command on an editor that exists already
 * goes the same way to the server, and means something else: another graph of
 * the document, as its root.
 */
describe('a refresh the host asks for', () => {
    const OTHER = vscode.Uri.file('/w/other.py');

    it('is of the view the editor shows, in the file that view is of', () => {
        // Asked of the editor's document under the nested view's name and
        // trail, it is a view that document does not have: refused by a
        // producer that reads one file at a time, drawn as a different view
        // (and kept under a different layout) by one that does not.
        const { provider } = makeProvider();
        provider.setRefreshContext(ROOT, { shownSourceUri: CHILD.toString(), networkName: 'block', navTrail: trail });

        const onScreen = { sourceUri: CHILD.toString(), networkName: 'block', navTrail: trail };
        expect(provider.hostRefreshTarget(ROOT)).toEqual(onScreen);
        // Named as what it is, as the diagram's own controls name it, it is the same refresh.
        expect(provider.hostRefreshTarget(ROOT, { workflowName: 'block' })).toEqual(onScreen);
    });

    it('is of the editor’s own document before anything has been shown', () => {
        const { provider } = makeProvider();

        expect(provider.hostRefreshTarget(ROOT)).toEqual({ sourceUri: ROOT.toString() });
    });

    it('takes a name it has no record of at its word, and records nothing', () => {
        // The record is of what the DIAGRAM asked for. A view the host put on
        // screen (a definition opened from another editor, with the crumbs of
        // the way there) is not in it, and the diagram's own controls name the
        // view they are on: taken for another graph being opened, that click
        // threw the crumbs away and pinned every later refresh to the name.
        const { provider } = makeProvider();

        expect(provider.hostRefreshTarget(ROOT, { workflowName: 'sub' })).toEqual({ sourceUri: ROOT.toString(), networkName: 'sub' });
        expect(provider.getRefreshContext(ROOT)).toBeUndefined();

        // With a record of another view: of the document, as it always was.
        provider.setRefreshContext(ROOT, { shownSourceUri: CHILD.toString(), networkName: 'block', navTrail: trail });
        expect(provider.hostRefreshTarget(ROOT, { workflowName: 'sub' })).toEqual({
            sourceUri: ROOT.toString(),
            networkName: 'sub',
            navTrail: trail
        });
        expect(provider.getRefreshContext(ROOT).networkName).toBe('block');
    });

    it('reaches the editor that shows the file, not only the one opened on it', () => {
        // A view names itself by the file it is of. Looked up as a document
        // only, a refresh of a nested view of another file reached nobody.
        const { provider, dispatched } = makeProvider();
        provider.setRefreshContext(ROOT, { shownSourceUri: CHILD.toString(), networkName: 'block', navTrail: trail });

        expect(provider.editorsOf(CHILD)).toEqual([provider.canonicalizeUriString(ROOT)]);
        expect(provider.refreshFromHost(CHILD, { workflowName: 'block', agentContextOnly: true, queueTraceVisible: false })).toBe(1);

        expect(dispatched).toHaveLength(1);
        expect(dispatched[0].clientId).toBe('client-top');
        expect(dispatched[0].action.options).toMatchObject({
            sourceUri: CHILD.toString(),
            networkName: 'block',
            'wf:navTrail': trail,
            agentContextOnly: true,
            queueTraceVisible: false
        });
    });

    it('reaches every editor the file is in: its own, and those showing it', () => {
        const { provider, dispatched } = makeProvider();
        provider.uriToClientId.set(provider.canonicalizeUriString(CHILD), 'client-child');
        provider.setRefreshContext(ROOT, { shownSourceUri: CHILD.toString(), networkName: 'block', navTrail: trail });

        expect(provider.refreshFromHost(CHILD)).toBe(2);

        expect(dispatched.map(entry => entry.clientId).sort()).toEqual(['client-child', 'client-top']);
        // Each as the view it has on screen.
        const byClient = Object.fromEntries(dispatched.map(entry => [entry.clientId, entry.action.options]));
        expect(byClient['client-top']['wf:navTrail']).toBe(trail);
        expect(byClient['client-child']['wf:navTrail']).toBeUndefined();
        expect(byClient['client-child'].sourceUri).toBe(provider.canonicalizeUriString(CHILD));
    });

    it('asks nobody about a file no editor has', () => {
        const { provider, dispatched } = makeProvider();

        expect(provider.refreshFromHost(OTHER)).toBe(0);
        expect(dispatched).toEqual([]);
    });

    it('names the node to go to before it asks for the model that has it', () => {
        const { provider, dispatched } = makeProvider();

        provider.refreshFromHost(ROOT, { reveal: 'u_fifo' });

        expect(dispatched).toHaveLength(2);
        expect(dispatched[0].action.kind).not.toBe('requestModel');
        expect(dispatched[1].action.kind).toBe('requestModel');
    });
});

describe('a graph opened by name in an editor that is already open', () => {
    it('is opened as the document’s root, not under the crumbs of the view before', () => {
        // A graph chosen from a list while the diagram is three levels down.
        // The old trail leads to the view that WAS on screen: sent along, the
        // new view is filed under it, and every view opened from there on is
        // outlined and laid out as a part of something it is not in.
        const { provider, dispatched } = makeProvider();
        provider.setRefreshContext(ROOT, { shownSourceUri: CHILD.toString(), networkName: 'block', navTrail: trail });

        expect(provider.refreshFromHost(ROOT, { workflowName: ' other ', open: true })).toBe(1);

        const options = dispatched[0].action.options;
        expect(options.sourceUri).toBe(ROOT.toString());
        expect(options.networkName).toBe('other');
        // The trail is the view itself: what the diagram starts its crumbs over from.
        expect(JSON.parse(options['wf:navTrail'])).toEqual([{ sourceUri: ROOT.toString(), workflowName: 'other' }]);
    });

    it('is the root even when a view of that name is what is on screen', () => {
        // An instance of `block` three levels down, and `block` opened by
        // name: the definition, as a root, and not a refresh of the instance.
        const { provider } = makeProvider();
        provider.setRefreshContext(ROOT, { shownSourceUri: CHILD.toString(), networkName: 'block', navTrail: trail });

        const target = provider.hostRefreshTarget(ROOT, { workflowName: 'block', open: true });

        expect(target.sourceUri).toBe(ROOT.toString());
        expect(JSON.parse(target.navTrail!)).toEqual([{ sourceUri: ROOT.toString(), workflowName: 'block' }]);
    });

    it('is remembered, so that the next save refreshes it and not the view before', () => {
        const { provider, dispatched } = makeProvider();
        provider.setRefreshContext(ROOT, { shownSourceUri: CHILD.toString(), networkName: 'block', navTrail: trail, queueTraceVisible: true });

        provider.hostRefreshTarget(ROOT, { workflowName: 'other', open: true });
        provider.dispatchModelRefresh('client-top', provider.canonicalizeUriString(ROOT), { forceReloadFromDisk: true });

        const options = dispatched[0].action.options;
        expect(options.sourceUri).toBe(provider.canonicalizeUriString(ROOT));
        expect(options.networkName).toBe('other');
        expect(JSON.parse(options['wf:navTrail'])).toEqual([{ sourceUri: ROOT.toString(), workflowName: 'other' }]);
        // What is the editor's and not the view's stays.
        expect(options.queueTraceVisible).toBe(true);
    });

    it('does not carry the run selected in another graph over to it', () => {
        // A run is a run of a graph. Sent with the next save of another, it
        // filters that graph's overlay away and names a run it does not have.
        const { provider, dispatched } = makeProvider();
        provider.setRefreshContext(ROOT, { shownSourceUri: ROOT.toString(), networkName: 'top', runId: 'r7' });

        provider.hostRefreshTarget(ROOT, { workflowName: 'other', open: true });
        provider.dispatchModelRefresh('client-top', provider.canonicalizeUriString(ROOT), { forceReloadFromDisk: true });
        expect(dispatched[0].action.options['wf:runId']).toBeUndefined();

        // The same graph opened again keeps the run it was showing.
        provider.setRefreshContext(ROOT, { shownSourceUri: ROOT.toString(), networkName: 'top', runId: 'r7' });
        provider.hostRefreshTarget(ROOT, { workflowName: 'top', open: true });
        expect(provider.getRefreshContext(ROOT).runId).toBe('r7');
    });

    it('is of the editor opened on the file, and of no editor that only shows it', () => {
        const { provider, dispatched } = makeProvider();
        provider.setRefreshContext(ROOT, { shownSourceUri: CHILD.toString(), networkName: 'block', navTrail: trail });

        // `block.py` has no editor of its own: nothing is opened in `top.py`'s.
        expect(provider.refreshFromHost(CHILD, { workflowName: 'block', open: true })).toBe(0);
        expect(dispatched).toEqual([]);
        expect(provider.getRefreshContext(ROOT).networkName).toBe('block');
    });
});

/**
 * A nested workflow's file, edited in a text editor without saving: the views
 * showing it preview the change, as an editor's own document always did.
 */
describe('live preview of a file shown in another editor', () => {
    const change = (uri: vscode.Uri, text: string) => ({
        document: { uri, getText: () => text },
        contentChanges: [{ text: 'x' }]
    });

    it('refreshes the view showing it, with that file’s text', () => {
        vi.useFakeTimers();
        try {
            const { provider, dispatched } = makeProvider();
            provider.setRefreshContext(ROOT, { shownSourceUri: CHILD.toString(), networkName: 'block' });

            provider.handleDocumentChange(change(CHILD, 'block.py, unsaved'));
            vi.runAllTimers();

            expect(dispatched).toHaveLength(1);
            const options = dispatched[0].action.options;
            expect(dispatched[0].clientId).toBe('client-top');
            expect(options.sourceUri).toBe(CHILD.toString());
            expect(options.content).toBe('block.py, unsaved');
            expect(options.forceReloadFromDisk).toBeUndefined();
        } finally {
            vi.useRealTimers();
        }
    });

    it('leaves alone an editor that is not showing it', () => {
        vi.useFakeTimers();
        try {
            const { provider, dispatched } = makeProvider();
            provider.setRefreshContext(ROOT, { shownSourceUri: ROOT.toString(), networkName: 'top' });

            provider.handleDocumentChange(change(CHILD, 'block.py, unsaved'));
            vi.runAllTimers();

            expect(dispatched).toHaveLength(0);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('a nested workflow’s file changed on disk', () => {
    it('reloads the view showing it, at its trail', () => {
        vi.useFakeTimers();
        try {
            const { provider, dispatched } = makeProvider();
            provider.setRefreshContext(ROOT, { shownSourceUri: CHILD.toString(), networkName: 'block', navTrail: trail });

            provider.handleExternalFileChange(CHILD);
            vi.runAllTimers();

            expect(dispatched).toHaveLength(1);
            const options = dispatched[0].action.options;
            expect(options.sourceUri).toBe(CHILD.toString());
            expect(options['wf:navTrail']).toBe(trail);
            expect(options.forceReloadFromDisk).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });
});
