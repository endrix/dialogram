import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
    TEXT_DOCUMENT_LIMIT_BYTES,
    activeSourceUri,
    readRefreshCommandArgs,
    readRequestedNetworkName,
    refreshCommand,
    refreshDiagramModels,
    type RefreshHost,
    resolveDiagramOpenTarget,
    sizeOfFile,
    tabSourceUri
} from '../../extension-core/src/extension/diagram/open-diagram-target';

describe('resolveDiagramOpenTarget', () => {
    it('accepts an absolute python path outside the active editor and returns the opened file uri', async () => {
        const targetPath = '/external/project/examples/python/layer.py';
        const targetUri = vscode.Uri.file(targetPath);
        const openTextDocument = vi.fn(async (uri: vscode.Uri) => ({ uri }));

        const resolved = await resolveDiagramOpenTarget(targetPath, {
            getActiveWorkflowUri: () => undefined,
            openTextDocument,
            workspaceRoot: '/Users/endrix/git/streamblocks/workflow-ide'
        });

        expect(openTextDocument).toHaveBeenCalledTimes(1);
        expect(openTextDocument).toHaveBeenCalledWith(targetUri);
        expect(resolved?.toString()).toBe(targetUri.toString());
    });

    // VS Code does not hand a file over 50 MB to extensions as a text document:
    // `openTextDocument` rejects. A generated circuit is that large, and its
    // diagram is drawn from the file, not from a text document.
    const refusedAsText = async (): Promise<{ uri: vscode.Uri }> => {
        throw new Error('Files above 50MB cannot be synchronized with extensions.');
    };
    const sixtyFourMegabytes = 64 * 1024 * 1024;

    it('opens a file refused as text for its size', async () => {
        const targetUri = vscode.Uri.file('/designs/Top.fir');
        const fileSize = vi.fn(async () => sixtyFourMegabytes);

        const resolved = await resolveDiagramOpenTarget(targetUri, {
            getActiveWorkflowUri: () => undefined,
            openTextDocument: refusedAsText,
            fileSize,
            sourceExtensions: ['.fir']
        });

        expect(fileSize).toHaveBeenCalledWith(targetUri);
        expect(resolved?.toString()).toBe(targetUri.toString());
    });

    it('does not open a file refused as text for another reason', async () => {
        // A binary, an undecodable file: small enough to have been handed
        // over, so its size is not why it was refused, and it is not a source.
        const resolved = await resolveDiagramOpenTarget(vscode.Uri.file('/designs/Top.fir'), {
            getActiveWorkflowUri: () => undefined,
            openTextDocument: refusedAsText,
            fileSize: async () => 4096,
            sourceExtensions: ['.fir']
        });

        expect(resolved).toBeUndefined();
    });

    it('does not open a file exactly at the limit, which is handed over', async () => {
        const resolved = await resolveDiagramOpenTarget(vscode.Uri.file('/designs/Top.fir'), {
            getActiveWorkflowUri: () => undefined,
            openTextDocument: refusedAsText,
            fileSize: async () => TEXT_DOCUMENT_LIMIT_BYTES,
            sourceExtensions: ['.fir']
        });

        expect(resolved).toBeUndefined();
    });

    it('does not open what is not a file that is there', async () => {
        for (const fileSize of [async () => undefined, async () => { throw new Error('ENOENT'); }]) {
            const resolved = await resolveDiagramOpenTarget(vscode.Uri.file('/designs/Gone.fir'), {
                getActiveWorkflowUri: () => undefined,
                openTextDocument: refusedAsText,
                fileSize,
                sourceExtensions: ['.fir']
            });
            expect(resolved).toBeUndefined();
        }
    });

    it('does not open a file it cannot open as text when nothing can say how large it is', async () => {
        // A caller that gives no `fileSize` keeps the answer it had.
        const resolved = await resolveDiagramOpenTarget(vscode.Uri.file('/designs/Top.fir'), {
            getActiveWorkflowUri: () => undefined,
            openTextDocument: refusedAsText,
            sourceExtensions: ['.fir']
        });

        expect(resolved).toBeUndefined();
    });

    it('does not ask how large a file of another kind is', async () => {
        const fileSize = vi.fn(async () => sixtyFourMegabytes);

        const resolved = await resolveDiagramOpenTarget(vscode.Uri.file('/designs/notes.txt'), {
            getActiveWorkflowUri: () => undefined,
            openTextDocument: refusedAsText,
            fileSize,
            sourceExtensions: ['.fir']
        });

        expect(resolved).toBeUndefined();
        expect(fileSize).not.toHaveBeenCalled();
    });

    it('names a file refused for its size by its path, as a text document is named', async () => {
        // A caller keys an open diagram by this URI, so the file has one
        // however it was asked for.
        const asPath = await resolveDiagramOpenTarget('/designs/Top.fir', {
            getActiveWorkflowUri: () => undefined,
            openTextDocument: refusedAsText,
            fileSize: async () => sixtyFourMegabytes,
            sourceExtensions: ['.fir']
        });
        const asUri = await resolveDiagramOpenTarget('file:///designs/Top.fir', {
            getActiveWorkflowUri: () => undefined,
            openTextDocument: refusedAsText,
            fileSize: async () => sixtyFourMegabytes,
            sourceExtensions: ['.fir']
        });

        expect(asPath?.toString()).toBe(vscode.Uri.file('/designs/Top.fir').toString());
        expect(asUri?.toString()).toBe(asPath?.toString());
    });
});

