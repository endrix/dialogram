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
    const requests = (dispatched: Array<{ action: any; clientId: string }>) =>
        Object.fromEntries(dispatched.filter(entry => entry.action.kind === 'requestModel').map(entry => [entry.clientId, entry.action.options]));

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
        expect(provider.hostRefreshTarget(ROOT, { fallbackName: 'block' })).toEqual(onScreen);
    });

    it('is of the editor’s own document before anything has been shown', () => {
        const { provider } = makeProvider();
        const own = provider.canonicalizeUriString(ROOT);

        expect(provider.hostRefreshTarget(own)).toEqual({ sourceUri: own });
    });

    it('takes the view the caller names where there is none on record, and records nothing', () => {
        // The record is of what was asked for. An editor that has shown only
        // its default has no name on it, and the diagram's own controls name
        // the view they are on: that name keeps the view, where a refresh by
        // no name would go back to the default.
        const { provider, dispatched } = makeProvider();

        expect(provider.refreshFromHost(ROOT, { workflowName: 'sub' })).toBe(1);

        expect(requests(dispatched)['client-top']).toMatchObject({ sourceUri: provider.canonicalizeUriString(ROOT), networkName: 'sub' });
        expect(requests(dispatched)['client-top']['wf:navTrail']).toBeUndefined();
        expect(provider.getRefreshContext(ROOT)).toBeUndefined();
    });

    it('does not change the view of an editor that has one on record, whatever is named', () => {
        // A name that differs from the record is about another editor, or
        // about a view the reader has just left: the diagram's controls still
        // name the old view while the new one is on its way.
        const { provider, dispatched } = makeProvider();
        provider.setRefreshContext(ROOT, { shownSourceUri: CHILD.toString(), networkName: 'block', navTrail: trail });

        provider.refreshFromHost(ROOT, { workflowName: 'sub' });

        expect(requests(dispatched)['client-top']).toMatchObject({
            sourceUri: CHILD.toString(),
            networkName: 'block',
            'wf:navTrail': trail
        });
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

    describe('of a file two editors are in', () => {
        // `block.py` defines `block` and `inner`. One editor is opened on
        // `top.py` and shows `block` in place; another is opened on
        // `block.py` itself.
        const twoEditors = (ownView?: { networkName: string }) => {
            const made = makeProvider();
            made.provider.uriToClientId.set(made.provider.canonicalizeUriString(CHILD), 'client-child');
            made.provider.setRefreshContext(ROOT, { shownSourceUri: CHILD.toString(), networkName: 'block', navTrail: trail });
            if (ownView) {
                made.provider.setRefreshContext(CHILD, { shownSourceUri: CHILD.toString(), ...ownView });
            }
            return made;
        };

        it('reaches both, each as the view it has on screen', () => {
            const { provider, dispatched } = twoEditors();

            expect(provider.refreshFromHost(CHILD)).toBe(2);

            const asked = requests(dispatched);
            expect(asked['client-top']).toMatchObject({ sourceUri: CHILD.toString(), networkName: 'block', 'wf:navTrail': trail });
            expect(asked['client-child'].sourceUri).toBe(provider.canonicalizeUriString(CHILD));
            expect(asked['client-child'].networkName).toBeUndefined();
            expect(asked['client-child']['wf:navTrail']).toBeUndefined();
        });

        it('does not ask the editor that only shows the file for the other editor’s view', () => {
            // The control of the editor on `block.py`, drilled into `inner`,
            // names `inner`. Asked of the editor on `top.py`, that is a view
            // `top.py` does not have, under crumbs that do not lead to it.
            const { provider, dispatched } = twoEditors({ networkName: 'inner' });

            provider.refreshFromHost(CHILD, { workflowName: 'inner', agentContextOnly: true });

            const asked = requests(dispatched);
            expect(asked['client-child']).toMatchObject({ sourceUri: CHILD.toString(), networkName: 'inner' });
            expect(asked['client-top']).toMatchObject({ sourceUri: CHILD.toString(), networkName: 'block', 'wf:navTrail': trail });
        });

        it('does not move the editor opened on the file to the view the other one names', () => {
            // The control of the editor on `top.py` names `block`. The editor
            // on `block.py` is on `inner`, or has shown nothing but its
            // default: either way it stays where it is.
            for (const ownView of [{ networkName: 'inner' }, undefined]) {
                const { provider, dispatched } = twoEditors(ownView);

                provider.refreshFromHost(CHILD, { workflowName: 'block', agentContextOnly: true });

                expect(requests(dispatched)['client-child'].networkName, JSON.stringify(ownView)).toBe(ownView?.networkName);
                expect(requests(dispatched)['client-top'].networkName).toBe('block');
            }
        });
    });

    it('asks nobody about a file no editor has', () => {
        const { provider, dispatched } = makeProvider();

        expect(provider.refreshFromHost(OTHER)).toBe(0);
        expect(dispatched).toEqual([]);
    });

    it('keeps the run that is on screen', () => {
        // Without it the server shows the latest run, and the next save, which
        // does send it, the one before.
        const { provider, dispatched } = makeProvider();
        provider.setRefreshContext(ROOT, { shownSourceUri: ROOT.toString(), networkName: 'top', runId: 'r7' });

        provider.refreshFromHost(ROOT, { agentContextOnly: true });

        expect(requests(dispatched)['client-top']['wf:runId']).toBe('r7');
    });

    it('names the node to go to before it asks for the model that has it', () => {
        const { provider, dispatched } = makeProvider();

        provider.refreshFromHost(ROOT, { reveal: 'u_fifo' });

        expect(dispatched.map(entry => entry.action.kind)).toEqual(['dialogram.revealNode', 'requestModel']);
        expect(JSON.stringify(dispatched[0].action)).toContain('u_fifo');
    });
});

