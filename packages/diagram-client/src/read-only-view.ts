/**
 * A view the producer marked read-only (`wf:readOnlyView` on the root, from
 * its `graph.meta.readOnly`) offers nothing to create. While such a view is
 * shown the page carries `wf-read-only-view`, and the stylesheet hides the
 * palette's tools under it; the palette's header (layout, fit, export)
 * stays, and so does moving nodes. Per view: the tools come back with the
 * next editable view, without a reload, which the palette itself would not
 * do (it asks for its items once per editor).
 *
 * What such a view still allows (`wf:viewEdits`) the page carries too, an
 * edit a class (`wf-view-edits-transition`), and the stylesheet shows that
 * edit's tools: the palette's Transition, offered in every editor and shown
 * only there.
 */
import { injectable } from 'inversify';
import { WorkflowDiagramMetadata, viewEditsOf } from '@dialogram/shared';

export const READ_ONLY_VIEW_CLASS = 'wf-read-only-view';
/** The page's class while a view that allows `edit` is shown. */
export const viewEditClass = (edit: string): string => `wf-view-edits-${edit}`;
/** The edits a view can allow, and so the classes a page can carry for them. */
const VIEW_EDITS = ['transition'];

/** Whether the root model is a view the producer marked read-only. */
export function isReadOnlyView(root: unknown): boolean {
    const args = (root as { args?: Record<string, unknown> } | undefined)?.args;
    return args?.[WorkflowDiagramMetadata.READ_ONLY_VIEW] === true;
}

@injectable()
export class ReadOnlyViewMarker {
    modelRootChanged(root: unknown): void {
        const classes = globalThis.document?.body?.classList;
        classes?.toggle(READ_ONLY_VIEW_CLASS, isReadOnlyView(root));
        const edits = viewEditsOf((root as { args?: Record<string, unknown> } | undefined)?.args);
        for (const edit of VIEW_EDITS) {
            classes?.toggle(viewEditClass(edit), edits.includes(edit));
        }
    }
}
