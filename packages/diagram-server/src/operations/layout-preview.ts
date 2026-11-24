/**
 * A layout drawn to be looked at, not saved.
 *
 * The chat's untangle tries lay the diagram out several ways, one after the
 * other, for the agent to compare by their pictures and crossings; only the
 * one the person keeps is saved. So each is run here as the Layout menu's
 * layout of that name would run it (Layout Diagram, Untangled, Free Ports),
 * with the port orders asked for given to Free Ports, and drawn on the
 * person's diagram without touching the layout file or the undo stack.
 *
 * Drawing it: the model goes to the client as an update of its own, not
 * through the model submission that follows an operation. That submission
 * asks the client for its bounds first and sends the model when they come
 * back, so a picture asked for right after it could be taken of the model
 * before. Here the update is on the client's command stack before the fit,
 * and the fit before anything asked after, a picture first among them. A
 * layout changes no node's size, so the bounds the server holds are the
 * client's.
 */
import { FitToScreenAction, UpdateModelAction } from '@eclipse-glsp/protocol';
import { ActionDispatcher, GModelSerializer, ModelState } from '@eclipse-glsp/server';
import { inject, injectable } from 'inversify';
import { PORT_ORDERS_OPTION, type SideOrder } from '../model/definition-port-order';
import { applyLayoutGeometry, layoutGeometryOf, type LayoutGeometry } from '../server/layout-snapshot';
import { WORKFLOW_LAYOUT_BOUNDARY_FLOW_OPERATION_KIND, WorkflowLayoutBoundaryFlowOperationHandler } from './layout-boundary-flow-handler';
import { tunedLayoutOptions } from './layout-tuned-handler';

/** A layout of the Layout menu: Layout Diagram (`default`), Untangled or Free Ports. */
export type PreviewLayout = 'default' | 'untangled' | 'free-ports';

/** Room around the diagram when it is fitted to the view, in screen pixels. */
const FIT_PADDING = 24;

@injectable()
export class LayoutPreview {
    @inject(ModelState)
    protected modelState!: ModelState;

    @inject(GModelSerializer)
    protected serializer!: GModelSerializer;

    @inject(ActionDispatcher)
    protected actionDispatcher!: ActionDispatcher;

    @inject(WorkflowLayoutBoundaryFlowOperationHandler)
    protected boundaryFlow!: WorkflowLayoutBoundaryFlowOperationHandler;

    /** The diagram as it is drawn now. */
    geometry(): LayoutGeometry {
        return layoutGeometryOf(this.modelState.root);
    }

    /**
     * Lay the diagram out as `layout` does, not saved; with Free Ports, the
     * definitions `portOrders` names take its orders (see
     * definition-port-order.ts). Drawn with {@link show}.
     */
    async run(layout: PreviewLayout, portOrders?: Record<string, SideOrder>): Promise<void> {
        const root = this.modelState.root as { layoutOptions?: Record<string, unknown> };
        const previous = root.layoutOptions ? { ...root.layoutOptions } : undefined;
        root.layoutOptions = {
            ...(previous ?? {}),
            ...(layout === 'default' ? {} : tunedLayoutOptions(layout)),
            ...(portOrders && Object.keys(portOrders).length > 0 ? { [PORT_ORDERS_OPTION]: JSON.stringify(portOrders) } : {})
        };
        try {
            await this.boundaryFlow.runLayout({ kind: WORKFLOW_LAYOUT_BOUNDARY_FLOW_OPERATION_KIND, isOperation: true, persist: false });
        } finally {
            root.layoutOptions = previous;
        }
    }

    /** Draw the diagram on the client as the server holds it, `geometry` put on it first when given, fitted to the view. */
    async show(geometry?: LayoutGeometry): Promise<void> {
        const root = this.modelState.root;
        if (geometry) {
            applyLayoutGeometry(root, geometry);
        }
        root.revision = (root.revision ?? 0) + 1;
        await this.actionDispatcher.dispatchAll([
            UpdateModelAction.create(this.serializer.createSchema(root), { animate: false }),
            FitToScreenAction.create([], { padding: FIT_PADDING, animate: false })
        ]);
    }
}
