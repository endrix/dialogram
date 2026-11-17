import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
    TEXT_DOCUMENT_LIMIT_BYTES,
    activeSourceUri,
    readRequestedNetworkName,
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
