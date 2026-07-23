import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { executeViewerCommand, executeViewerOpen } from '../../extension-core/src/extension/diagram/viewer-actions';

describe('viewer action dispatch', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('retries a viewer command after opening the target', async () => {
        const targetUri = vscode.Uri.parse('file:///tmp/report.html');
        vi.spyOn(vscode.commands, 'getCommands').mockResolvedValue([]);
        const executeCommand = vi.spyOn(vscode.commands, 'executeCommand');
        executeCommand
            .mockRejectedValueOnce(new Error('missing context'))
            .mockResolvedValueOnce(undefined)
            .mockResolvedValueOnce(undefined);

        await executeViewerCommand('livePreview.start.preview.atFile', targetUri, [targetUri]);

        expect(executeCommand).toHaveBeenNthCalledWith(1, 'livePreview.start.preview.atFileString', '/tmp/report.html');
        expect(executeCommand).toHaveBeenNthCalledWith(2, 'vscode.open', targetUri, {
            preview: true,
            preserveFocus: true
        });
        expect(executeCommand).toHaveBeenNthCalledWith(3, 'livePreview.start.preview.atFileString', '/tmp/report.html');
    });

    it('defaults viewer commands to the target uri when no args are provided', async () => {
        const targetUri = vscode.Uri.parse('file:///tmp/report.html');
        const executeCommand = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);

        await executeViewerCommand('livePreview.start.preview.atFile', targetUri);

        expect(executeCommand).toHaveBeenCalledTimes(1);
        expect(executeCommand).toHaveBeenCalledWith('livePreview.start.preview.atFileString', '/tmp/report.html');
    });

    it('converts uri-string command args back into vscode.Uri instances', async () => {
        const targetUri = vscode.Uri.parse('file:///tmp/report.html');
        const executeCommand = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);

        await executeViewerCommand('livePreview.start.preview.atFile', targetUri, [targetUri.toString()]);

        expect(executeCommand).toHaveBeenCalledTimes(1);
        expect(executeCommand).toHaveBeenCalledWith('livePreview.start.preview.atFileString', '/tmp/report.html');
    });

    it('routes registered commands directly instead of using openWith', async () => {
        const targetUri = vscode.Uri.parse('file:///tmp/report.html');
        vi.spyOn(vscode.commands, 'getCommands').mockResolvedValue(['livePreview.start.preview.atFile']);
        const executeCommand = vi.spyOn(vscode.commands, 'executeCommand');
        executeCommand
            .mockResolvedValueOnce(undefined);

        await executeViewerOpen(targetUri, 'livePreview.start.preview.atFile');

        expect(executeCommand).toHaveBeenCalledTimes(1);
        expect(executeCommand).toHaveBeenNthCalledWith(1, 'livePreview.start.preview.atFileString', '/tmp/report.html');
    });

    it('falls back to a command when openWith has no editor provider', async () => {
        const targetUri = vscode.Uri.parse('file:///tmp/report.html');
        vi.spyOn(vscode.commands, 'getCommands').mockResolvedValue([]);
        const executeCommand = vi.spyOn(vscode.commands, 'executeCommand');
        executeCommand
            .mockRejectedValueOnce(new Error('no custom editor'))
            .mockResolvedValueOnce(undefined);

        await executeViewerOpen(targetUri, 'livePreview.start.preview.atFile');

        expect(executeCommand).toHaveBeenNthCalledWith(1, 'vscode.openWith', targetUri, 'livePreview.start.preview.atFile');
        expect(executeCommand).toHaveBeenNthCalledWith(2, 'livePreview.start.preview.atFileString', '/tmp/report.html');
    });

    it('keeps using vscode.openWith for real editor view types', async () => {
        const targetUri = vscode.Uri.parse('file:///tmp/readme.md');
        vi.spyOn(vscode.commands, 'getCommands').mockResolvedValue([]);
        const executeCommand = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);

        await executeViewerOpen(targetUri, 'vscode.markdown.preview.editor');

        expect(executeCommand).toHaveBeenCalledTimes(1);
        expect(executeCommand).toHaveBeenCalledWith('vscode.openWith', targetUri, 'vscode.markdown.preview.editor');
    });

    it('surfaces the fallback command error when openWith also fails', async () => {
        const targetUri = vscode.Uri.parse('file:///tmp/report.html');
        vi.spyOn(vscode.commands, 'getCommands').mockResolvedValue([]);
        const executeCommand = vi.spyOn(vscode.commands, 'executeCommand');
        executeCommand
            .mockRejectedValueOnce(new Error('no custom editor'))
            .mockRejectedValueOnce(new Error('missing context'))
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error('missing context'));

        await expect(executeViewerOpen(targetUri, 'livePreview.start.preview.atFile'))
            .rejects
            .toThrow("Viewer command 'livePreview.start.preview.atFileString' failed: missing context");
    });
});