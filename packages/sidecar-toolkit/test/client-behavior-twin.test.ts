/**
 * `SidecarClientBehavior` is a structural twin of the platform's
 * `DiagramClientBehavior` — deliberately duplicated so the toolkit needs no
 * extension-core dependency, and passed straight through
 * (`clientBehavior: input.clientBehavior`) with no mapping step that could
 * notice a gap.
 *
 * That makes the two declarations a silent-failure pair: a field added to the
 * platform side and forgotten here is dropped from every sidecar profile with
 * no error anywhere — the feature simply never arrives in the webview.
 *
 * This compares the two declarations as SOURCE. A `type Equal<…>` assertion
 * reads better and would catch nothing: vitest strips types without checking
 * them, and `npm run typecheck` only covers `src/**`, so nothing in this
 * directory is ever typechecked. Verified by drifting the twin and watching
 * both stay green.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Field names of one interface declaration, in declaration order. */
function fieldsOf(file: string, name: string): string[] {
    const source = readFileSync(file, 'utf8');
    const start = source.indexOf(`interface ${name} {`);
    expect(start, `${name} not found in ${path.basename(file)}`).toBeGreaterThan(-1);
    const body = source.slice(source.indexOf('{', start) + 1, source.indexOf('\n}', start));
    return [...body.matchAll(/^\s*(\w+)\??\s*:/gm)].map(m => m[1]);
}

describe('sidecar client behavior mirrors the platform', () => {
    const sidecar = fieldsOf(
        path.join(here, '../src/sidecar-diagram-profile.ts'),
        'SidecarClientBehavior'
    );
    const platform = fieldsOf(
        path.join(here, '../../extension-core/src/api.ts'),
        'DiagramClientBehavior'
    );

    it('reads both declarations', () => {
        // Guards the parser itself: an empty list would make every check below
        // pass without comparing anything.
        expect(sidecar.length).toBeGreaterThan(4);
        expect(platform.length).toBeGreaterThan(4);
    });

    it('carries every field the platform declares', () => {
        expect(sidecar).toEqual(expect.arrayContaining(platform));
    });

    it('declares no field the platform does not have', () => {
        expect(platform).toEqual(expect.arrayContaining(sidecar));
    });

    it('forwards the palette icons a product contributes', () => {
        expect(sidecar).toContain('paletteIcons');
    });
});
