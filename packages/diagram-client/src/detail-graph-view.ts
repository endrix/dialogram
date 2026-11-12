/**
 * The diagram's root view: GLSP's, its svg marked with the level of detail of
 * the zoom (zoom-detail.ts), which decides how much text the nodes draw, and
 * carrying the links of the selection (selection-links.ts), drawn over it.
 * Apart from the helpers, which load where GLSP's runtime does not.
 */
import { injectable } from 'inversify';
import { GGraphView } from '@eclipse-glsp/client';
import type { RenderingContext } from '@eclipse-glsp/sprotty';
import type { VNode } from 'snabbdom';
import { withSelectionLinks } from './selection-links';
import { markDetail } from './zoom-detail';

@injectable()
export class DetailGraphView extends GGraphView {
    override render(model: any, context: RenderingContext): VNode {
        const drawn = markDetail(super.render(model, context) as VNode, model?.zoom, context?.targetKind);
        return withSelectionLinks(drawn, model, context?.targetKind) as VNode;
    }
}
