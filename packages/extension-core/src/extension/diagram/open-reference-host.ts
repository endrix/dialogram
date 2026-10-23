/**
 * The VS Code half of opening a clicked reference (see open-reference.ts for
 * how a reference is read and resolved).
 */
import * as vscode from 'vscode';
import { parseReference, resolveReferencePath, symbolLine, type ReferenceFileSystem } from './open-reference';

const workspaceFileSystem: ReferenceFileSystem = {
    async exists(file) {
        try {
            const stat = await vscode.workspace.fs.stat(vscode.Uri.file(file));
            return (stat.type & vscode.FileType.File) !== 0;
        } catch {
            return false;
        }
    },
    async findByTrailingPath(relative) {
        const found = await vscode.workspace.findFiles(`**/${relative}`, '**/{node_modules,.git}/**', 50);
        return found.map(uri => uri.fsPath);
    },
    workspaceFolderOf(file) {
        return vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file))?.uri.fsPath;
    }
};

/** Open what `href` names: a URL in the browser, a file at its line or symbol. */
export async function openReference(href: string, baseUri: string | undefined): Promise<void> {
    const reference = parseReference(href);
    if (!reference) {
        return;
    }
    if (reference.kind === 'external') {
        await vscode.env.openExternal(vscode.Uri.parse(reference.url));
        return;
    }
    let baseFile: string | undefined;
    try {
        baseFile = baseUri ? vscode.Uri.parse(baseUri).fsPath : undefined;
    } catch {
        baseFile = undefined;
    }
    const candidates = await resolveReferencePath(reference.path, baseFile, workspaceFileSystem);
    if (candidates.length === 0) {
        void vscode.window.showWarningMessage(`Could not find ${reference.path} in the workspace.`);
        return;
    }
    let file = candidates[0];
    if (candidates.length > 1) {
        const picked = await vscode.window.showQuickPick(
            candidates.map(candidate => ({ label: vscode.workspace.asRelativePath(candidate), candidate })),
            { placeHolder: `${reference.path}: ${candidates.length} files match (closest first)` }
        );
        if (!picked) {
            return;
        }
        file = picked.candidate;
    }
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const line = reference.line ?? (reference.symbol ? symbolLine(document.getText(), reference.symbol) : undefined);
    const start = line ? Math.min(line, document.lineCount) - 1 : undefined;
    const end = reference.endLine ? Math.min(reference.endLine, document.lineCount) - 1 : start;
    await vscode.window.showTextDocument(document, {
        preview: false,
        ...(start !== undefined && end !== undefined
            ? { selection: new vscode.Range(start, 0, end, document.lineAt(end).text.length) }
            : {})
    });
}
