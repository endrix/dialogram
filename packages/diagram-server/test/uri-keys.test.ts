/**
 * The one key a source URI is known by across the host, the server and the
 * toolkit. The table is the one the former parity test compared two copies on.
 */
import { describe, expect, it } from 'vitest';
import { normalizeSourceUriKey } from '../src/server/uri-keys';

describe('normalizeSourceUriKey', () => {
    it('re-spells a file URI from its normalized path and strips query and fragment elsewhere', () => {
        expect(normalizeSourceUriKey('file:///tmp/workspace/model.py')).toBe('file:///tmp/workspace/model.py');
        expect(normalizeSourceUriKey('file:///tmp/workspace/sub/../model.py')).toBe('file:///tmp/workspace/model.py');
        expect(normalizeSourceUriKey('file:///tmp/workspace/pkg/')).toBe('file:///tmp/workspace/pkg');
        expect(normalizeSourceUriKey(' file:///tmp/work%20space/a%20b.py ')).toBe('file:///tmp/work%20space/a%20b.py');
        expect(normalizeSourceUriKey('https://example.test/path?query=1#frag')).toBe('https://example.test/path');
        expect(normalizeSourceUriKey('vscode-notebook-cell:/tmp/nb.ipynb#ch0000000')).toBe('vscode-notebook-cell:/tmp/nb.ipynb');
    });

    it('is idempotent, and blank stays blank', () => {
        // A scheme-less value parses as a path (`file:///not%20a%20uri...`); the key of that key is itself.
        for (const uri of ['file:///tmp/workspace/model.py', 'untitled:Untitled-1', 'https://example.test/path?query=1#frag', 'not a uri at all', '']) {
            const once = normalizeSourceUriKey(uri);
            expect(normalizeSourceUriKey(once)).toBe(once);
        }
        expect(normalizeSourceUriKey('   ')).toBe('');
    });
});
