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
 * The refresh command (a product's "Refresh Diagram", and whatever a product
 * redraws a diagram with) is a refresh of the view on screen too, and the
 * way a product opens another graph of a file that is already open.
 */
describe('a refresh the host asks for', () => {
    it('is of the view the editor shows, in the file that view is of', () => {
        // Asked of the editor's document under the nested view's name and
        // trail, it is a view that document does not have: refused by a
        // producer that reads one file at a time, drawn as a different view
        // (and kept under a different layout) by one that does not.
        const { provider } = makeProvider();
        provider.setRefreshContext(ROOT, { shownSourceUri: CHILD.toString(), networkName: 'block', navTrail: trail });

        expect(provider.hostRefreshTarget(ROOT)).toEqual({
            sourceUri: CHILD.toString(),
            networkName: 'block',
            navTrail: trail
        });
        // Named as what it is, it is the same refresh.
        expect(provider.hostRefreshTarget(ROOT, 'block')).toEqual({
            sourceUri: CHILD.toString(),
            networkName: 'block',
            navTrail: trail
        });
    });

    it('is of the editor’s own document before anything has been shown', () => {
        const { provider } = makeProvider();

        expect(provider.hostRefreshTarget(ROOT)).toEqual({ sourceUri: ROOT.toString() });
    });

    it('opens another graph of the document as its root, not under the crumbs of the view before', () => {
        // A graph chosen from a list while the diagram is three levels down.
        // The old trail leads to the view that WAS on screen: sent along, the
        // new view is filed under it, and every view opened from there on is
        // outlined and laid out as a part of something it is not in.
        const { provider } = makeProvider();
        provider.setRefreshContext(ROOT, { shownSourceUri: CHILD.toString(), networkName: 'block', navTrail: trail });

        const target = provider.hostRefreshTarget(ROOT, ' other ');

        expect(target.sourceUri).toBe(ROOT.toString());
        expect(target.networkName).toBe('other');
        // The trail is the view itself: what the diagram starts its crumbs over from.
        expect(JSON.parse(target.navTrail!)).toEqual([{ sourceUri: ROOT.toString(), workflowName: 'other' }]);
    });

    it('remembers the graph it opened, so that the next save refreshes it and not the view before', () => {
        const { provider, dispatched } = makeProvider();
        provider.setRefreshContext(ROOT, { shownSourceUri: CHILD.toString(), networkName: 'block', navTrail: trail, runId: 'r7' });

        provider.hostRefreshTarget(ROOT, 'other');
        provider.dispatchModelRefresh('client-top', provider.canonicalizeUriString(ROOT), { forceReloadFromDisk: true });

        const options = dispatched[0].action.options;
        expect(options.sourceUri).toBe(provider.canonicalizeUriString(ROOT));
        expect(options.networkName).toBe('other');
        expect(JSON.parse(options['wf:navTrail'])).toEqual([{ sourceUri: ROOT.toString(), workflowName: 'other' }]);
        // What else is known of the editor stays known.
        expect(provider.getRefreshContext(ROOT).runId).toBe('r7');
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
