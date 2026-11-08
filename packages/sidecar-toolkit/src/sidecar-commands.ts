import * as vscode from 'vscode';
import { invokeSidecar } from './sidecar-transport.js';

/**
 * Config for the raw sidecar edit/send commands. Product values (command ids,
 * op namespace, settings keys, the source-file extension) are supplied by the
 * caller — the toolkit carries no product literal and no extension-core type.
 */
export interface SidecarCommandsConfig {
    /** Command id for the interactive "run a sidecar op" command. */
    editCommandId: string;
    /** Command id for the low-level "send this payload to the sidecar" command. */
    sendCommandId: string;
    /** Namespace used in prompts, the op default and error labels (the product key). */
    opNamespace: string;
    settingsNamespace: string;
    sidecarCommandSettingKey: string;
    sidecarCommandDefault: string;
    /** Extension a file must have for the edit command to operate on it (e.g. '.py'). */
    sourceFileExtension: string;
    /** Every accepted extension, for a language with several; `sourceFileExtension` alone when absent. */
    sourceFileExtensions?: string[];
}

function isSourceFile(fsPath: string, config: SidecarCommandsConfig): boolean {
    const extensions = config.sourceFileExtensions && config.sourceFileExtensions.length > 0
        ? config.sourceFileExtensions
        : [config.sourceFileExtension];
    const lower = fsPath.toLowerCase();
    return extensions.some(ext => lower.endsWith(ext.toLowerCase()));
}

export function registerSidecarCommands(
    context: vscode.ExtensionContext,
    config: SidecarCommandsConfig
): void {
    context.subscriptions.push(
        vscode.commands.registerCommand(config.editCommandId, async () => {
            const fileUri = vscode.window.activeTextEditor?.document.uri;
            if (!fileUri || !isSourceFile(fileUri.fsPath, config)) {
                void vscode.window.showWarningMessage(
                    `Open a ${config.sourceFileExtensions?.join(' / ') ?? config.sourceFileExtension} source file to use sidecar edits.`
                );
                return;
            }
            const op = await vscode.window.showInputBox({
                prompt: `${config.opNamespace} sidecar op (for example: ${config.opNamespace}.createNode)`,
                value: `${config.opNamespace}.createNode`
            });
            if (!op) return;
            const argsText = await vscode.window.showInputBox({
                prompt: 'JSON args payload',
                value: '{"workflow": "MyWorkflow", "type": "TaskA", "name": "a1"}'
            });
            if (!argsText) return;
            let args: any;
            try {
                args = JSON.parse(argsText);
            } catch (err) {
                void vscode.window.showErrorMessage('Invalid JSON args.');
                return;
            }
            const payload = {
                file: fileUri.fsPath,
                op,
                args
            };
            const result = await vscode.commands.executeCommand(config.sendCommandId, payload);
            if (result && (result as any).ok === false) {
                void vscode.window.showErrorMessage((result as any).message ?? `${config.opNamespace} sidecar failed`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(config.sendCommandId, async (payload: any) => {
            const cmd = vscode.workspace
                .getConfiguration(config.settingsNamespace)
                .get<string>(config.sidecarCommandSettingKey, config.sidecarCommandDefault);
            // Awaited by whoever invoked it, so it always answers: the transport turns a
            // command that cannot start into a message, not a pending promise.
            const result = await invokeSidecar({
                command: cmd,
                file: String(payload?.file ?? ''),
                op: String(payload?.op ?? ''),
                args: (payload?.args && typeof payload.args === 'object' ? payload.args : {}) as Record<string, unknown>
            });
            return { ok: result.ok, message: result.message ?? result.response?.message };
        })
    );
}
