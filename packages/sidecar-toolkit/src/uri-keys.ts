/**
 * Neutral URI-key utility. Extracted from `python-navigation.ts` (SP2c-2 Task 5)
 * so the host can canonicalize source URIs without depending on the Python
 * navigation engine. `python-navigation.ts` re-exports it for compat.
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
