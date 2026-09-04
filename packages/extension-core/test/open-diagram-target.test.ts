import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { readRequestedNetworkName, resolveDiagramOpenTarget } from '../../extension-core/src/extension/diagram/open-diagram-target';

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
