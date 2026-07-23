import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { resolveDiagramOpenTarget } from '../../extension-core/src/extension/diagram/open-diagram-target';

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