describe('a graph opened by name in an editor that is already open', () => {
    it('is opened as the document’s root, not under the crumbs of the view before', () => {
        // A graph chosen from a list while the diagram is three levels down.
        // The old trail leads to the view that WAS on screen: sent along, the
        // new view is filed under it, and every view opened from there on is
        // outlined and laid out as a part of something it is not in.
        const { provider, dispatched } = makeProvider();
        const own = provider.canonicalizeUriString(ROOT);
        provider.setRefreshContext(ROOT, { shownSourceUri: CHILD.toString(), networkName: 'block', navTrail: trail });

        expect(provider.refreshFromHost(ROOT, { workflowName: ' other ', open: true })).toBe(1);

        const options = dispatched[0].action.options;
        expect(options.sourceUri).toBe(own);
        expect(options.networkName).toBe('other');
        // The trail is the view itself, by the same name of the file as the
        // request: what the diagram starts its crumbs over from.
        expect(JSON.parse(options['wf:navTrail'])).toEqual([{ sourceUri: own, workflowName: 'other' }]);
    });

    it('is the root even when a view of that name is what is on screen', () => {
        // An instance of `block` three levels down, and `block` opened by
        // name: the definition, as a root, and not a refresh of the instance.
        const { provider } = makeProvider();
        provider.setRefreshContext(ROOT, { shownSourceUri: CHILD.toString(), networkName: 'block', navTrail: trail });

        const target = provider.hostRefreshTarget(ROOT, { open: 'block' });

        expect(target.sourceUri).toBe(ROOT.toString());
        expect(JSON.parse(target.navTrail!)).toEqual([{ sourceUri: ROOT.toString(), workflowName: 'block' }]);
    });

    it('is remembered, so that the next save refreshes it and not the view before', () => {
        const { provider, dispatched } = makeProvider();
        provider.setRefreshContext(ROOT, { shownSourceUri: CHILD.toString(), networkName: 'block', navTrail: trail, queueTraceVisible: true });

        provider.hostRefreshTarget(ROOT, { open: 'other' });
        provider.dispatchModelRefresh('client-top', provider.canonicalizeUriString(ROOT), { forceReloadFromDisk: true });

        const options = dispatched[0].action.options;
        expect(options.sourceUri).toBe(provider.canonicalizeUriString(ROOT));
        expect(options.networkName).toBe('other');
        expect(JSON.parse(options['wf:navTrail'])).toEqual([{ sourceUri: ROOT.toString(), workflowName: 'other' }]);
        // What is the editor's and not the view's stays.
        expect(options.queueTraceVisible).toBe(true);
    });

    it('does not carry the run selected in another graph over to it', () => {
        // A run is a run of a graph. Sent with another, it filters that
        // graph's overlay away and names a run it does not have.
        const { provider, dispatched } = makeProvider();
        provider.setRefreshContext(ROOT, { shownSourceUri: ROOT.toString(), networkName: 'top', runId: 'r7' });

        provider.refreshFromHost(ROOT, { workflowName: 'other', open: true });
        provider.dispatchModelRefresh('client-top', provider.canonicalizeUriString(ROOT), { forceReloadFromDisk: true });

        expect(dispatched.map(entry => entry.action.options['wf:runId'])).toEqual([undefined, undefined]);
    });

    it('keeps the run of the same graph opened again, in what it asks and in what it remembers', () => {
        const { provider, dispatched } = makeProvider();
        provider.setRefreshContext(ROOT, { shownSourceUri: ROOT.toString(), networkName: 'top', runId: 'r7' });

        provider.refreshFromHost(ROOT, { workflowName: 'top', open: true });

        expect(dispatched[0].action.options['wf:runId']).toBe('r7');
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

    it('is a refresh when no graph is named', () => {
        const { provider, dispatched } = makeProvider();
        provider.setRefreshContext(ROOT, { shownSourceUri: CHILD.toString(), networkName: 'block', navTrail: trail });

        provider.refreshFromHost(ROOT, { open: true });

        expect(dispatched[0].action.options).toMatchObject({ sourceUri: CHILD.toString(), networkName: 'block', 'wf:navTrail': trail });
    });
});

describe('a view the host put in an editor', () => {
    it('is what the next save refreshes, not the view before it', () => {
        // The definition of a workflow opened from another editor, into an
        // editor that exists already: asked for by the host, so the diagram's
        // own request never put it on record.
        const { provider, dispatched } = makeProvider();
        provider.setRefreshContext(ROOT, { shownSourceUri: ROOT.toString(), networkName: 'top', runId: 'r7' });

        provider.recordHostView(ROOT, { sourceUri: ROOT.toString(), networkName: 'helper', navTrail: trail });
        provider.dispatchModelRefresh('client-top', provider.canonicalizeUriString(ROOT), { forceReloadFromDisk: true });

        const options = dispatched[0].action.options;
        expect(options.networkName).toBe('helper');
        expect(options['wf:navTrail']).toBe(trail);
        // A view put there with no run named has none.
        expect(options['wf:runId']).toBeUndefined();
    });

    it('has no name when it was asked for by none', () => {
        const { provider, dispatched } = makeProvider();
        provider.setRefreshContext(ROOT, { shownSourceUri: CHILD.toString(), networkName: 'block', navTrail: trail });

        provider.recordHostView(ROOT, { sourceUri: ROOT.toString() });
        provider.dispatchModelRefresh('client-top', provider.canonicalizeUriString(ROOT), { forceReloadFromDisk: true });

        const options = dispatched[0].action.options;
        expect(options.sourceUri).toBe(provider.canonicalizeUriString(ROOT));
        expect(options.networkName).toBeUndefined();
        expect(options['wf:navTrail']).toBeUndefined();
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
