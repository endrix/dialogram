/**
 * A product can say its diagram creates nothing, and the palette empties.
 *
 * The palette was append-only: a profile could contribute an entry and could
 * never remove one, so a diagram that is a PROJECTION of a source artifact — its
 * graph read out of a file rather than drawn — still offered Entities, Ports and
 * Connections. None of those can do anything on such a diagram: the drop has
 * nowhere to write, so the tool is inert at best, and at worst appears to work
 * until the next reload throws the node away.
 *
 * `supportsElementCreation: false` empties it. The product's own contributions go
 * with it, deliberately: a projection has nothing of its own to create either, and
 * leaving those standing would reproduce the palette the flag exists to remove.
 */
import { describe, expect, it } from 'vitest';
import { WorkflowToolPaletteItemProvider } from '../src/server/tool-palette-provider';

/** The provider with only the options it reads; DI is not exercised here. */
function providerWith(options?: Record<string, unknown>): any {
    const provider: any = new WorkflowToolPaletteItemProvider();
    provider.storageOptions = options;
    return provider;
}

const CONTRIBUTED = {
    elementTypeId: 'node:external-task',
    label: 'Contributed',
    description: 'An entry the product added',
    icon: 'symbol-misc'
};

const baseOptions = {
    settingsNamespace: 'demo',
    operationPrefix: 'demo',
    entityPaletteItems: [CONTRIBUTED]
};

describe('a palette for a diagram that creates nothing', () => {
    it('offers no categories at all when the profile suppresses creation', async () => {
        const items = await providerWith({ ...baseOptions, supportsElementCreation: false }).getItems();

        expect(items, 'a projection was still offered creation tools').toEqual([]);
    });

    it("drops the product's own contributions too", async () => {
        const items = await providerWith({ ...baseOptions, supportsElementCreation: false }).getItems();
        const labels = items.flatMap((category: any) => (category.children ?? []).map((c: any) => c.label));

        expect(labels).not.toContain('Contributed');
    });

    it('keeps the whole palette when the profile says nothing', async () => {
        // The default, and the reason every existing consumer is untouched: the
        // flag is opt-in, so an absent one has to behave as `true`.
        const items = await providerWith(baseOptions).getItems();
        const ids = items.map((category: any) => category.id);

        expect(ids).toEqual(['palette-entities', 'palette-ports', 'palette-connections']);
        const entities = items.find((category: any) => category.id === 'palette-entities');
        expect(entities.children.map((c: any) => c.label)).toContain('Contributed');
    });

    it('keeps the whole palette when the profile says so explicitly', async () => {
        const items = await providerWith({ ...baseOptions, supportsElementCreation: true }).getItems();

        expect(items.map((category: any) => category.id))
            .toEqual(['palette-entities', 'palette-ports', 'palette-connections']);
    });

    it('keeps the whole palette when a profile carries no storage options at all', async () => {
        const items = await providerWith(undefined).getItems();

        expect(items.map((category: any) => category.id))
            .toEqual(['palette-entities', 'palette-ports', 'palette-connections']);
    });
});
