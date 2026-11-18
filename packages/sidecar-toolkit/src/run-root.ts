/**
 * Where a run of a source file starts: the run driver's rule, kept here so
 * that `runCli` (`cli-invocation.ts`), which a product's host code is handed
 * on its profile, starts the CLI where a run does.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
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
        // Both looked for at once, at each level; nothing is kept between
        // calls, so a `package.json` or `.git` made since is seen.
        const found = await Promise.all([
            fileExists(path.resolve(current, 'package.json')),
            fileExists(path.resolve(current, '.git'))
        ]);
        if (found.some(Boolean)) {
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
