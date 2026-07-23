import * as vscode from 'vscode';

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
                const cp = await import('node:child_process');
                const child = cp.spawn(cmd, [], { stdio: ['pipe', 'pipe', 'pipe'] });
                const input = JSON.stringify(payload) + '\n';
                child.stdin.write(input);
                child.stdin.end();
                let stdout = '';
                let stderr = '';
                child.stdout.on('data', d => (stdout += d.toString()));
                child.stderr.on('data', d => (stderr += d.toString()));
                const code: number = await new Promise(resolve => {
                    child.on('close', c => resolve(c ?? 1));
                });
                if (code !== 0) {
                    return { ok: false, message: stderr || `${config.opNamespace}-sidecar exited with ${code}` };
                }
                if (stdout.trim() !== '') {
                    try {
                        const resp = JSON.parse(stdout.trim());
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
