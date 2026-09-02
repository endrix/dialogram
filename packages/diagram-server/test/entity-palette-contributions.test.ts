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

    it('keeps the platform’s own entries', async () => {
        const entities = await entitiesOf(providerWith({
            settingsNamespace: 'wfpy',
            operationPrefix: 'wfpy',
            entityPaletteItems: [{
                elementTypeId: 'node:task', label: 'Extra', description: 'x'
            }]
        }));
        const labels = entities.map((i: any) => i.label);

        expect(labels).toContain('Task');
        expect(labels).toContain('Workflow');
        expect(labels).toContain('Extra');
    });

    it('contributes nothing when a profile says nothing', async () => {
        // The control: without this the first assertion could pass on a palette
        // that always contained the entry.
        const entities = await entitiesOf(providerWith({
            settingsNamespace: 'wfpy',
            operationPrefix: 'wfpy'
        }));

        expect(entities.map((i: any) => i.label)).not.toContain('StreamBlocks');
        expect(entities.length).toBeGreaterThan(0);
    });
});
