/**
 * The key the webview compares source URIs by: trimmed, without query and
 * fragment. The browser has no path normalisation, so this is the webview's
 * own rule; the host's is `@dialogram/diagram-server/server/uri-keys`.
 */
export function normalizeSourceUriKey(sourceUri: string): string {
    const trimmed = sourceUri.trim();
    if (trimmed === '') {
        return trimmed;
    }
    try {
        const parsed = new URL(trimmed);
        parsed.hash = '';
        parsed.search = '';
        return parsed.toString();
    } catch {
        return trimmed;
    }
}