describe('sizeOfFile', () => {
    it('is the size of a file, and of a link to one', () => {
        expect(sizeOfFile({ type: vscode.FileType.File, size: 12 })).toBe(12);
        expect(sizeOfFile({ type: vscode.FileType.File | vscode.FileType.SymbolicLink, size: 12 })).toBe(12);
    });

    it('is nothing for a folder, a link to one, or anything else', () => {
        // The type is a bitmask: a link to a folder is not `Directory` alone.
        expect(sizeOfFile({ type: vscode.FileType.Directory, size: 4096 })).toBeUndefined();
        expect(sizeOfFile({ type: vscode.FileType.Directory | vscode.FileType.SymbolicLink, size: 4096 })).toBeUndefined();
        expect(sizeOfFile({ type: vscode.FileType.Unknown, size: 0 })).toBeUndefined();
    });
});

describe('tabSourceUri', () => {
    const file = vscode.Uri.file('/designs/Top.fir');

    it('is the file of a text editor and of a custom editor', () => {
        expect(tabSourceUri(new vscode.TabInputText(file))).toBe(file);
        expect(tabSourceUri(new vscode.TabInputCustom(file, 'hex.editor'))).toBe(file);
    });

    it('is the side being edited, for a diff', () => {
        const original = vscode.Uri.file('/designs/Top.fir.orig');
        expect(tabSourceUri(new vscode.TabInputTextDiff(original, file))).toBe(file);
    });

    it('is nothing for a tab that shows no such file', () => {
        expect(tabSourceUri(new vscode.TabInputNotebook(file, 'jupyter-notebook'))).toBeUndefined();
        expect(tabSourceUri({ uri: file })).toBeUndefined();
        expect(tabSourceUri(undefined)).toBeUndefined();
    });
});

describe('activeSourceUri', () => {
    const isFir = (uri: vscode.Uri | undefined): boolean => !!uri && uri.fsPath.endsWith('.fir');
    const diagram = vscode.Uri.file('/designs/Shown.fir');
    const text = vscode.Uri.file('/designs/Edited.fir');
    const tab = vscode.Uri.file('/designs/Large.fir');

    it('is the active diagram\'s file before anything else', () => {
        expect(activeSourceUri({ diagramUri: diagram, textEditorUri: text, tabUri: tab }, isFir)).toBe(diagram);
    });

    it('is the active text editor\'s file when no diagram is in front', () => {
        expect(activeSourceUri({ textEditorUri: text, tabUri: tab }, isFir)).toBe(text);
    });

    it('is the active tab\'s file when VS Code reports no text editor for it', () => {
        // A file over 50 MB: on screen in a text editor extensions are not told
        // about. The command said to open a file first, to someone looking at one.
        expect(activeSourceUri({ tabUri: tab }, isFir)).toBe(tab);
    });

    it('passes over what is in front and is not one of the product\'s sources', () => {
        const notes = vscode.Uri.file('/designs/notes.txt');
        expect(activeSourceUri({ diagramUri: notes, textEditorUri: notes, tabUri: tab }, isFir)).toBe(tab);
        expect(activeSourceUri({ textEditorUri: notes, tabUri: notes }, isFir)).toBeUndefined();
    });
});
/**
 * Which graph inside the file an open request asks for.
 *
 * A source file can hold several graphs, and the platform can already show one
 * by name — but only once a diagram exists, because until now the name arrived
 * exclusively on a request the WEBVIEW originates: a drill-down, or a cross-file
 * navigation. A caller that knows the name BEFORE the editor exists had nowhere
 * to put it, which is what stopped a consumer from asking "which one?" and
 * opening at the answer.
 */
