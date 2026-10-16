import { Operation } from '@eclipse-glsp/protocol';
import { GModelRecordingCommand, GModelSerializer, ModelState, OperationHandler, type Command, type MaybePromise } from '@eclipse-glsp/server';
import { inject, injectable } from 'inversify';
import { PORT_ORDER_FREE, PORT_ORDER_OPTION } from '../server/elk-layout-engine';
import { WORKFLOW_LAYOUT_BOUNDARY_FLOW_OPERATION_KIND, WorkflowLayoutBoundaryFlowOperationHandler } from './layout-boundary-flow-handler';

/**
 * Two layouts beside Layout Diagram, measured on the speculation flow of
 * chips/workflow (40 nodes, 106 edges; test/elk-layout-port-order.test.ts):
 *
 * - Untangled: the layered layout with ELK's hierarchical two-sided greedy
 *   switch and Brandes-Koepf placement. The ports keep the order the source
 *   declares them in. 278 crossings become 228.
 * - Free Ports: the same, and each node's ports in the order a probe layout
 *   found best against crossings (see WorkflowElkLayoutEngine). 127 crossings,
 *   at the price of the declared order.
 *
 * Both run the boundary-flow layout with the graph's options set for the run
 * and restored after it, so Layout Diagram itself is unchanged.
 *
 * The engine merges these over the preset the graph's size picked (see
 * layout-configurator.ts). In the middle tier that changes nothing of note:
 * Brandes-Koepf is the middle preset's placement already. In the fast tier the
 * engine re-asserts the fast preset over them, so Untangled and Free Ports lay
 * out as roughly as Layout Diagram does there, in seconds rather than minutes.
 */
export const UNTANGLED_ELK_OPTIONS: Record<string, string> = {
    'elk.layered.crossingMinimization.greedySwitchHierarchical.type': 'TWO_SIDED',
    'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF'
};

export const WORKFLOW_LAYOUT_UNTANGLED_OPERATION_KIND = 'dialogram.layoutUntangled' as const;
export const WORKFLOW_LAYOUT_FREE_PORTS_OPERATION_KIND = 'dialogram.layoutFreePorts' as const;

export interface WorkflowLayoutTunedOperation extends Operation {
    kind: typeof WORKFLOW_LAYOUT_UNTANGLED_OPERATION_KIND | typeof WORKFLOW_LAYOUT_FREE_PORTS_OPERATION_KIND;
    elementIds?: string[];
}

@injectable()
abstract class WorkflowLayoutTunedOperationHandler extends OperationHandler {
    @inject(ModelState)
    protected override modelState!: ModelState;

    @inject(GModelSerializer)
    protected serializer!: GModelSerializer;

    @inject(WorkflowLayoutBoundaryFlowOperationHandler)
    protected boundaryFlow!: WorkflowLayoutBoundaryFlowOperationHandler;

    /** The graph options this layout adds for its run. */
    protected abstract graphOptions(): Record<string, string>;

    override createCommand(operation: WorkflowLayoutTunedOperation): MaybePromise<Command | undefined> {
        return new GModelRecordingCommand(this.modelState, this.serializer, () => this.executeOperation(operation));
    }

    private async executeOperation(operation: WorkflowLayoutTunedOperation): Promise<void> {
        const root = this.modelState.root as any;
        const previous = root.layoutOptions ? { ...(root.layoutOptions as Record<string, unknown>) } : undefined;
        root.layoutOptions = { ...(previous ?? {}), ...this.graphOptions() };
        try {
            await this.boundaryFlow.runLayout({
                kind: WORKFLOW_LAYOUT_BOUNDARY_FLOW_OPERATION_KIND,
                isOperation: true,
                elementIds: operation.elementIds
            });
        } finally {
            root.layoutOptions = previous;
        }
    }
}

@injectable()
export class WorkflowLayoutUntangledOperationHandler extends WorkflowLayoutTunedOperationHandler {
    override readonly operationType = WORKFLOW_LAYOUT_UNTANGLED_OPERATION_KIND;

    protected graphOptions(): Record<string, string> {
        return { ...UNTANGLED_ELK_OPTIONS };
    }
}

@injectable()
export class WorkflowLayoutFreePortsOperationHandler extends WorkflowLayoutTunedOperationHandler {
    override readonly operationType = WORKFLOW_LAYOUT_FREE_PORTS_OPERATION_KIND;

    protected graphOptions(): Record<string, string> {
        return { ...UNTANGLED_ELK_OPTIONS, [PORT_ORDER_OPTION]: PORT_ORDER_FREE };
    }
}
