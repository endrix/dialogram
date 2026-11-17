import * as vscode from 'vscode';
import { openColumnFor, openWithArguments } from './open-in-place';

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
        // In the active group, as it was: the command acts on the active editor.
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

/**
 * Show a folder in the explorer.
 *
 * A directory has no editor to open in, so every other route here fails on one:
 * `vscode.open` wants a document and `openWith` wants an editor registered for
 * the type. Revealing is the operation a folder actually has.
 */
export async function executeViewerReveal(targetUri: vscode.Uri): Promise<void> {
    await vscode.commands.executeCommand('revealInExplorer', targetUri);
}

/**
 * The editors and commands the installed extensions declare (built-in ones
 * included); `undefined` where the host cannot say. A command of an extension
 * not yet active is declared but not registered, so declarations, not the
 * command registry, say what a name could open.
 */
function declaredOpeners(): { editors: Set<string>; commands: Set<string> } | undefined {
    const all = (vscode.extensions as { all?: readonly vscode.Extension<unknown>[] } | undefined)?.all;
    if (!Array.isArray(all)) {
        return undefined;
    }
    const editors = new Set<string>(['default']);
    const commands = new Set<string>();
    for (const extension of all) {
        const contributes = ((extension.packageJSON ?? {}) as { contributes?: Record<string, unknown> }).contributes ?? {};
        const list = (key: string): Array<Record<string, unknown>> => (Array.isArray(contributes[key]) ? contributes[key] as Array<Record<string, unknown>> : []);
        for (const editor of list('customEditors')) {
            if (typeof editor?.viewType === 'string') editors.add(editor.viewType);
        }
        for (const notebook of list('notebooks')) {
            if (typeof notebook?.type === 'string') editors.add(notebook.type);
        }
        for (const command of list('commands')) {
            if (typeof command?.command === 'string') commands.add(command.command);
        }
    }
    return { editors, commands };
}

export async function executeViewerOpen(targetUri: vscode.Uri, viewType: unknown): Promise<void> {
    if (typeof viewType !== 'string' || viewType === '' || viewType === 'default') {
        const column = openColumnFor(targetUri, { default: true });
        await vscode.commands.executeCommand('vscode.open', ...(column === undefined ? [targetUri] : [targetUri, { viewColumn: column }]));
        return;
    }

    const commands = await vscode.commands.getCommands(true);
    if (commands.includes(viewType)) {
        await executeViewerCommand(viewType, targetUri, [targetUri]);
        return;
    }

    // An editor nothing installed provides: `openWith` would open the default
    // editor without a word, and the viewer would look broken for no reason.
    const declared = declaredOpeners();
    if (declared && !declared.editors.has(viewType) && !declared.commands.has(viewType)) {
        void vscode.window.showWarningMessage(
            `No installed extension provides the editor '${viewType}' this viewer names, so the file opens in the default editor. `
            + 'Ask the chat which editors can open it (list_viewer_editors), or use "Reopen Editor With…".'
        );
        const column = openColumnFor(targetUri, { default: true });
        await vscode.commands.executeCommand('vscode.open', ...(column === undefined ? [targetUri] : [targetUri, { viewColumn: column }]));
        return;
    }

    try {
        await vscode.commands.executeCommand('vscode.openWith', ...openWithArguments(targetUri, viewType));
        return;
    } catch {
        await executeViewerCommand(viewType, targetUri, [targetUri]);
    }
}