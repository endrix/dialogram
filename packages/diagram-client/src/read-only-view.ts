/**
 * A view the producer marked read-only (`wf:readOnlyView` on the root, from
 * its `graph.meta.readOnly`) offers nothing to create. While such a view is
 * shown the page carries `wf-read-only-view`, and the stylesheet hides the
 * palette's tools under it; the palette's header (layout, fit, export)
 * stays, and so does moving nodes. Per view: the tools come back with the
 * next editable view, without a reload, which the palette itself would not
 * do (it asks for its items once per editor).
 */
import { injectable } from 'inversify';
import { WorkflowDiagramMetadata } from '@dialogram/shared';

export const READ_ONLY_VIEW_CLASS = 'wf-read-only-view';

/** Whether the root model is a view the producer marked read-only. */
export function isReadOnlyView(root: unknown): boolean {
    const args = (root as { args?: Record<string, unknown> } | undefined)?.args;
    return args?.[WorkflowDiagramMetadata.READ_ONLY_VIEW] === true;
}

@injectable()
export class ReadOnlyViewMarker {
    modelRootChanged(root: unknown): void {
        globalThis.document?.body?.classList.toggle(READ_ONLY_VIEW_CLASS, isReadOnlyView(root));
    }
}
