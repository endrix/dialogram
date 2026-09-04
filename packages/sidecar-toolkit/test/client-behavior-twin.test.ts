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

/**
 * Fields the PLATFORM computes and a product must never supply.
 *
 * The twin exists so a product-supplied field cannot go missing on the way to
 * the webview. A derived field is the opposite case: it reaches the webview by
 * being filled in during forwarding, and a product-facing type that declared it
 * would invite someone to set it by hand — which is the one way the two halves
 * could then disagree.
 *
 * So these are excluded from the comparison deliberately, and named here rather
 * than filtered by a pattern, because adding one is a decision worth writing
 * down.
 *
 *   chatBackend  derived from `DiagramProfile.chat` being present, which is
 *                what decides whether the host activates a chat backend at all
 */
const PLATFORM_DERIVED = ['chatBackend'];

describe('sidecar client behavior mirrors the platform', () => {
    const sidecar = fieldsOf(
        path.join(here, '../src/sidecar-diagram-profile.ts'),
        'SidecarClientBehavior'
    );
    const platform = fieldsOf(
        path.join(here, '../../extension-core/src/api.ts'),
        'DiagramClientBehavior'
    ).filter(field => !PLATFORM_DERIVED.includes(field));

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

    it('leaves the platform-derived fields out of the product-facing type', () => {
        // The exclusion above is only honest if the field is genuinely absent.
        // Declaring it here would let a product set a value the platform then
        // overwrites, which is worse than not offering it.
        for (const derived of PLATFORM_DERIVED) {
            expect(sidecar, `${derived} is computed by the platform`).not.toContain(derived);
        }
    });

    it('forwards the palette icons a product contributes', () => {
        expect(sidecar).toContain('paletteIcons');
    });
});
