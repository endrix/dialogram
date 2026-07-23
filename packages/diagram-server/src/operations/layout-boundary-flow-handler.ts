import { LayoutOperation, Operation } from '@eclipse-glsp/protocol';
import {
    GEdge,
    GModelRecordingCommand,
    GPort,
    LayoutEngine,
    ModelState,
    OperationHandler,
    type Command,
    type GModelRoot,
    type MaybePromise,
    GModelSerializer
} from '@eclipse-glsp/server';
import { inject, injectable, optional } from 'inversify';
import { URI } from 'vscode-uri';
import { LayoutPersistenceService } from '../services/layout-persistence-service';
import { WORKFLOW_LAYOUT_PERSISTENCE_KEY, WORKFLOW_NETWORK_MODEL_KEY } from '@dialogram/shared';
import type { WorkflowDiagramModel } from '@dialogram/shared';
import { WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import { clearAllEdgeRoutingPoints } from '../routing/clear-edge-routes';
import {
    WORKFLOW_REROUTE_EDGES_AVOID_OVERLAPS_OPERATION_KIND,
    WorkflowRerouteEdgesAvoidOverlapsOperationHandler
} from './reroute-edges-avoid-overlaps-handler';

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

    private async executeOperation(operation: WorkflowLayoutBoundaryFlowOperation): Promise<void> {
        const selectedMovableNodeIds = this.getSelectedMovableNodeIds(operation.elementIds);
        const hasSelection = selectedMovableNodeIds.size > 0;

        const preNodePositionsById = hasSelection ? this.snapshotNodePositionsById(this.modelState.root) : undefined;
        const preEdgeRoutesById = hasSelection ? this.snapshotEdgeRoutesById(this.modelState.root) : undefined;

        const previousLayoutOptionsByNodeId = this.applyBoundaryFlowLayerConstraints(this.modelState.root, selectedMovableNodeIds, hasSelection);

        clearAllEdgeRoutingPoints(this.modelState.root);
        await this.layoutEngine?.layout(LayoutOperation.create(operation.elementIds));

        this.restoreNodeLayoutOptions(this.modelState.root, previousLayoutOptionsByNodeId);

        if (hasSelection && preNodePositionsById && preEdgeRoutesById) {
            this.restoreUnselectedLayout(this.modelState.root, selectedMovableNodeIds, preNodePositionsById, preEdgeRoutesById);
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

        const diagramModel = this.modelState.get(WORKFLOW_NETWORK_MODEL_KEY) as WorkflowDiagramModel | undefined;
        if (!diagramModel) {
            return;
        }

        const workflowFilePath = URI.parse(diagramModel.documentUri).fsPath;
        const explicitName = (diagramModel as any).workflowName as string | undefined;
        const networkId = explicitName && explicitName.trim() !== ''
            ? explicitName.trim()
            : 'unknown';
        const positions = this.collectNodePositions(this.modelState.root);
        const routes = this.collectEdgeRoutes(this.modelState.root);
        await this.layoutPersistence.saveLayoutImmediate(workflowFilePath, networkId, positions, routes);

        const layoutMeta = this.modelState.get(WORKFLOW_LAYOUT_PERSISTENCE_KEY) as
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
            layoutMeta.hasPersistedLayout = true;
            layoutMeta.hasPersistedEdgeRoutes = routes.size > 0;
            this.modelState.set(WORKFLOW_LAYOUT_PERSISTENCE_KEY, layoutMeta);
        }
    }

    private applyBoundaryFlowLayerConstraints(
        root: any,
        selectedMovableNodeIds: Set<string>,
        hasSelection: boolean
    ): Map<string, Record<string, unknown> | undefined> {
        const previousLayoutOptionsByNodeId = new Map<string, Record<string, unknown> | undefined>();

        const visit = (element: any): void => {
            if (!element) {
                return;
            }

            if (this.isTaskNode(element)) {
                const nodeId = String(element.id);
                if (!hasSelection || selectedMovableNodeIds.has(nodeId)) {
                    const hasInput = this.nodeHasPortDirection(element, 'input');
                    const hasOutput = this.nodeHasPortDirection(element, 'output');

                    if (!hasInput || !hasOutput) {
                        const previousLayoutOptions = (element as any).layoutOptions as Record<string, unknown> | undefined;
                        previousLayoutOptionsByNodeId.set(nodeId, previousLayoutOptions ? { ...previousLayoutOptions } : undefined);

                        // Keep one-sided nodes on dedicated outer layers so they do not
                        // share a column with regular processing nodes.
                        const nodeLayerConstraint = !hasInput ? 'FIRST_SEPARATE' : 'LAST_SEPARATE';
                        (element as any).layoutOptions = {
                            ...(previousLayoutOptions ?? {}),
                            'elk.layered.layering.layerConstraint': nodeLayerConstraint,
                            'org.eclipse.elk.layered.layering.layerConstraint': nodeLayerConstraint
                        };
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
        return previousLayoutOptionsByNodeId;
    }

    private restoreNodeLayoutOptions(root: any, previousLayoutOptionsByNodeId: Map<string, Record<string, unknown> | undefined>): void {
        if (previousLayoutOptionsByNodeId.size === 0) {
            return;
        }

        const visit = (element: any): void => {
            if (!element) {
                return;
            }

            const nodeId = typeof element.id === 'string' ? element.id : undefined;
            if (nodeId && previousLayoutOptionsByNodeId.has(nodeId)) {
                const previous = previousLayoutOptionsByNodeId.get(nodeId);
                (element as any).layoutOptions = previous ? { ...previous } : undefined;
            }

            const children = element.children as any[] | undefined;
            if (Array.isArray(children)) {
                for (const child of children) {
                    visit(child);
                }
            }
        };

        visit(root);
    }

    private isTaskNode(element: any): boolean {
        const type = element?.type as string | undefined;
        return type === WorkflowDiagramTypes.NODE_ACTOR || type === WorkflowDiagramTypes.NODE_EXTERNAL_ACTOR;
    }

    private nodeHasPortDirection(node: any, direction: 'input' | 'output'): boolean {
        const ports: any[] = [];

        const collectPorts = (element: any): void => {
            if (!element) {
                return;
            }
            if (element instanceof GPort) {
                ports.push(element);
            }
            const children = element.children as any[] | undefined;
            if (Array.isArray(children)) {
                for (const child of children) {
                    collectPorts(child);
                }
            }
        };

        collectPorts(node);

        return ports.some(port => {
            const portDirection = (port as any).args?.[WorkflowDiagramMetadata.PORT_DIRECTION] as string | undefined;
            if (direction === 'input') {
                return portDirection === 'input' || port.type === WorkflowDiagramTypes.PORT_INPUT;
            }
            return portDirection === 'output' || port.type === WorkflowDiagramTypes.PORT_OUTPUT;
        });
    }

    private isMovableNode(element: any): boolean {
        const type = element?.type as string | undefined;
        return typeof type === 'string' && type.startsWith('node:');
    }

    private getMovableNodeIdForElementId(elementId: string): string | undefined {
        let current: any = this.modelState.index.find(elementId);
        while (current) {
            if (this.isMovableNode(current)) {
                return String((current as any).id);
            }
            current = (current as any).parent;
        }
        return undefined;
    }

    private getSelectedMovableNodeIds(elementIds: string[] | undefined): Set<string> {
        const result = new Set<string>();
        const ids = Array.isArray(elementIds) ? elementIds : [];

        for (const id of ids) {
            const movable = this.getMovableNodeIdForElementId(id);
            if (movable) {
                result.add(movable);
            }

            const element: any = this.modelState.index.find(id);
            const type = element?.type as string | undefined;
            const isEdge = element instanceof GEdge || (typeof type === 'string' && type.startsWith('edge:'));
            if (isEdge) {
                const sourceId = (element as any).sourceId as string | undefined;
                const targetId = (element as any).targetId as string | undefined;
                if (typeof sourceId === 'string') {
                    const sourceMovable = this.getMovableNodeIdForElementId(sourceId);
                    if (sourceMovable) {
                        result.add(sourceMovable);
                    }
                }
                if (typeof targetId === 'string') {
                    const targetMovable = this.getMovableNodeIdForElementId(targetId);
                    if (targetMovable) {
                        result.add(targetMovable);
                    }
                }
            }
        }

        return result;
    }

    private snapshotNodePositionsById(root: any): Map<string, { x: number; y: number } | undefined> {
        const result = new Map<string, { x: number; y: number } | undefined>();
        const visit = (element: any): void => {
            if (!element) {
                return;
            }
            if (this.isMovableNode(element)) {
                const id = String((element as any).id);
                const pos = (element as any).position as { x?: number; y?: number } | undefined;
                if (pos) {
                    result.set(id, { x: pos.x ?? 0, y: pos.y ?? 0 });
                } else {
                    result.set(id, undefined);
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

    private snapshotEdgeRoutesById(root: any): Map<string, { x: number; y: number }[] | undefined> {
        const result = new Map<string, { x: number; y: number }[] | undefined>();
        const visit = (element: any): void => {
            if (!element) {
                return;
            }
            if (element instanceof GEdge) {
                const id = String((element as any).id);
                const routingPoints = (element as any).routingPoints as { x: number; y: number }[] | undefined;
                if (Array.isArray(routingPoints)) {
                    result.set(
                        id,
                        routingPoints.map(p => ({ x: p.x, y: p.y }))
                    );
                } else {
                    result.set(id, undefined);
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

    private restoreUnselectedLayout(
        root: any,
        selectedMovableNodeIds: Set<string>,
        preNodePositionsById: Map<string, { x: number; y: number } | undefined>,
        preEdgeRoutesById: Map<string, { x: number; y: number }[] | undefined>
    ): void {
        const visit = (element: any): void => {
            if (!element) {
                return;
            }

            if (this.isMovableNode(element)) {
                const id = String((element as any).id);
                if (!selectedMovableNodeIds.has(id)) {
                    const prev = preNodePositionsById.get(id);
                    (element as any).position = prev ? { x: prev.x, y: prev.y } : undefined;
                }
            }

            if (element instanceof GEdge) {
                const id = String((element as any).id);
                const sourceId = (element as any).sourceId as string | undefined;
                const targetId = (element as any).targetId as string | undefined;

                const sourceMovable = typeof sourceId === 'string' ? this.getMovableNodeIdForElementId(sourceId) : undefined;
                const targetMovable = typeof targetId === 'string' ? this.getMovableNodeIdForElementId(targetId) : undefined;

                const sourceSelected = sourceMovable ? selectedMovableNodeIds.has(sourceMovable) : false;
                const targetSelected = targetMovable ? selectedMovableNodeIds.has(targetMovable) : false;

                if (!sourceSelected && !targetSelected) {
                    const prevRoute = preEdgeRoutesById.get(id);
                    (element as any).routingPoints = prevRoute !== undefined ? prevRoute.map(p => ({ x: p.x, y: p.y })) : undefined;
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
    }

    private collectNodePositions(root: GModelRoot): Map<string, { x: number; y: number }> {
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
