// `normalizeSourceUriKey` exists in two deliberate copies: extension-core owns a host-local copy
// (packages/extension-core/src/extension/diagram/uri-keys.ts) so the host no longer reaches into
// the toolkit for pure pending-map plumbing, and the toolkit keeps its own copy for its internal
// navigation callers. The gate/severance constraints forbid core depending on the toolkit, so the
// two cannot share one module. This parity test locks the copies in lockstep: if one drifts, it
// fails. It lives in the TOOLKIT test dir because the toolkit may import extension-core (not the
// reverse), and both copies resolve the same `vscode` mock here, making the comparison exact.
import { describe, expect, it } from 'vitest';
import { normalizeSourceUriKey as coreNormalizeSourceUriKey } from '../../extension-core/src/extension/diagram/uri-keys';
import { normalizeSourceUriKey as toolkitNormalizeSourceUriKey } from '../src/uri-keys';

// Representative URIs exercising the branches that matter: plain file, windows-drive path,
// unnormalized (`..`) segments, percent-encoded characters, non-file schemes, and a malformed
// value that trips the try/catch fallback.
const URI_TABLE: string[] = [
    'file:///tmp/workspace/model.py',
    'file:///c:/Users/dev/Project/model.py',
    'file:///tmp/workspace/sub/../model.py',
    'file:///tmp/work%20space/a%20b.py',
    'untitled:Untitled-1',
    'vscode-notebook-cell:/tmp/nb.ipynb#ch0000000',
    'https://example.test/path?query=1#frag',
    'not a uri at all'
];

describe('normalizeSourceUriKey parity between extension-core and sidecar-toolkit copies', () => {
    it('produces identical output for every representative URI', () => {
        for (const uri of URI_TABLE) {
            expect(toolkitNormalizeSourceUriKey(uri)).toBe(coreNormalizeSourceUriKey(uri));
        }
    });

    it('is stable (idempotent) across both copies', () => {
        for (const uri of URI_TABLE) {
            const coreOnce = coreNormalizeSourceUriKey(uri);
            const toolkitOnce = toolkitNormalizeSourceUriKey(uri);
            expect(coreNormalizeSourceUriKey(coreOnce)).toBe(coreOnce);
            expect(toolkitNormalizeSourceUriKey(toolkitOnce)).toBe(toolkitOnce);
        }
    });
});
