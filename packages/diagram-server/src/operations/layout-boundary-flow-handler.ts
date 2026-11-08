import { LayoutOperation, Operation } from '@eclipse-glsp/protocol';
import {
    GModelRecordingCommand,
    LayoutEngine,
    ModelState,
    OperationHandler,
    type Command,
    type GModelRoot,
    type MaybePromise,
    GModelSerializer
} from '@eclipse-glsp/server';
import { inject, injectable, optional } from 'inversify';
import { LayoutPersistenceService } from '../services/layout-persistence-service';
import { clearAllEdgeRoutingPoints } from '../routing/clear-edge-routes';
import { applyBoundaryFlowLayerConstraints, restoreNodeLayoutOptions } from './boundary-flow-layout';
import {
    WORKFLOW_REROUTE_EDGES_AVOID_OVERLAPS_OPERATION_KIND,
    WorkflowRerouteEdgesAvoidOverlapsOperationHandler
} from './reroute-edges-avoid-overlaps-handler';
import {
    persistLayout,
    restoreUnselectedLayout,
    movableNodeIdsIn,
    snapshotEdgeRoutesById,
    snapshotNodePositionsById
} from '../server/layout-snapshot';

export const WORKFLOW_LAYOUT_BOUNDARY_FLOW_OPERATION_KIND = 'dialogram.layoutBoundaryFlow' as const;

export interface WorkflowLayoutBoundaryFlowOperation extends Operation {
    kind: typeof WORKFLOW_LAYOUT_BOUNDARY_FLOW_OPERATION_KIND;
    /** Optional selection scope (same semantics as LayoutOperation.elementIds). */
    elementIds?: string[];
}

@injectable()
export class WorkflowLayoutBoundaryFlowOperationHandler extends OperationHandler {
    override readonly operationType = WORKFLOW_LAYOUT_BOUNDARY_FLOW_OPERATION_KIND;

    @inject(LayoutEngine)
    @optional()
    protected layoutEngine?: LayoutEngine;

    @inject(ModelState)
    protected override modelState!: ModelState;

    @inject(GModelSerializer)
    protected serializer!: GModelSerializer;

    @inject(LayoutPersistenceService)
    protected layoutPersistence!: LayoutPersistenceService;

    @inject(WorkflowRerouteEdgesAvoidOverlapsOperationHandler)
    protected rerouteHandler!: WorkflowRerouteEdgesAvoidOverlapsOperationHandler;

    override createCommand(operation: WorkflowLayoutBoundaryFlowOperation): MaybePromise<Command | undefined> {
        if (!this.layoutEngine) {
            console.warn('[WorkflowLayoutBoundaryFlowOperationHandler] Could not execute layout operation. No LayoutEngine is bound!');
            return undefined;
        }
        return new GModelRecordingCommand(this.modelState, this.serializer, () => this.executeOperation(operation));
    }

    /** The whole layout, for a handler that sets the graph's options first (see layout-tuned-handler.ts). */
    runLayout(operation: WorkflowLayoutBoundaryFlowOperation): Promise<void> {
        return this.executeOperation(operation);
    }

    private async executeOperation(operation: WorkflowLayoutBoundaryFlowOperation): Promise<void> {
        const selectedMovableNodeIds = movableNodeIdsIn(this.modelState.index, operation.elementIds);
        const hasSelection = selectedMovableNodeIds.size > 0;

        const preNodePositionsById = hasSelection ? snapshotNodePositionsById(this.modelState.root) : undefined;
        const preEdgeRoutesById = hasSelection ? snapshotEdgeRoutesById(this.modelState.root) : undefined;

        const previousLayoutOptionsByNodeId = applyBoundaryFlowLayerConstraints(this.modelState.root, selectedMovableNodeIds, hasSelection);

        clearAllEdgeRoutingPoints(this.modelState.root);
        await this.layoutEngine?.layout(LayoutOperation.create(operation.elementIds));

        restoreNodeLayoutOptions(this.modelState.root, previousLayoutOptionsByNodeId);

        if (hasSelection && preNodePositionsById && preEdgeRoutesById) {
            restoreUnselectedLayout(this.modelState.index, this.modelState.root, selectedMovableNodeIds, preNodePositionsById, preEdgeRoutesById);
        }

        // Finalize with canonical reroute only for selection-scoped layout.
        // For full-diagram layout, ELK already produced coherent routes and a second
        // reroute pass can over-constrain geometry and create long trunks.
        if (hasSelection) {
            await this.rerouteHandler.runReroute({
                isOperation: true,
                kind: WORKFLOW_REROUTE_EDGES_AVOID_OVERLAPS_OPERATION_KIND,
                preview: false,
                source: 'changeBounds'
            });
        }

        await persistLayout(this.modelState, this.layoutPersistence, { layoutPerformed: true });
    }
}
