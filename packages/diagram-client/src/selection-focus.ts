/**
 * The rest of the diagram all but disappears while the selection's links are
 * shown (selection-links.ts): a postprocessor puts `wf-focus-faded` on the
 * drawing of every node and edge the selection does not keep in sight, as the
 * root's view worked it out for this render. Not on what is read for itself:
 * an edge in error, or what is on the selection's trace (selection-trace.ts).
 */
import { injectable } from 'inversify';
import type { IVNodePostprocessor } from '@eclipse-glsp/sprotty';
import type { VNode } from 'snabbdom';
import { WorkflowDiagramCss } from '@dialogram/shared';
import { isFadedBySelection } from './selection-links';
import { TraceCss } from './selection-trace';

/** The class an element's drawing wears while it is out of the selection's sight. */
export const FOCUS_FADED_CLASS = 'wf-focus-faded';

/** The classes of what is read for itself, which never fades behind the selection's links. */
const READ_FOR_ITSELF: readonly string[] = [WorkflowDiagramCss.EDGE_ERROR, TraceCss.FOCUS, TraceCss.UPSTREAM, TraceCss.DOWNSTREAM];

/** Whether `element` fades behind the selection's links. */
export function fadesBehindSelection(element: { id: string; type?: string; root?: object; cssClasses?: readonly string[] }): boolean {
    return isFadedBySelection(element) && !(element.cssClasses ?? []).some(css => READ_FOR_ITSELF.includes(css));
}

@injectable()
export class SelectionFocusPostprocessor implements IVNodePostprocessor {
    decorate(vnode: VNode, element: any): VNode {
        if (fadesBehindSelection(element)) {
            const data = (vnode.data ??= {});
            data.class = { ...(data.class ?? {}), [FOCUS_FADED_CLASS]: true };
        }
        return vnode;
    }

    postUpdate(): void {
        // Nothing to do once the drawing is on screen.
    }
}
