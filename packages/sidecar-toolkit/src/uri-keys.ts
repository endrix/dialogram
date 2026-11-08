/**
 * Neutral URI-key utility: canonicalizes source URIs without depending on the
 * Python navigation engine.
 */
import * as vscode from 'vscode';
import * as path from 'node:path';

/**
 * Normalize a raw URI string to a stable key. Used by the host's pending-map
 * plumbing, which keys transient drill-down handoff on this canonical form, and
 * by the navigation engine's workspace lookup.
 */
export function normalizeSourceUriKey(value: string): string {
    try {
        const uri = vscode.Uri.parse(value);
        if (uri.scheme === 'file') {
            return vscode.Uri.file(path.normalize(uri.fsPath)).toString();
        }
        return uri.with({ query: '', fragment: '' }).toString();
    } catch {
        return value;
    }
}
