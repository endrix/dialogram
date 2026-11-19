// Which diagrams a watched file reloads (`DiagramProfile.watch.affects`).
//
// Without it, a change to one of the product's sources reloads every open
// diagram, and a change to any other watched file reloads none: a side file a
// product reads (a manifest, a technology file) never reached its diagrams,
// although `watch.globs` named it. With it, the product is asked about every
// file its globs see, and only the diagrams it names are reloaded, with the
// changed file's own.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { DiagramProfile, DiagramWatchAffects } from '../src/api';

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

const CHIP = vscode.Uri.file('/w/chip.dsl');
const BLOCK = vscode.Uri.file('/w/block.dsl');
const TECH = vscode.Uri.file('/w/tech.json');

function makeProvider(affects?: DiagramWatchAffects) {
    const dispatched: Array<{ clientId: string; options: any }> = [];
    const connector = {
        onDidChangeCustomDocument: undefined,
        dispatchAction: (action: any, clientId: string) => dispatched.push({ clientId, options: action.options })
    } as any;
    const context = { subscriptions: [] as Array<{ dispose(): void }> } as unknown as vscode.ExtensionContext;
    const profile = {
        key: 'fixture',
        settingsNamespace: 'fixture',
        sourceExtensions: ['.dsl'],
        watch: { globs: ['**/*.dsl', '**/tech.json'], ...(affects ? { affects } : {}) }
    } as unknown as DiagramProfile;
    const provider: any = new WorkflowEditorProvider(context, connector, profile);
    provider.trackEditor(CHIP, 'client-chip');
    provider.trackEditor(BLOCK, 'client-block');
    const reloaded = (): string[] => [...new Set(dispatched.map(d => d.clientId))].sort();
    return { provider, dispatched, reloaded };
}

/** Let the debounce run out and the product's answer (a promise) arrive. */
async function settle(): Promise<void> {
    await vi.advanceTimersByTimeAsync(300);
}

describe('a watched file\'s change', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('without `affects`: a source reloads every diagram, a side file none, as before', async () => {
        const { provider, reloaded, dispatched } = makeProvider();

        provider.handleExternalFileChange(TECH);
        await settle();
        expect(reloaded()).toEqual([]);

        provider.handleExternalFileChange(BLOCK);
        await settle();
        expect(reloaded()).toEqual(['client-block', 'client-chip']);
        expect(dispatched.every(d => d.options.forceReloadFromDisk === true)).toBe(true);
    });

    it('with `affects`: a side file reloads only the diagrams the product names', async () => {
        const affects = vi.fn(async (changed: string, open: readonly string[]) =>
            changed.endsWith('tech.json') ? open.filter(uri => uri.endsWith('chip.dsl')) : []);
        const { provider, reloaded } = makeProvider(affects);

        provider.handleExternalFileChange(TECH);
        await settle();

        expect(reloaded()).toEqual(['client-chip']);
        expect(affects).toHaveBeenCalledWith(TECH.toString(), [CHIP.toString(), BLOCK.toString()]);
    });

    it('with `affects`: a file\'s own diagram is reloaded whatever the product answers', async () => {
        const { provider, reloaded } = makeProvider(() => []);

        provider.handleExternalFileChange(BLOCK);
        await settle();

        expect(reloaded()).toEqual(['client-block']);
    });

    it('takes the changes of one burst together', async () => {
        const affects = vi.fn((changed: string) => (changed.endsWith('tech.json') ? [CHIP.toString()] : undefined));
        const { provider, reloaded } = makeProvider(affects);

        provider.handleExternalFileChange(TECH);
        provider.handleExternalFileChange(BLOCK);
        await settle();

        expect(affects).toHaveBeenCalledTimes(2);
        expect(reloaded()).toEqual(['client-block', 'client-chip']);
    });

    it('ignores what the product names that has no diagram open', async () => {
        const { provider, reloaded } = makeProvider(() => [vscode.Uri.file('/w/closed.dsl').toString()]);

        provider.handleExternalFileChange(TECH);
        await settle();

        expect(reloaded()).toEqual([]);
    });

    it('reloads every diagram when the product\'s hook fails', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            const { provider, reloaded } = makeProvider(() => { throw new Error('no index yet'); });

            provider.handleExternalFileChange(TECH);
            await settle();

            expect(reloaded()).toEqual(['client-block', 'client-chip']);
        } finally {
            warn.mockRestore();
        }
    });

    it('is not asked about a file under a build tree', async () => {
        const affects = vi.fn(() => [CHIP.toString()]);
        const { provider, reloaded } = makeProvider(affects);

        provider.handleExternalFileChange(vscode.Uri.file('/w/build/tech.json'));
        await settle();

        expect(affects).not.toHaveBeenCalled();
        expect(reloaded()).toEqual([]);
    });

    it('maps a save made in the editor the same way', async () => {
        const { provider, reloaded } = makeProvider(changed => (changed.endsWith('block.dsl') ? [CHIP.toString()] : []));

        provider.handleDocumentSave({ uri: BLOCK } as vscode.TextDocument);
        await settle();

        expect(reloaded()).toEqual(['client-block', 'client-chip']);
    });
});

describe('what is watched on disk (`watch.globs`)', () => {
    function watchedBy(watch: DiagramProfile['watch']): string[] {
        const globs: string[] = [];
        const spy = vi.spyOn(vscode.workspace, 'createFileSystemWatcher').mockImplementation(((glob: string) => {
            globs.push(glob);
            return { onDidChange: () => ({ dispose() {} }), onDidCreate: () => ({ dispose() {} }), dispose() {} };
        }) as any);
        try {
            const context = { subscriptions: [] as Array<{ dispose(): void }> } as unknown as vscode.ExtensionContext;
            const profile = { key: 'fixture', settingsNamespace: 'fixture', sourceExtensions: ['.dsl', '.lib'], watch } as unknown as DiagramProfile;
            new WorkflowEditorProvider(context, { onDidChangeCustomDocument: undefined } as any, profile);
        } finally {
            spy.mockRestore();
        }
        return globs;
    }

    it('follows from the source extensions when `watch` carries `affects` alone', () => {
        expect(watchedBy({ affects: () => [] })).toEqual(['**/*.dsl', '**/*.lib']);
    });

    it('is the list given, and nothing for an empty list (only a save in the editor reloads)', () => {
        expect(watchedBy({ globs: ['**/tech.json'] })).toEqual(['**/tech.json']);
        expect(watchedBy({ globs: [], affects: () => [] })).toEqual([]);
    });
});
