/**
 * A view the producer marks read-only offers nothing that would write.
 *
 * `supportsElementCreation: false` empties the palette for every diagram of a
 * profile. A producer whose files are mostly editable can also draw some it
 * only reads (a projection of another syntax, a project overview), and one
 * editor passes between both kinds in place. `graph.meta.readOnly` marks such
 * a view: the root carries `wf:readOnlyView`, the client hides the palette's
 * tools while it is shown, and the context menu loses its editing items, while
 * reading, navigating and laying out stay.
 */
import { describe, expect, it } from 'vitest';
import { WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import { GraphGModelSource, type PyGraphDocument } from '../src/model/graph-gmodel-source';
import { WorkflowToolPaletteItemProvider } from '../src/server/tool-palette-provider';
import { WorkflowContextMenuItemProvider } from '../src/server/context-menu-item-provider';

function doc(meta?: Record<string, unknown>): PyGraphDocument {
    return {
        version: '1',
        graph: {
            id: 'root',
            meta,
            nodes: [{ id: 'node:a', kind: 'task', label: 'a', scope: 'root', ports: [] }],
            edges: []
        }
    } as PyGraphDocument;
}

const rootArgs = (meta?: Record<string, unknown>): Record<string, unknown> | undefined =>
    new GraphGModelSource({} as any).transform(doc(meta)).graph.args as Record<string, unknown> | undefined;

function palette(root: unknown): any {
    const provider: any = new WorkflowToolPaletteItemProvider();
    provider.storageOptions = { settingsNamespace: 'demo', operationPrefix: 'demo' };
    provider.modelState = { root };
    return provider;
}

function menu(root: any, node: any): any {
    const provider: any = new WorkflowContextMenuItemProvider();
    provider.modelState = { sourceUri: 'file:///w/a.txt', root, index: { find: () => node } };
    return provider;
}

describe('a view the producer marks read-only', () => {
    it('carries the mark on its root, and only when the producer says so', () => {
        expect(rootArgs({ readOnly: true })?.[WorkflowDiagramMetadata.READ_ONLY_VIEW]).toBe(true);
        expect(rootArgs({ readOnly: false })?.[WorkflowDiagramMetadata.READ_ONLY_VIEW]).toBeUndefined();
        expect(rootArgs()?.[WorkflowDiagramMetadata.READ_ONLY_VIEW]).toBeUndefined();
    });

    it('still gets the palette items, which the client hides: the palette asks once per editor', async () => {
        // An editor that opens on a read-only view and navigates in place to an
        // editable one has only the items it was given at startup.
        const readOnly = { id: 'root', args: { [WorkflowDiagramMetadata.READ_ONLY_VIEW]: true } };
        const editable = { id: 'root', args: {} };
        const ids = async (root: unknown) => (await palette(root).getItems()).map((category: any) => category.id);
        expect(await ids(readOnly)).toEqual(['palette-entities', 'palette-ports', 'palette-connections']);
        expect(await ids(readOnly)).toEqual(await ids(editable));
    });

    it('keeps reading and navigating items in the context menu, not editing ones', () => {
        const node = (root: any): any => ({
            id: 'n', type: WorkflowDiagramTypes.NODE_ACTOR, parent: root,
            args: {
                [WorkflowDiagramMetadata.ENTITY_NAME]: 'a',
                [WorkflowDiagramMetadata.ENTITY_DEFINITION_PARAMETERS]: [{ name: 'width', value: '4' }]
            }
        });
        const ids = (args: Record<string, unknown>): string[] => {
            const root: any = { id: 'root', type: 'graph', args };
            return menu(root, node(root)).getItems(['n'], { x: 0, y: 0 }).map((item: any) => item.id);
        };
        const editable = ids({});
        expect(editable).toEqual(expect.arrayContaining(['dialogram.renameEntity', 'dialogram.duplicate', 'dialogram.editParameters']));
        const readOnly = ids({ [WorkflowDiagramMetadata.READ_ONLY_VIEW]: true });
        for (const editing of ['dialogram.renameEntity', 'dialogram.duplicate', 'dialogram.editParameters']) {
            expect(readOnly, `${editing} offered on a read-only view`).not.toContain(editing);
        }
        // What does not write stays.
        expect(readOnly).toEqual(editable.filter(id => !['dialogram.renameEntity', 'dialogram.duplicate', 'dialogram.editParameters'].includes(id)));
    });
});
