/**
 * Neutral URI-key utility owned by the host.
 *
 * The host's pending-map plumbing (transient drill-down handoff) keys on a
 * canonical URI form. This helper is vscode-dependent (it round-trips through
 * `vscode.Uri`), so it cannot live in `@dialogram/shared`; it is kept here in
 * extension-core so the host no longer reaches into the toolkit package for pure
 * plumbing. The toolkit keeps its own identical copy for its internal callers.
 */
import * as vscode from 'vscode';
import * as path from 'node:path';

/**
 * Normalize a raw URI string to a stable key. The ONE canonical source-URI key
 * for the host: the pending-map plumbing (transient drill-down handoff), the
 * editor provider's client/URI resolution (`canonicalizeUriString`), and the
 * execution-overlay replay buffer all key on this same form so a URI emitted in
 * one shape and looked up in another still resolves (Task-4 review M2).
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