describe('readRequestedNetworkName', () => {
    it('reads the name from an object argument', () => {
        expect(readRequestedNetworkName({ sourceUri: 'file:///a.py', networkName: 'Top' })).toBe('Top');
    });

    it('is absent for the argument forms that carry no room for one', () => {
        // A bare path or URI is the common way this command is invoked, and it
        // has to keep meaning "open at the default".
        expect(readRequestedNetworkName('/a.py')).toBeUndefined();
        expect(readRequestedNetworkName(vscode.Uri.file('/a.py'))).toBeUndefined();
        expect(readRequestedNetworkName(undefined)).toBeUndefined();
    });

    it('treats an empty or blank name as no name at all', () => {
        // Otherwise a caller passing through an empty picker result would ask
        // for a graph called "", and the model source would look for one.
        expect(readRequestedNetworkName({ networkName: '' })).toBeUndefined();
        expect(readRequestedNetworkName({ networkName: '   ' })).toBeUndefined();
    });

    it('trims, so a name pasted with whitespace still resolves', () => {
        expect(readRequestedNetworkName({ networkName: '  Top  ' })).toBe('Top');
    });

    it('ignores a non-string, rather than coercing it', () => {
        // Command arguments come from anywhere — a menu contribution, a
        // keybinding, another extension — and coercing a number into a graph
        // name would search for one nobody asked for.
        expect(readRequestedNetworkName({ networkName: 42 as unknown as string })).toBeUndefined();
    });
});

describe('readRefreshCommandArgs', () => {
    it('enters the view named only on `open: true`, and is a refresh otherwise, as it was', () => {
        const file = 'file:///w/top.src';
        expect(readRefreshCommandArgs({ sourceUri: file, workflowName: 'part', open: true })).toEqual({ sourceUri: file, workflowName: 'part', open: true });
        expect(readRefreshCommandArgs({ sourceUri: file, workflowName: 'part' })).toEqual({ sourceUri: file, workflowName: 'part' });
        // Anything but `true` is no word to enter a view: a refresh.
        expect(readRefreshCommandArgs({ sourceUri: file, workflowName: 'part', open: 'yes' as unknown as boolean })).not.toHaveProperty('open');
        expect(readRefreshCommandArgs(undefined)).toEqual({ sourceUri: undefined, workflowName: undefined });
    });

    it('passes a node to reveal, and drops an empty one', () => {
        expect(readRefreshCommandArgs({ workflowName: 'part', reveal: 'n1' })).toMatchObject({ reveal: 'n1' });
        expect(readRefreshCommandArgs({ workflowName: 'part', reveal: '  ' })).not.toHaveProperty('reveal');
    });

    it('leaves out anything else a caller puts on it, a trail among them', () => {
        const file = 'file:///w/top.src';
        const args = { sourceUri: file, workflowName: 'part', open: true, trail: ['top', 'part'] } as never;
        expect(readRefreshCommandArgs(args)).toEqual({ sourceUri: file, workflowName: 'part', open: true });
    });

    it('takes a name that is not text (a row\'s data passed through) as no name', () => {
        const file = 'file:///w/top.src';
        expect(readRefreshCommandArgs({ sourceUri: file, workflowName: 42 as never, open: true })).toEqual({ sourceUri: file, workflowName: undefined, open: true });
    });
});

