/**
 * The diagram's root view: GLSP's, its svg marked with the level of detail of
 * the zoom (zoom-detail.ts), which decides how much text the nodes draw.
 * Apart from the helpers, which load where GLSP's runtime does not.
 */
import { injectable } from 'inversify';
import { GGraphView } from '@eclipse-glsp/client';
import type { RenderingContext } from '@eclipse-glsp/sprotty';
import type { VNode } from 'snabbdom';
import { markDetail } from './zoom-detail';

@injectable()
export class DetailGraphView extends GGraphView {
    override render(model: any, context: RenderingContext): VNode {
        return markDetail(super.render(model, context) as VNode, model?.zoom, context?.targetKind) as VNode;
    }
}
