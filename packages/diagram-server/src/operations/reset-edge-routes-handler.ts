import { Operation } from '@eclipse-glsp/protocol';
import {
    GEdge,
    GModelRecordingCommand,
    ModelState,
    OperationHandler,
    type Command,
    type MaybePromise
} from '@eclipse-glsp/server';
import { inject, injectable } from 'inversify';
import { LayoutPersistenceService } from '../services/layout-persistence-service';
import { GModelSerializer } from '@eclipse-glsp/server';
import { persistLayout } from '../server/layout-snapshot';

export const WORKFLOW_RESET_EDGE_ROUTES_OPERATION_KIND = 'dialogram.resetEdgeRoutes' as const;

export interface WorkflowResetEdgeRoutesOperation extends Operation {
    kind: typeof WORKFLOW_RESET_EDGE_ROUTES_OPERATION_KIND;
    /** If empty/undefined, resets all edge routes in the diagram. */
    elementIds?: string[];
}

@injectable()
export class WorkflowResetEdgeRoutesOperationHandler extends OperationHandler {
    override readonly operationType = WORKFLOW_RESET_EDGE_ROUTES_OPERATION_KIND;

    @inject(ModelState)
    protected override modelState!: ModelState;

    @inject(GModelSerializer)
    protected serializer!: GModelSerializer;

    @inject(LayoutPersistenceService)
    protected layoutPersistence!: LayoutPersistenceService;

    override createCommand(operation: WorkflowResetEdgeRoutesOperation): MaybePromise<Command | undefined> {
        return new GModelRecordingCommand(this.modelState, this.serializer, () => this.executeOperation(operation));
    }

    private async executeOperation(operation: WorkflowResetEdgeRoutesOperation): Promise<void> {
        const root = this.modelState.root;

        const selectedIds = new Set(Array.isArray(operation.elementIds) ? operation.elementIds : []);
        const resetAll = selectedIds.size === 0;

        const shouldResetEdge = (edge: any): boolean => {
            if (resetAll) {
                return true;
            }

            const edgeId = String(edge.id);
            if (selectedIds.has(edgeId)) {
                return true;
            }

            const sourceId = edge.sourceId as string | undefined;
            const targetId = edge.targetId as string | undefined;
            if (typeof sourceId === 'string' && selectedIds.has(sourceId)) {
                return true;
            }
            if (typeof targetId === 'string' && selectedIds.has(targetId)) {
                return true;
            }

            // If a node/port is selected, reset connected edges.
            // (We treat selection IDs as referring to any element in the hierarchy.)
            if (typeof sourceId === 'string') {
                const sourceElement = this.modelState.index.find(sourceId);
                let current: any = sourceElement;
                while (current) {
                    if (selectedIds.has(String(current.id))) {
                        return true;
                    }
                    current = current.parent;
                }
            }
            if (typeof targetId === 'string') {
                const targetElement = this.modelState.index.find(targetId);
                let current: any = targetElement;
                while (current) {
                    if (selectedIds.has(String(current.id))) {
                        return true;
                    }
                    current = current.parent;
                }
            }

            return false;
        };

        const visit = (element: any): void => {
            if (!element) {
                return;
            }
            if (element instanceof GEdge) {
                if (shouldResetEdge(element)) {
                    (element as any).routingPoints = undefined;
                    if ((element as any).args) {
                        delete (element as any).args['cal:manualRoute'];
                    }
                }
            }
            const children = element.children as any[] | undefined;
            if (Array.isArray(children)) {
                for (const child of children) {
                    visit(child);
                }
            }
        };

        visit(root);

        // Persist the cleared routes; the node positions already on disk stand. The
        // layout meta is left alone: noting "no persisted routes" would arm the
        // bootstrap reroute, which would redraw what was just reset.
        await persistLayout(this.modelState, this.layoutPersistence, { keepPersistedPositions: true, noteInMeta: false });
    }
}
