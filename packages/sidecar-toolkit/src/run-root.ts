/**
 * Where a run of a source file starts, and with which command: the run
 * driver's rules, also handed to a product's host code (the profile's
 * `externalTool`), so that what the product asks the CLI is asked where a run
 * would ask it.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getCliInvocation, type CliCommandConfig } from './server/sidecar-runtime-config';
import { fileExists } from './server/source-files';

/**
 * The directory a run of `forUri` starts in: from the file's workspace folder
 * (the first one when it is in none, the file's own directory without any),
 * the nearest directory holding a `package.json` or a `.git`; that folder when
 * none does.
 */
export async function resolveRunRoot(forUri: vscode.Uri): Promise<string> {
    const wsFolder = vscode.workspace.getWorkspaceFolder(forUri) ?? vscode.workspace.workspaceFolders?.[0];
    const base = wsFolder ? wsFolder.uri.fsPath : path.dirname(forUri.fsPath);
    return (await findProjectRoot(base)) ?? base;
}

async function findProjectRoot(startDir: string): Promise<string | undefined> {
    let current = startDir;
    for (;;) {
        const pkg = path.resolve(current, 'package.json');
        const gitDir = path.resolve(current, '.git');
        if (await fileExists(pkg) || await fileExists(gitDir)) {
            return current;
        }
        const parent = path.dirname(current);
        if (parent === current) {
            break;
        }
        current = parent;
    }
    return undefined;
}

/**
 * The CLI as a run of `forUri` starts it: the one rule for the command
 * (`getCliInvocation`: the setting under the product's namespace scoped to
 * the file, its default when blank, `-m <module>` when the command is a
 * Python interpreter), the module form for a Python source only, from the
 * run root. Undefined when the setting names no command.
 */
export async function resolveCliInvocation(
    config: CliCommandConfig,
    forUri: vscode.Uri,
    isPython: boolean = forUri.fsPath.endsWith('.py')
): Promise<{ cmd: string; argsPrefix: string[]; cwd: string } | undefined> {
    const cwd = await resolveRunRoot(forUri);
    const { cmd, argsPrefix } = getCliInvocation(config, vscode, forUri);
    if (cmd.trim() === '') {
        return undefined;
    }
    return { cmd, argsPrefix: isPython ? argsPrefix : [], cwd };
}
