/**
 * The background menu's layouts sit in one "Layout" submenu: Default Layout
 * (the product's own) first, then the ones a reader may try instead. A
 * read-only view keeps it: laying out writes nothing to the source.
 */
import { describe, expect, it } from 'vitest';
import { WorkflowDiagramMetadata } from '@dialogram/shared';
import { LAYOUT_MENU_ID, WorkflowContextMenuItemProvider } from '../src/server/context-menu-item-provider';

function backgroundMenu(args: Record<string, unknown> = {}): any[] {
    const root: any = { id: 'root', type: 'graph', args };
    const provider: any = new WorkflowContextMenuItemProvider();
    provider.modelState = { sourceUri: 'file:///w/top.py', root, index: { find: () => undefined } };
    return provider.getItems([], { x: 0, y: 0 });
}

describe('the Layout submenu', () => {
    it('holds every layout, Default Layout first, and nothing else offers one', () => {
        const items = backgroundMenu();
        const layout = items.find(item => item.id === LAYOUT_MENU_ID);

        expect(layout).toMatchObject({ label: 'Layout', group: 'layout' });
        expect(layout.actions ?? []).toEqual([]);
        expect(layout.children.map((child: any) => [child.id, child.label])).toEqual([
            ['dialogram.layoutDiagramBoundaryFlow', 'Default Layout'],
            ['dialogram.layoutDiagram', 'Compact Layout'],
            ['dialogram.layoutDiagramSerpentineMesh', 'Serpentine Mesh Layout'],
            ['dialogram.layoutDiagramUntangled', 'Untangled Layout'],
            ['dialogram.layoutDiagramFreePorts', 'Free Ports Layout']
        ]);
        for (const child of layout.children) {
            expect(child.actions).toHaveLength(1);
        }
        expect(items.filter(item => item.group === 'layout').map(item => item.id)).toEqual([LAYOUT_MENU_ID]);
    });

    it('is kept in a read-only view', () => {
        const items = backgroundMenu({ [WorkflowDiagramMetadata.READ_ONLY_VIEW]: true });

        expect(items.map(item => item.id)).toContain(LAYOUT_MENU_ID);
    });
});
