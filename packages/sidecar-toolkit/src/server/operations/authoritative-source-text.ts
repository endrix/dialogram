import { promises as fs } from 'node:fs';
import * as vscode from 'vscode';

/**
 * Read the source file's authoritative content straight from disk.
 *
 * Sidecar ops rewrite the source file out-of-band — a direct disk write the VS Code
 * text-document layer does not observe synchronously. Immediately after such a write,
 * `vscode.workspace.openTextDocument(uri).getText()` can still return the stale pre-write
 * buffer that VS Code reconciles only asynchronously. Snapshotting that stale text as a
 * `ReversibleWorkspaceEditCommand`'s `afterText` makes the later undo guard compare the
 * (reconciled) live document against a value it never actually held, so it wrongly refuses a
 * legitimate undo ("... the document changed outside the diagram").
 *
 * Reading from disk yields exactly what the sidecar wrote — i.e. what the document reconciles
 * to and what the undo guard reads — without weakening the guard comparison itself.
 */
export async function readAuthoritativeSourceText(uri: vscode.Uri): Promise<string> {
    return fs.readFile(uri.fsPath, 'utf8');
}
