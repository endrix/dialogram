/**
 * The palette, asked for its items again whenever the model changes.
 *
 * GLSP's palette asks the server for its items once, unless one of them is
 * dynamic. A read-only view offers what its producer lets the reader make in
 * it and nothing else (the server's `WorkflowToolPaletteItemProvider`), so
 * an editor that passes from one view to another, or from an editable unit
 * to a view and back, needs the items of the view it shows: they are asked
 * again after each model the server sends, as for a dynamic palette.
 */
import { ToolPalette } from '@eclipse-glsp/client';
import { injectable } from 'inversify';

@injectable()
export class ViewToolPalette extends ToolPalette {
    protected override async setPaletteItems(): Promise<void> {
        await super.setPaletteItems();
        this.dynamic = true;
    }
}
