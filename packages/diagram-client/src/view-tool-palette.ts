/**
 * The palette, asked for its items again when the view it is for changes.
 *
 * GLSP's palette asks the server for its items once, unless one of them is
 * dynamic. A read-only view offers what its producer lets the reader make in
 * it and nothing else (the server's `WorkflowToolPaletteItemProvider`), so
 * an editor that passes from one view to another, or from an editable unit
 * to a view and back, needs the items of the view it shows. They are asked
 * again after a model whose root says something else of what the palette
 * holds (`paletteKeyOf`) than the one before; after every model, as GLSP
 * does, where an item is dynamic.
 */
import { type Action, SetModelAction, ToolPalette, UpdateModelAction } from '@eclipse-glsp/client';
import { WorkflowDiagramMetadata } from '@dialogram/shared';
import { injectable } from 'inversify';

/** What of a root's arguments the server's palette items depend on. */
export function paletteKeyOf(args: Record<string, unknown> | undefined): string {
    return JSON.stringify([
        args?.[WorkflowDiagramMetadata.READ_ONLY_VIEW] === true,
        args?.[WorkflowDiagramMetadata.VIEW_EDITS] ?? null,
        args?.[WorkflowDiagramMetadata.VIEW_CREATES] ?? null,
        args?.[WorkflowDiagramMetadata.VIEW_REQUEST] ?? null
    ]);
}

@injectable()
export class ViewToolPalette extends ToolPalette {
    private itemsDynamic = false;
    private paletteKey: string | undefined;
    private paletteChanged = false;

    override handle(action: Action): void {
        if (UpdateModelAction.is(action) || SetModelAction.is(action)) {
            const key = paletteKeyOf((action.newRoot as { args?: Record<string, unknown> } | undefined)?.args);
            this.paletteChanged = key !== this.paletteKey;
            this.paletteKey = key;
        }
        super.handle(action);
    }

    protected override async setPaletteItems(): Promise<void> {
        await super.setPaletteItems();
        this.itemsDynamic = this.dynamic;
        // GLSP asks again only when its palette is dynamic: so it is, and
        // `reloadPaletteBody` says when.
        this.dynamic = true;
    }

    protected override async reloadPaletteBody(): Promise<void> {
        if (this.itemsDynamic || this.paletteChanged) {
            this.paletteChanged = false;
            await super.reloadPaletteBody();
        }
    }
}
