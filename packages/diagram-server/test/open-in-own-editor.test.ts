/**
 * "Open in Its Own Editor" on a nested workflow defined in another file.
 *
 * Navigating in place, a double-click shows a nested workflow inside this
 * editor. This item is the way to open its file as a root of its own instead.
 * It is offered only where that means something: a workflow instance whose
 * definition is in a different file from the one shown.
 */
import { describe, expect, it } from 'vitest';
import { WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import { WorkflowContextMenuItemProvider } from '../src/server/context-menu-item-provider';

const SHOWN = 'file:///w/top.py';

function itemsFor(args: Record<string, unknown>): any[] {
    const root: any = { id: 'root', type: 'graph', args: {} };
    const node: any = { id: 'n', type: WorkflowDiagramTypes.NODE_NETWORK, args, parent: root };
    const provider: any = new WorkflowContextMenuItemProvider();
    provider.modelState = { sourceUri: SHOWN, root, index: { find: () => node } };
    return provider.getItems(['n'], { x: 0, y: 0 });
}

const instance = (referencedUri: string) => ({
    [WorkflowDiagramMetadata.ENTITY_NAME]: 'b2',
    [WorkflowDiagramMetadata.IS_NETWORK_INSTANCE]: true,
    [WorkflowDiagramMetadata.REFERENCED_URI]: referencedUri,
    [WorkflowDiagramMetadata.REFERENCED_ENTITY_NAME]: 'layers.block.block'
});

describe('Open in Its Own Editor', () => {
    it('opens a workflow defined in another file, by its name', () => {
        const item = itemsFor(instance('file:///w/layers/block.py')).find(i => i.id === 'dialogram.openInOwnEditor');

        expect(item).toBeDefined();
        expect(item.actions).toEqual([{
            kind: 'dialogram.openInOwnEditor',
            uri: 'file:///w/layers/block.py',
            workflowName: 'block'
        }]);
    });

    it('is not offered for a workflow defined in the file shown', () => {
        const ids = itemsFor(instance(SHOWN)).map(i => i.id);
        expect(ids).not.toContain('dialogram.openInOwnEditor');
    });

    it('is not offered for a node that is not a workflow instance', () => {
        const ids = itemsFor({ ...instance('file:///w/layers/block.py'), [WorkflowDiagramMetadata.IS_NETWORK_INSTANCE]: false })
            .map(i => i.id);
        expect(ids).not.toContain('dialogram.openInOwnEditor');
    });
});
