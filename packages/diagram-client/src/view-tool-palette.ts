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
 *
 * Under its tools it draws the view options of the diagram shown
 * (`view-options.ts`, `view-options-palette.ts`), and redraws them, and only
 * them, when they change. GLSP says "No results found." whenever it has no
 * tools, which a palette with view options, or with nothing at all (a
 * product that creates nothing), is not: it says it only when a filter
 * matched neither a tool nor a line.
 *
 * A product's palette extends it; one that draws a search or settings of its
 * own in the body says so with `drawsOwnContent`.
 */
import { type Action, SetModelAction, ToolPalette, UpdateModelAction } from '@eclipse-glsp/client';
import { WorkflowDiagramMetadata } from '@dialogram/shared';
import { inject, injectable, optional } from 'inversify';
import { ViewOptionsService } from './view-options';
import { drawViewOptionGroups, VIEW_OPTIONS_CLASS, ViewOptionsCollapse } from './view-options-palette';

/** What GLSP's palette says when it has nothing to show. */
const NO_RESULTS = 'No results found.';
/** The class of the body when it has nothing at all to show, and is not drawn. */
export const EMPTY_PALETTE_BODY_CLASS = 'palette-body-empty';

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
    @inject(ViewOptionsService) @optional() protected readonly viewOptions?: ViewOptionsService;

    private itemsDynamic = false;
    private paletteKey: string | undefined;
    private paletteChanged = false;
    private readonly collapse = new ViewOptionsCollapse();
    private viewOptionsWatched = false;

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

    protected override createBody(): void {
        super.createBody();
        if (!this.viewOptionsWatched && this.viewOptions) {
            this.viewOptionsWatched = true;
            this.viewOptions.onDidChange(() => this.drawViewOptions());
        }
        this.drawViewOptions();
    }

    /**
     * Whether this palette draws in its body itself, beside the tools and the
     * view options (a product's own search or settings). Such a body is never
     * drawn as empty, nor said to have found nothing.
     */
    protected drawsOwnContent(): boolean {
        return false;
    }

    /** The view options under the tools, drawn again; the tools are left as they are. */
    protected drawViewOptions(): void {
        const body = this.bodyDiv;
        if (!body || typeof document === 'undefined') {
            return;
        }
        const filter = this.searchField?.value ?? '';
        const tools = (this.paletteItems ?? []).length > 0;
        // With no tools, a button of the body's own is GLSP's word for
        // nothing, or ours from the drawing before.
        if (!tools) {
            for (const said of Array.from(body.querySelectorAll<HTMLElement>(':scope > .tool-button'))) {
                said.remove();
            }
        }
        let holder = body.querySelector<HTMLElement>(`:scope > .${VIEW_OPTIONS_CLASS}`);
        if (!holder) {
            holder = document.createElement('div');
            holder.classList.add(VIEW_OPTIONS_CLASS);
            body.appendChild(holder);
        }
        const service = this.viewOptions;
        // Drawn anew on every change: what the reader was at (a long group
        // scrolled, the line or heading Space and Enter work on) is put back.
        const scrolled = new Map<string, number>();
        for (const lines of Array.from(holder.querySelectorAll<HTMLElement>('.view-options-group .view-options-lines'))) {
            const group = lines.closest<HTMLElement>('.view-options-group')?.dataset.group;
            if (group !== undefined && lines.scrollTop > 0) {
                scrolled.set(group, lines.scrollTop);
            }
        }
        const active = document.activeElement as HTMLElement | null;
        const focused = active && holder.contains(active) ? {
            group: active.closest<HTMLElement>('.view-options-group')?.dataset.group,
            item: active.dataset.item,
            header: active.classList.contains('view-options-header')
        } : undefined;
        holder.replaceChildren(...drawViewOptionGroups(service?.groups ?? [], {
            filter,
            isCollapsed: group => this.collapse.isCollapsed(group),
            onCollapse: (group, collapsed) => {
                this.collapse.set(group, collapsed);
                this.drawViewOptions();
            },
            onChange: change => service?.change(change)
        }));
        for (const group of Array.from(holder.querySelectorAll<HTMLElement>('.view-options-group'))) {
            const top = group.dataset.group !== undefined ? scrolled.get(group.dataset.group) : undefined;
            const lines = group.querySelector<HTMLElement>('.view-options-lines');
            if (top !== undefined && lines) {
                lines.scrollTop = top;
            }
            if (focused && group.dataset.group === focused.group) {
                const again = focused.header
                    ? group.querySelector<HTMLElement>('.view-options-header')
                    : Array.from(group.querySelectorAll<HTMLElement>('.view-option')).find(line => line.dataset.item === focused.item);
                again?.focus({ preventScroll: true });
            }
        }
        const options = holder.childElementCount > 0;
        const shown = tools || options || this.drawsOwnContent();
        if (!shown && filter.trim() !== '') {
            // A filter that matched nothing: that is what the words are for.
            const nothing = document.createElement('div');
            nothing.classList.add('tool-button');
            nothing.textContent = NO_RESULTS;
            body.insertBefore(nothing, holder);
        }
        body.classList.toggle(EMPTY_PALETTE_BODY_CLASS, !shown && filter.trim() === '');
    }
}
