/**
 * Where a run of a source file starts: the one rule for the working
 * directory of every start of a product's CLI the toolkit makes (a run,
 * `runCli` in `cli-invocation.ts`, the `cli-plan` graph export and the chat's
 * graph from it, a status source's reports), so they all agree on the folder.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

/**
 * The directory a run of `file` (a Uri, or an absolute path) starts in: the
 * workspace folder that holds the file, as VS Code names it, the innermost
 * one where folders are inside one another; the file's own directory when no
 * workspace folder holds it, or no folder is open. Never above the workspace
 * folder: a `.git` or a `package.json` above it (a home directory kept in
 * git, one planted in `/tmp`) does not move a run, and neither does one
 * between the file and its folder.
 *
 * A file named by the path a symbolic link leads to is in the folder opened
 * through that link: VS Code matches the file by the path it is named by, so
 * when it says the file is in no folder, the folders and the file are
 * compared once more with their links followed.
 */
export async function resolveRunRoot(file: vscode.Uri | string): Promise<string> {
    const forUri = typeof file === 'string' ? vscode.Uri.file(file) : file;
    const folder = vscode.workspace.getWorkspaceFolder(forUri) ?? (await folderThroughLinks(forUri));
    return folder ? folder.uri.fsPath : path.dirname(forUri.fsPath);
}

/**
 * The innermost open workspace folder that holds `forUri` once every link on
 * both paths is followed; undefined when none does, or when the file's
 * directory cannot be resolved (it is gone, or not on this disk).
 */
async function folderThroughLinks(forUri: vscode.Uri): Promise<vscode.WorkspaceFolder | undefined> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0 || forUri.scheme !== 'file') {
        return undefined;
    }
    const fileDir = await realDirectory(path.dirname(forUri.fsPath));
    if (!fileDir) {
        return undefined;
    }
    let best: { folder: vscode.WorkspaceFolder; real: string } | undefined;
    for (const folder of folders) {
        if (folder.uri.scheme !== 'file') {
            continue;
        }
        const real = await realDirectory(folder.uri.fsPath);
        if (real && isInside(fileDir, real) && (!best || real.length > best.real.length)) {
            best = { folder, real };
        }
    }
    return best?.folder;
}

async function realDirectory(dir: string): Promise<string | undefined> {
    try {
        return await fs.realpath(dir);
    } catch {
        return undefined;
    }
}

/** Whether `dir` is `folder` or inside it, both resolved; by whole names, so `/work-other` is not in `/work`. */
function isInside(dir: string, folder: string): boolean {
    const relative = path.relative(folder, dir);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
