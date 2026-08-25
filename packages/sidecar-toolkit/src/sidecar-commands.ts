import * as vscode from 'vscode';
import { describeChildFailure, runChildProcess } from './run-child-process.js';

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
}

export function registerSidecarCommands(
    context: vscode.ExtensionContext,
    config: SidecarCommandsConfig
): void {
    context.subscriptions.push(
        vscode.commands.registerCommand(config.editCommandId, async () => {
            const fileUri = vscode.window.activeTextEditor?.document.uri;
            if (!fileUri || !fileUri.fsPath.endsWith(config.sourceFileExtension)) {
                void vscode.window.showWarningMessage('Open a Python workflow file to use sidecar edits.');
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
            try {
                // This command is awaited by whoever invoked it, so it must always answer:
                // before, an unstartable command raised an unhandled 'error' event and left
                // the caller's promise pending for the life of the window.
                const result = await runChildProcess(cmd, [], { input: JSON.stringify(payload) + '\n' });
                const failure = describeChildFailure(cmd, result);
                if (failure) {
                    return {
                        ok: false,
                        message: result.spawnError || result.timedOut
                            ? failure
                            : result.stderr || `${config.opNamespace}-sidecar exited with ${result.code}`
                    };
                }
                if (result.stdout.trim() !== '') {
                    try {
                        const resp = JSON.parse(result.stdout.trim());
                        return { ok: resp.status === 'ok', message: resp.message };
                    } catch {
                        return { ok: false, message: 'Invalid sidecar response' };
                    }
                }
                return { ok: true };
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return { ok: false, message: msg };
            }
        })
    );
}