describe('the refresh command, as the activation registers it', () => {
    const FILE = 'file:///w/top.src';
    const OTHER = 'file:///w/other.src';

    function host(active?: string, answered = 1) {
        const asked: Array<{ uri: string; options: Record<string, unknown>; navigationThen: string[] }> = [];
        // As glsp-activation.ts `putPending` keeps a navigation: by its key and as the diagram spelled it.
        const recentNavigation = new Map<string, unknown>([
            [FILE, { networkName: 'deep' }],
            ['file:///w/./top.src', { networkName: 'deep' }],
            [OTHER, { networkName: 'elsewhere' }]
        ]);
        const made: RefreshHost = {
            activeUri: () => (active ? vscode.Uri.parse(active) : undefined),
            editors: () => ({
                refreshFromHost: (uri, options) => {
                    asked.push({ uri: uri.toString(), options, navigationThen: [...recentNavigation.keys()] });
                    return answered;
                }
            }),
            queueTraceVisible: () => true,
            recentNavigation
        };
        return { made, asked, recentNavigation };
    }

    it('enters the view: `open` reaches the editors, and a trail a caller passes does not', async () => {
        const { made, asked } = host();
        await refreshCommand(made)({ sourceUri: FILE, workflowName: 'part', open: true, trail: ['top', 'part'] } as never);
        await refreshCommand(made)({ sourceUri: FILE, workflowName: 'part' });
        expect(asked).toEqual([
            expect.objectContaining({ uri: FILE, options: expect.objectContaining({ workflowName: 'part', open: true, queueTraceVisible: true }) }),
            expect.objectContaining({ uri: FILE, options: expect.objectContaining({ workflowName: 'part', open: undefined }) })
        ]);
        expect(asked[0].options).not.toHaveProperty('trail');
        // Nor by the open commands' way in, which is not read by `readRefreshCommandArgs`.
        refreshDiagramModels({ sourceUri: FILE, workflowName: 'part', open: true, trail: ['top', 'part'] } as never, made);
        expect(asked[2].options).not.toHaveProperty('trail');
    });

    it('reads its argument as `readRefreshCommandArgs` does: anything but `open: true` is a refresh, and an empty node to reveal is none', async () => {
        const { made, asked } = host();
        await refreshCommand(made)({ sourceUri: FILE, workflowName: 'part', open: 'yes' as never, reveal: '  ' });
        expect(asked[0].options).toMatchObject({ open: undefined, reveal: undefined });
    });

    it('passes on the node to reveal and an overlay-only refresh, as the activation did before', () => {
        const { made, asked } = host();
        refreshDiagramModels({ sourceUri: FILE, workflowName: 'part', reveal: 'n1' }, made);
        refreshDiagramModels({ sourceUri: FILE, workflowName: 'top', agentContextOnly: true }, made);
        expect(asked.map(entry => entry.options)).toEqual([
            expect.objectContaining({ reveal: 'n1', agentContextOnly: undefined }),
            expect.objectContaining({ reveal: undefined, agentContextOnly: true })
        ]);
    });

    it('is of the active diagram\'s file where it names none, and asks nothing where there is none', async () => {
        const active = host(OTHER);
        await refreshCommand(active.made)(undefined);
        expect(active.asked.map(entry => entry.uri)).toEqual([OTHER]);
        const none = host();
        await refreshCommand(none.made)(undefined);
        expect(none.asked).toEqual([]);
    });

    it('forgets the diagram\'s own navigation of the moments before when it enters a view, and only the file\'s', async () => {
        const { made, recentNavigation } = host();
        await refreshCommand(made)({ sourceUri: FILE, workflowName: 'part' });
        expect(recentNavigation.size).toBe(3);
        await refreshCommand(made)({ sourceUri: FILE, workflowName: 'part', open: true });
        expect([...recentNavigation.keys()]).toEqual([OTHER]);
    });

    it('forgets it too for the open command on an editor that is open already, which enters the view the same way', () => {
        const { made, recentNavigation } = host();
        refreshDiagramModels({ sourceUri: FILE, workflowName: 'part', open: true }, made);
        expect([...recentNavigation.keys()]).toEqual([OTHER]);
    });

    it('forgets it before the editor is asked, since the entry\'s own request is remembered on top of it', () => {
        const { made, asked } = host();
        refreshDiagramModels({ sourceUri: FILE, workflowName: 'part', open: true }, made);
        expect(asked[0].navigationThen).toEqual([OTHER]);
    });

    it('keeps it where no editor was asked (the file has none of its own, or is shown inside another file\'s), since nothing was entered', async () => {
        const { made, asked, recentNavigation } = host(undefined, 0);
        const before = new Map(recentNavigation);
        await refreshCommand(made)({ sourceUri: FILE, workflowName: 'part', open: true });
        expect(asked).toHaveLength(1);
        expect(new Map(recentNavigation)).toEqual(before);
    });

    it('enters nothing and throws nothing for a name that is not text', async () => {
        const { made, asked, recentNavigation } = host();
        await expect(refreshCommand(made)({ sourceUri: FILE, workflowName: 42 as never, open: true })).resolves.toBeUndefined();
        expect(asked[0].options).toMatchObject({ workflowName: undefined, open: true });
        expect(recentNavigation.size).toBe(3);
        // Nor by the open commands' way in, which does not pass through `readRefreshCommandArgs`.
        expect(() => refreshDiagramModels({ sourceUri: FILE, workflowName: 42 as never, open: true }, made)).not.toThrow();
        expect(recentNavigation.size).toBe(3);
    });
});
