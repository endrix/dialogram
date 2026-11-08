/**
 * The one key a source URI is known by across the host, the server and the
 * toolkit: trimmed, a `file:` URI re-spelled from its normalized path, any
 * other URI without query and fragment. A URI emitted in one shape and looked
 * up in another (pending navigation, layout targets, the execution-overlay
 * buffer) then still meets itself.
 */
import * as path from 'node:path';
import { URI } from 'vscode-uri';

export function normalizeSourceUriKey(value: string): string {
    const trimmed = value.trim();
    if (trimmed === '') {
        return trimmed;
    }
    try {
        const uri = URI.parse(trimmed);
        if (uri.scheme === 'file') {
            return URI.file(path.normalize(uri.fsPath)).toString();
        }
        return uri.with({ query: '', fragment: '' }).toString();
    } catch {
        return trimmed;
    }
}
