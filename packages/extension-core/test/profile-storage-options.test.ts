/**
 * The palette-suppression flag reaches the server.
 *
 * `supportsElementCreation` sits on the profile ROOT — it says something about the
 * diagram, not about storage — but it is read on the server by the tool-palette
 * provider, which sees only the storage runtime options. This is the fold, and
 * these tests pin the part of it that is not a pass-through: a profile that
 * suppresses creation while carrying no storage options still needs something
 * bound for the flag to arrive on, and the synthesized carrier must not answer any
 * OTHER question differently from its own absence.
 */
import { describe, expect, it } from 'vitest';
import { composeStorageRuntimeOptions } from '../src/extension/diagram/profile-storage-options';

describe('composeStorageRuntimeOptions', () => {
    it("carries the profile's storage options through unchanged", () => {
        const storageOptions = {
            settingsNamespace: 'demo',
            operationPrefix: 'demo.ops',
            entityPaletteItems: [{ elementTypeId: 'node:task', label: 'Extra', description: 'x' }]
        };

        expect(composeStorageRuntimeOptions({ storageOptions })).toEqual({
            ...storageOptions,
            supportsElementCreation: undefined
        });
    });

    it('folds the suppression flag onto them', () => {
        const composed = composeStorageRuntimeOptions({
            storageOptions: { settingsNamespace: 'demo', operationPrefix: 'demo.ops' },
            supportsElementCreation: false
        });

        expect(composed?.supportsElementCreation).toBe(false);
        expect(composed?.settingsNamespace, 'the fold overwrote a value it does not own').toBe('demo');
    });

    it('synthesizes a carrier when a suppressing profile has no storage options', () => {
        // The defaults repeat what every reader of these options already applies
        // when nothing is bound (`?? ''`), so the carrier is invisible except for
        // the flag it exists to deliver.
        expect(composeStorageRuntimeOptions({ supportsElementCreation: false })).toEqual({
            settingsNamespace: '',
            operationPrefix: '',
            supportsElementCreation: false
        });
    });

    it('binds nothing for a profile that says neither', () => {
        // The control. Without it the synthesis above could be handing storage
        // options to profiles that never had any.
        expect(composeStorageRuntimeOptions({})).toBeUndefined();
        expect(composeStorageRuntimeOptions({ supportsElementCreation: true })).toBeUndefined();
    });
});
