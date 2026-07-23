/**
 * "Create a New <container>" command.
 *
 * Scaffolds a fresh, minimal-but-valid source file for the runtime (an empty
 * decorated function) and opens it with the associated GLSP diagram editor.
 * Fully config-driven so both extensions share one implementation — the host's
 * adapter layer supplies the product-specific label, decorator, import line and
 * source extension via {@link NewSourceFileConfig}.
 */

import * as vscode from 'vscode';

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Product-specific values that shape the scaffold and its user-facing prompts.
 * Supplied by the host's adapter layer (never hardcoded in the toolkit).
 */
export type NewSourceFileConfig = {
    /** User-facing noun for the container, e.g. `'Workflow'` / `'Network'`. */
    label: string;
    /** Decorator applied to the scaffolded function, e.g. `'workflow'`. */
    decorator: string;
    /** Import line prepended to the scaffold, e.g. `'from <runtime> import workflow'`. */
    importLine: string;
    /** Source file extension including the dot, e.g. `'.py'`. */
    sourceExtension: string;
    /**
     * Optional language noun for the identifier-validation message, e.g.
     * `'Python'`. When omitted the message reads "a valid identifier".
     */
    identifierNoun?: string;
};

function scaffold(config: NewSourceFileConfig, fnName: string): string {
    return (
        `${config.importLine}\n\n\n` +
        `@${config.decorator}\n` +
        `def ${fnName}() -> None:\n` +
        `    pass\n`
    );
}

/**
 * Resolve the directory to create the new file in. When invoked from the
 * Explorer context menu VS Code passes the right-clicked resource as the first
 * argument: use the folder itself, or the parent directory of a clicked file.
 * From the command palette (no argument) fall back to the workspace root.
 */
async function resolveTargetDir(resource: vscode.Uri | undefined): Promise<vscode.Uri | undefined> {
    if (resource) {
        try {
            const stat = await vscode.workspace.fs.stat(resource);
            return stat.type === vscode.FileType.Directory
                ? resource
                : vscode.Uri.joinPath(resource, '..'); // a file → its containing folder
        } catch {
            // fall through to the workspace root
        }
    }
    return vscode.workspace.workspaceFolders?.[0]?.uri;
}

/**
 * Register the profile's "create new container" command: pick a target file,
 * write the scaffold, and open it in the diagram editor.
 */
export function registerNewSourceFileCommand(
    context: vscode.ExtensionContext,
    commandId: string,
    customEditorViewType: string,
    config: NewSourceFileConfig
): void {
    const ext = config.sourceExtension;
    const identifierNounPrefix = config.identifierNoun ? `${config.identifierNoun} ` : '';
    context.subscriptions.push(
        vscode.commands.registerCommand(commandId, async (resource?: vscode.Uri) => {
            const targetDir = await resolveTargetDir(resource);
            if (!targetDir) {
                vscode.window.showErrorMessage(`Open a folder before creating a ${config.label}.`);
                return;
            }

            // VS Code quick-input (no native file dialog). The name is both the file
            // stem and the decorated function name, so it must be a valid identifier
            // and not already exist.
            const name = await vscode.window.showInputBox({
                title: `Create a New ${config.label}`,
                prompt: `Name for the new ${config.label.toLowerCase()} (creates <name>${ext})`,
                value: `new_${config.decorator}`,
                validateInput: async (raw) => {
                    const v = raw.trim();
                    if (!v) return 'Enter a name.';
                    if (!IDENTIFIER.test(v)) return `Must be a valid ${identifierNounPrefix}identifier (letters, digits, underscore; no leading digit).`;
                    try {
                        await vscode.workspace.fs.stat(vscode.Uri.joinPath(targetDir, `${v}${ext}`));
                        return `A file "${v}${ext}" already exists.`;
                    } catch {
                        return undefined;
                    }
                },
            });
            if (!name) {
                return;
            }

            const fnName = name.trim();
            const target = vscode.Uri.joinPath(targetDir, `${fnName}${ext}`);
            try {
                await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(scaffold(config, fnName)));
            } catch (err) {
                vscode.window.showErrorMessage(
                    `Failed to create ${config.label}: ${err instanceof Error ? err.message : String(err)}`
                );
                return;
            }

            // Open with the associated diagram editor (falls back to the text editor
            // if the custom editor can't handle it).
            try {
                await vscode.commands.executeCommand('vscode.openWith', target, customEditorViewType);
            } catch {
                await vscode.window.showTextDocument(target);
            }
        })
    );
}
