/**
 * A product adds its own palette entry without the platform naming it.
 *
 * The Entities palette was two hardcoded lists, selected by a boolean. A
 * product could not add to it without editing that file — which is how a
 * neutral platform ends up learning every product's vocabulary, and exactly the
 * shape that had to be undone for the node kind itself.
 *
 * A profile now describes an entry as plain data and the platform builds it.
 */
import { describe, expect, it } from 'vitest';
import { WorkflowToolPaletteItemProvider } from '../src/server/tool-palette-provider';

/** The provider with only the options it reads; DI is not exercised here. */
function providerWith(options?: Record<string, unknown>): any {
    const provider: any = new WorkflowToolPaletteItemProvider();
    provider.storageOptions = options;
    return provider;
}

const entitiesOf = async (provider: any): Promise<any[]> => {
    const items = await provider.getItems();
    return items.find((i: any) => i.id === 'palette-entities')?.children ?? [];
};

describe('entity palette contributions', () => {
    it('adds what the profile contributes', async () => {
        const entities = await entitiesOf(providerWith({
            settingsNamespace: 'wfpy',
            operationPrefix: 'wfpy',
            entityPaletteItems: [{
                elementTypeId: 'node:external-task',
                label: 'StreamBlocks',
                description: 'A node standing for a dataflow design',
                icon: 'circuit-board',
                args: { streamblocksNode: true }
            }]
        }));

        const contributed = entities.find((i: any) => i.label === 'StreamBlocks');
        expect(contributed, 'the contributed entry never reached the palette').toBeDefined();
        expect(contributed.actions[0].elementTypeId).toBe('node:external-task');
        // The args are what let the create handler tell the variant apart.
        expect(contributed.actions[0].args).toEqual({ streamblocksNode: true });
    });

    it('offers the product’s entries alone when it says the platform’s are not its kinds', async () => {
        const entities = await entitiesOf(providerWith({
            settingsNamespace: 'hw',
            operationPrefix: 'hw',
            useAlternateEntityPalette: true,
            platformEntityItems: false,
            entityPaletteItems: [{ elementTypeId: 'node:actor', label: 'Module Instance', description: 'x' }]
        }));
        expect(entities.map((i: any) => i.label)).toEqual(['Module Instance']);
        // Ports and connections are still the platform's to offer; with no rows there is no Entities header.
        const items = await providerWith({ settingsNamespace: 'hw', operationPrefix: 'hw', platformEntityItems: false }).getItems();
        expect(items.map((i: any) => i.id)).toEqual(['palette-ports', 'palette-connections']);
    });

    it('names no kind of its own: the Entities are the product\'s, in its order', async () => {
        const entities = await entitiesOf(providerWith({
            settingsNamespace: 'wfpy',
            operationPrefix: 'wfpy',
            entityPaletteItems: [
                { elementTypeId: 'node:actor', label: 'Task', description: 'x', icon: 'symbol-class' },
                { elementTypeId: 'node:network', label: 'Workflow', description: 'y' }
            ]
        }));
        expect(entities.map((i: any) => [i.id, i.label, i.icon, i.actions[0].elementTypeId])).toEqual([
            ['palette-item-0', 'Task', 'symbol-class', 'node:actor'],
            ['palette-item-1', 'Workflow', undefined, 'node:network']
        ]);
    });

    it('offers no Entities category when a profile declares no rows, and ignores the retired flags', async () => {
        // The control: without this the first assertion could pass on a palette
        // that always contained the entry.
        for (const options of [
            { settingsNamespace: 'wfpy', operationPrefix: 'wfpy' },
            { settingsNamespace: 'calpy', operationPrefix: 'calpy', useAlternateEntityPalette: true },
            { settingsNamespace: 'x', operationPrefix: 'x', platformEntityItems: true }
        ]) {
            const items = await providerWith(options).getItems();
            expect(items.map((i: any) => i.id)).toEqual(['palette-ports', 'palette-connections']);
        }
    });
});
