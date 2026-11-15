/**
 * A view the producer marked read-only (`wf:readOnlyView` on the root, from
 * its `graph.meta.readOnly`) offers nothing to create but what it still
 * allows: the server's palette answers per view, and the palette asks again
 * with each model (`ViewToolPalette`). While such a view is shown the page
 * carries `wf-read-only-view`, and an edit it allows (`wf:viewEdits`) a
 * class too (`wf-view-edits-transition`), for a stylesheet to follow.
 */
import { injectable } from 'inversify';
import { WorkflowDiagramMetadata, viewEditsOf } from '@dialogram/shared';

export const READ_ONLY_VIEW_CLASS = 'wf-read-only-view';
/** The page's class while a view that allows `edit` is shown. */
export const viewEditClass = (edit: string): string => `wf-view-edits-${edit}`;
/** The edits a view can allow, and so the classes a page can carry for them. */
const VIEW_EDITS = ['transition', 'state'];

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
