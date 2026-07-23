import * as vscode from 'vscode';

const LIVE_PREVIEW_AT_FILE_COMMAND = 'livePreview.start.preview.atFile';
const LIVE_PREVIEW_AT_FILE_STRING_COMMAND = 'livePreview.start.preview.atFileString';

function getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }

    return String(error ?? 'unknown error');
}

function normalizeViewerCommandArgs(
    command: string,
    commandArgs: readonly unknown[],
    targetUri: vscode.Uri
): { command: string; args: readonly unknown[] } {
    if (commandArgs.length === 0) {
        if (command === LIVE_PREVIEW_AT_FILE_COMMAND && targetUri.scheme === 'file') {
            return {
                command: LIVE_PREVIEW_AT_FILE_STRING_COMMAND,
                args: [targetUri.fsPath]
            };
        }

        return { command, args: [targetUri] };
    }

    const targetUriText = targetUri.toString();
    const normalizedArgs = commandArgs.map(arg => {
        if (typeof arg === 'string' && arg === targetUriText) {
            return targetUri;
        }
        return arg;
    });

    if (
        command === LIVE_PREVIEW_AT_FILE_COMMAND
        && normalizedArgs.length === 1
        && normalizedArgs[0] instanceof vscode.Uri
        && normalizedArgs[0].scheme === 'file'
    ) {
        return {
            command: LIVE_PREVIEW_AT_FILE_STRING_COMMAND,
            args: [normalizedArgs[0].fsPath]
        };
    }

    return { command, args: normalizedArgs };
}

export async function executeViewerCommand(
    command: string,
    targetUri: vscode.Uri,
    commandArgs: readonly unknown[] = []
): Promise<void> {
    const normalizedInvocation = normalizeViewerCommandArgs(command, commandArgs, targetUri);
    const normalizedCommand = normalizedInvocation.command;
    const normalizedArgs = normalizedInvocation.args;

    try {
        await vscode.commands.executeCommand(normalizedCommand, ...normalizedArgs);
        return;
    } catch {
        // Continue into the retry path below.
    }

    try {
        await vscode.commands.executeCommand('vscode.open', targetUri, {
            preview: true,
            preserveFocus: true
        });
    } catch {
        // Ignore pre-open failures; the command retry may still succeed.
    }

    try {
        await vscode.commands.executeCommand(normalizedCommand, ...normalizedArgs);
        return;
    } catch (errorWithArgs) {
        throw new Error(`Viewer command '${normalizedCommand}' failed: ${getErrorMessage(errorWithArgs)}`);
    }
}

export async function executeViewerOpen(targetUri: vscode.Uri, viewType: unknown): Promise<void> {
    if (typeof viewType !== 'string' || viewType === '' || viewType === 'default') {
        await vscode.commands.executeCommand('vscode.open', targetUri);
        return;
    }

    const commands = await vscode.commands.getCommands(true);
    if (commands.includes(viewType)) {
        await executeViewerCommand(viewType, targetUri, [targetUri]);
        return;
    }

    try {
        await vscode.commands.executeCommand('vscode.openWith', targetUri, viewType);
        return;
    } catch {
        await executeViewerCommand(viewType, targetUri, [targetUri]);
    }
}