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
import { URI } from 'vscode-uri';
import { LayoutPersistenceService } from '../services/layout-persistence-service';
import { WORKFLOW_NETWORK_MODEL_KEY } from '@dialogram/shared';
import type { WorkflowDiagramModel } from '@dialogram/shared';
import { WorkflowDiagramMetadata } from '@dialogram/shared';
import { GModelSerializer } from '@eclipse-glsp/server';

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

        // Persist the updated routing points (and keep node positions stable).
        const diagramModel = this.modelState.get(WORKFLOW_NETWORK_MODEL_KEY) as WorkflowDiagramModel | undefined;
        if (!diagramModel) {
            return;
        }

        const workflowFilePath = URI.parse(diagramModel.documentUri).fsPath;
        const explicitName = (diagramModel as any).workflowName as string | undefined;
        const networkId = explicitName && explicitName.trim() !== ''
            ? explicitName.trim()
            : 'unknown';

        // Prefer the already-persisted node map (it uses stable keys), falling back to the
        // current model snapshot if no layout file exists yet.
        const persistedPositions = await this.layoutPersistence.loadLayout(workflowFilePath, networkId);
        const positions = persistedPositions ?? this.collectNodePositions(root);

        const routes = this.collectEdgeRoutes(root);
        await this.layoutPersistence.saveLayoutImmediate(workflowFilePath, networkId, positions, routes);

        const layoutMeta = this.modelState.get('workflow.layoutPersistence') as
            | {
                  workflowFilePath: string;
                  networkId: string;
                  hasPersistedLayout: boolean;
                  hasPersistedEdgeRoutes: boolean;
                  didInitialLayout: boolean;
                  hasClientBounds: boolean;
                  allowInitialLayoutPersistence: boolean;
              }
            | undefined;
        if (layoutMeta) {
            layoutMeta.hasPersistedEdgeRoutes = routes.size > 0;
            this.modelState.set('workflow.layoutPersistence', layoutMeta);
        }
    }

    private collectNodePositions(root: any): Map<string, { x: number; y: number }> {
        const result = new Map<string, { x: number; y: number }>();
        const visit = (element: any, parentAbsX: number, parentAbsY: number): void => {
            if (!element) {
                return;
            }

            const relX = element.position?.x ?? 0;
            const relY = element.position?.y ?? 0;
            const absX = parentAbsX + relX;
            const absY = parentAbsY + relY;

            const type = element.type as string | undefined;
            if (typeof type === 'string' && type.startsWith('node:')) {
                const args = element.args as Record<string, unknown> | undefined;
                const key = (args?.[WorkflowDiagramMetadata.AST_PATH] ??
                    args?.[WorkflowDiagramMetadata.ENTITY_NAME] ??
                    args?.[WorkflowDiagramMetadata.PORT_NAME]) as unknown;
                if (typeof key === 'string' && key.trim() !== '' && element.position) {
                    result.set(key, { x: absX, y: absY });
                }
            }

            const children = element.children as any[] | undefined;
            if (Array.isArray(children)) {
                for (const child of children) {
                    visit(child, absX, absY);
                }
            }
        };
        visit(root, 0, 0);
        return result;
    }

    private collectEdgeRoutes(root: any): Map<string, { x: number; y: number }[]> {
        const result = new Map<string, { x: number; y: number }[]>();
        const visit = (element: any): void => {
            if (!element) {
                return;
            }
            if (element instanceof GEdge) {
                const args = element.args as Record<string, unknown> | undefined;
                const key = args?.[WorkflowDiagramMetadata.AST_PATH];
                const routingPoints = (element as any).routingPoints as { x: number; y: number }[] | undefined;
                if (typeof key === 'string' && Array.isArray(routingPoints) && routingPoints.length > 0) {
                    result.set(key, routingPoints);
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
        return result;
    }
}
