/**
 * The rest of the diagram all but disappears while the selection's links are
 * shown (selection-links.ts): a postprocessor puts `wf-focus-faded` on the
 * drawing of every node and edge the selection does not keep in sight, as the
 * root's view worked it out for this render.
 */
import { injectable } from 'inversify';
import type { IVNodePostprocessor } from '@eclipse-glsp/sprotty';
import type { VNode } from 'snabbdom';
import { isFadedBySelection } from './selection-links';

/** The class an element's drawing wears while it is out of the selection's sight. */
export const FOCUS_FADED_CLASS = 'wf-focus-faded';

@injectable()
export class SelectionFocusPostprocessor implements IVNodePostprocessor {
    decorate(vnode: VNode, element: any): VNode {
        if (isFadedBySelection(element)) {
            const data = (vnode.data ??= {});
            data.class = { ...(data.class ?? {}), [FOCUS_FADED_CLASS]: true };
        }
        return vnode;
    }

    postUpdate(): void {
        // Nothing to do once the drawing is on screen.
    }
}
