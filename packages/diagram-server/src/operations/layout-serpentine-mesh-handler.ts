import { LayoutOperation, Operation } from '@eclipse-glsp/protocol';
import {
    GEdge,
    GModelRecordingCommand,
    GNode,
    GPort,
    GModelElement,
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
import {
    WorkflowRerouteEdgesAvoidOverlapsOperationHandler,
    WORKFLOW_REROUTE_EDGES_AVOID_OVERLAPS_OPERATION_KIND
} from './reroute-edges-avoid-overlaps-handler';
import { WORKFLOW_LAYOUT_PERSISTENCE_KEY, WORKFLOW_NETWORK_MODEL_KEY } from '@dialogram/shared';
import type { WorkflowDiagramModel } from '@dialogram/shared';
import { WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import { WorkflowDiagramConstants } from '@dialogram/shared';

export const WORKFLOW_LAYOUT_SERPENTINE_MESH_OPERATION_KIND = 'dialogram.layoutSerpentineMesh' as const;

export interface WorkflowLayoutSerpentineMeshOperation extends Operation {
    kind: typeof WORKFLOW_LAYOUT_SERPENTINE_MESH_OPERATION_KIND;
    elementIds?: string[];
}

@injectable()
export class WorkflowLayoutSerpentineMeshOperationHandler extends OperationHandler {
    override readonly operationType = WORKFLOW_LAYOUT_SERPENTINE_MESH_OPERATION_KIND;

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

    override createCommand(operation: WorkflowLayoutSerpentineMeshOperation): MaybePromise<Command | undefined> {
        if (!this.layoutEngine) {
            console.warn('[WorkflowLayoutSerpentineMeshOperationHandler] Could not execute layout operation. No LayoutEngine is bound!');
            return undefined;
        }
        return new GModelRecordingCommand(this.modelState, this.serializer, () => this.executeOperation(operation));
    }

    private async executeOperation(operation: WorkflowLayoutSerpentineMeshOperation): Promise<void> {
        const selectedMovableNodeIds = this.getSelectedMovableNodeIds(operation.elementIds);
        const hasSelection = selectedMovableNodeIds.size > 0;

        const preNodePositionsById = hasSelection ? this.snapshotNodePositionsById(this.modelState.root) : undefined;
        const preEdgeRoutesById = hasSelection ? this.snapshotEdgeRoutesById(this.modelState.root) : undefined;

        const previousGraphLayoutOptions = this.applySerpentineMeshPlacement(this.modelState.root, selectedMovableNodeIds, hasSelection);

        this.seedEdgeRoutesForFixedLayout(this.modelState.root);
        await this.layoutEngine?.layout(LayoutOperation.create(operation.elementIds));

        (this.modelState.root as any).layoutOptions = previousGraphLayoutOptions ? { ...previousGraphLayoutOptions } : undefined;

        if (hasSelection && preNodePositionsById && preEdgeRoutesById) {
            this.restoreUnselectedLayout(this.modelState.root, selectedMovableNodeIds, preNodePositionsById, preEdgeRoutesById);
        }

        // Route the edges with the proven obstacle-aware router (the same one the
        // default layout and node-drag use) instead of relying on ELK's fixed +
        // ORTHOGONAL routing, which does NOT avoid node obstacles and drew edges
        // straight through nodes in this fixed serpentine layout. With a selection,
        // only reroute the moved nodes' edges; otherwise reroute the whole graph.
        await this.rerouteHandler.runReroute({
            kind: WORKFLOW_REROUTE_EDGES_AVOID_OVERLAPS_OPERATION_KIND,
            isOperation: true,
            source: 'changeBounds',
            ...(hasSelection ? { elementIds: [...selectedMovableNodeIds] } : {})
        });

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

    private applySerpentineMeshPlacement(
        root: any,
        selectedMovableNodeIds: Set<string>,
        hasSelection: boolean
    ): Record<string, unknown> | undefined {
        const previousGraphLayoutOptions = ((root as any).layoutOptions as Record<string, unknown> | undefined) ?? undefined;
        (root as any).layoutOptions = {
            ...(previousGraphLayoutOptions ?? {}),
            'elk.algorithm': 'fixed',
            'elk.edgeRouting': 'ORTHOGONAL',
            'elk.direction': 'RIGHT',
            'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
            'elk.portConstraints': 'FIXED_POS'
        };

        const scopedNodes = this.collectScopedMovableNodes(root, selectedMovableNodeIds, hasSelection);
        const meshNodes = scopedNodes.filter(node => !this.isBoundaryNode(node));
        const boundaryNodes = scopedNodes.filter(node => this.isBoundaryNode(node));

        if (meshNodes.length < 2) {
            if (meshNodes.length === 1 && boundaryNodes.length > 0) {
                const singleMesh = meshNodes[0];
                const singlePosX = singleMesh.position?.x ?? 0;
                const singlePosY = singleMesh.position?.y ?? 0;
                const singleWidth = singleMesh.size?.width ?? 160;
                const singleHeight = singleMesh.size?.height ?? 90;
                this.placeBoundaryNodesOutsideMesh(root, boundaryNodes, {
                    left: singlePosX,
                    right: singlePosX + singleWidth,
                    top: singlePosY,
                    bottom: singlePosY + singleHeight,
                    width: singleWidth,
                    height: singleHeight
                });
            }
            return previousGraphLayoutOptions;
        }

        const scopedNodeIdSet = new Set(meshNodes.map(n => String(n.id)));
        const scopedEdges = this.collectScopedEdges(root, scopedNodeIdSet);
        const orderedNodeIds = this.orderNodesForSerpentine(meshNodes, scopedEdges);

        const orderedNodes = orderedNodeIds
            .map(id => meshNodes.find(node => String(node.id) === id))
            .filter((node): node is any => !!node);

        if (orderedNodes.length === 0) {
            return previousGraphLayoutOptions;
        }

        const startX = Math.min(...orderedNodes.map(node => (node.position?.x ?? 0)));
        const startY = Math.min(...orderedNodes.map(node => (node.position?.y ?? 0)));
        const maxWidth = Math.max(...orderedNodes.map(node => (node.size?.width ?? 160)));
        const maxHeight = Math.max(...orderedNodes.map(node => (node.size?.height ?? 90)));

        const spacingX = Math.max(220, maxWidth + 70);
        const spacingY = Math.max(160, maxHeight + 60);
        const columns = this.computeSerpentineColumns(orderedNodes.length);

        for (let index = 0; index < orderedNodes.length; index++) {
            const node = orderedNodes[index];
            const row = Math.floor(index / columns);
            const col = index % columns;

            (node as any).position = {
                x: startX + col * spacingX,
                y: startY + row * spacingY
            };
        }

        if (boundaryNodes.length > 0) {
            const meshBounds = this.computeNodeBounds(orderedNodes);
            if (meshBounds) {
                this.placeBoundaryNodesOutsideMesh(root, boundaryNodes, meshBounds);
            }
        }

        return previousGraphLayoutOptions;
    }

    private computeSerpentineColumns(nodeCount: number): number {
        if (nodeCount <= 0) {
            return 2;
        }
        if (nodeCount <= 4) {
            return nodeCount;
        }

        // Favor more rows for denser mesh arrangements while keeping columns compact.
        const targetRows = Math.max(3, Math.min(8, Math.ceil(Math.sqrt(nodeCount) * 1.25)));
        const columns = Math.ceil(nodeCount / targetRows);
        return Math.max(2, Math.min(nodeCount, columns));
    }

    private computeNodeBounds(nodes: any[]):
        | { left: number; right: number; top: number; bottom: number; width: number; height: number }
        | undefined {
        if (nodes.length === 0) {
            return undefined;
        }

        let left = Number.POSITIVE_INFINITY;
        let top = Number.POSITIVE_INFINITY;
        let right = Number.NEGATIVE_INFINITY;
        let bottom = Number.NEGATIVE_INFINITY;

        for (const node of nodes) {
            const x = node.position?.x ?? 0;
            const y = node.position?.y ?? 0;
            const width = node.size?.width ?? 160;
            const height = node.size?.height ?? 90;

            left = Math.min(left, x);
            top = Math.min(top, y);
            right = Math.max(right, x + width);
            bottom = Math.max(bottom, y + height);
        }

        if (!Number.isFinite(left) || !Number.isFinite(top) || !Number.isFinite(right) || !Number.isFinite(bottom)) {
            return undefined;
        }

        return {
            left,
            right,
            top,
            bottom,
            width: Math.max(1, right - left),
            height: Math.max(1, bottom - top)
        };
    }

    private placeBoundaryNodesOutsideMesh(
        root: any,
        boundaryNodes: any[],
        meshBounds: { left: number; right: number; top: number; bottom: number; width: number; height: number }
    ): void {
        const inputNodes = boundaryNodes.filter(node => this.isBoundaryInputNode(node));
        const outputNodes = boundaryNodes.filter(node => this.isBoundaryOutputNode(node));
        const preferredCenters = this.collectBoundaryPreferredCenters(root, boundaryNodes);

        const sortByVertical = (left: any, right: any): number => {
            const ly = preferredCenters.get(String(left.id)) ?? left.position?.y ?? 0;
            const ry = preferredCenters.get(String(right.id)) ?? right.position?.y ?? 0;
            if (ly !== ry) {
                return ly - ry;
            }
            return String(left.id).localeCompare(String(right.id));
        };

        inputNodes.sort(sortByVertical);
        outputNodes.sort(sortByVertical);

        const sideGap = 120;
        this.distributeBoundarySide(inputNodes, 'input', meshBounds, sideGap, preferredCenters);
        this.distributeBoundarySide(outputNodes, 'output', meshBounds, sideGap, preferredCenters);
    }

    private distributeBoundarySide(
        nodes: any[],
        side: 'input' | 'output',
        meshBounds: { left: number; right: number; top: number; bottom: number; width: number; height: number },
        sideGap: number,
        preferredCenters: Map<string, number>
    ): void {
        if (nodes.length === 0) {
            return;
        }

        if (nodes.length === 1) {
            const node = nodes[0];
            const nodeWidth = node.size?.width ?? 140;
            const nodeHeight = node.size?.height ?? 60;
            const minCenterY = meshBounds.top + nodeHeight / 2;
            const maxCenterY = meshBounds.bottom - nodeHeight / 2;
            const preferredCenterY = preferredCenters.get(String(node.id));
            const defaultCenterY = meshBounds.top + meshBounds.height / 2;
            const centerY = Math.max(minCenterY, Math.min(maxCenterY, preferredCenterY ?? defaultCenterY));
            const x = side === 'input'
                ? meshBounds.left - sideGap - nodeWidth
                : meshBounds.right + sideGap;
            (node as any).position = { x, y: centerY - nodeHeight / 2 };
            return;
        }

        const verticalSpan = Math.max(meshBounds.height, 120);
        const spanTop = meshBounds.top + (meshBounds.height - verticalSpan) / 2;

        for (let index = 0; index < nodes.length; index++) {
            const node = nodes[index];
            const nodeWidth = node.size?.width ?? 140;
            const nodeHeight = node.size?.height ?? 60;
            const fallbackCenterY = spanTop + ((index + 1) * verticalSpan) / (nodes.length + 1);
            const preferredCenterY = preferredCenters.get(String(node.id));
            const blendedCenterY = preferredCenterY !== undefined
                ? (preferredCenterY * 0.7 + fallbackCenterY * 0.3)
                : fallbackCenterY;
            const minCenterY = meshBounds.top + nodeHeight / 2;
            const maxCenterY = meshBounds.bottom - nodeHeight / 2;
            const centerY = Math.max(minCenterY, Math.min(maxCenterY, blendedCenterY));
            const y = centerY - nodeHeight / 2;
            const x = side === 'input'
                ? meshBounds.left - sideGap - nodeWidth
                : meshBounds.right + sideGap;

            (node as any).position = { x, y };
        }
    }

    private collectBoundaryPreferredCenters(root: any, boundaryNodes: any[]): Map<string, number> {
        const boundaryNodeIds = new Set(boundaryNodes.map(node => String(node.id)));
        const adjacentCenters = new Map<string, number[]>();

        const visit = (element: any): void => {
            if (!element) {
                return;
            }

            if (element instanceof GEdge) {
                const sourceId = (element as any).sourceId as string | undefined;
                const targetId = (element as any).targetId as string | undefined;
                const sourceNodeId = typeof sourceId === 'string' ? this.getMovableNodeIdForElementId(sourceId) : undefined;
                const targetNodeId = typeof targetId === 'string' ? this.getMovableNodeIdForElementId(targetId) : undefined;

                if (sourceNodeId && targetNodeId) {
                    if (boundaryNodeIds.has(sourceNodeId) && !boundaryNodeIds.has(targetNodeId)) {
                        const preferredY = this.getPortAnchorY(targetId)
                            ?? this.getNodeCenterY(targetNodeId);
                        if (preferredY !== undefined) {
                            const existing = adjacentCenters.get(sourceNodeId) ?? [];
                            existing.push(preferredY);
                            adjacentCenters.set(sourceNodeId, existing);
                        }
                    }
                    if (boundaryNodeIds.has(targetNodeId) && !boundaryNodeIds.has(sourceNodeId)) {
                        const preferredY = this.getPortAnchorY(sourceId)
                            ?? this.getNodeCenterY(sourceNodeId);
                        if (preferredY !== undefined) {
                            const existing = adjacentCenters.get(targetNodeId) ?? [];
                            existing.push(preferredY);
                            adjacentCenters.set(targetNodeId, existing);
                        }
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

        const result = new Map<string, number>();
        for (const [boundaryNodeId, centers] of adjacentCenters.entries()) {
            if (centers.length === 0) {
                continue;
            }
            centers.sort((left, right) => left - right);
            const mid = Math.floor(centers.length / 2);
            const median = centers.length % 2 === 0
                ? (centers[mid - 1] + centers[mid]) / 2
                : centers[mid];
            result.set(boundaryNodeId, median);
        }

        return result;
    }

    private getPortAnchorY(portId: string | undefined): number | undefined {
        if (typeof portId !== 'string') {
            return undefined;
        }
        return this.portAnchorInfo(portId)?.y;
    }

    private getNodeCenterY(nodeId: string): number | undefined {
        let node: any;
        try {
            node = this.modelState.index.find(nodeId);
        } catch {
            return undefined;
        }

        if (!node) {
            return undefined;
        }

        const y = node.position?.y;
        if (typeof y !== 'number') {
            return undefined;
        }

        const height = node.size?.height ?? 90;
        return y + height / 2;
    }

    private collectScopedMovableNodes(root: any, selectedMovableNodeIds: Set<string>, hasSelection: boolean): any[] {
        const nodes: any[] = [];
        const visit = (element: any): void => {
            if (!element) {
                return;
            }

            if (this.isMovableNode(element)) {
                const id = String((element as any).id);
                if (!hasSelection || selectedMovableNodeIds.has(id)) {
                    nodes.push(element);
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
        return nodes;
    }

    private collectScopedEdges(root: any, scopedNodeIdSet: Set<string>): Array<{ sourceNodeId: string; targetNodeId: string }> {
        const edges: Array<{ sourceNodeId: string; targetNodeId: string }> = [];
        const visit = (element: any): void => {
            if (!element) {
                return;
            }

            if (element instanceof GEdge) {
                const sourceId = (element as any).sourceId as string | undefined;
                const targetId = (element as any).targetId as string | undefined;
                const sourceNodeId = typeof sourceId === 'string' ? this.getMovableNodeIdForElementId(sourceId) : undefined;
                const targetNodeId = typeof targetId === 'string' ? this.getMovableNodeIdForElementId(targetId) : undefined;

                if (sourceNodeId && targetNodeId && scopedNodeIdSet.has(sourceNodeId) && scopedNodeIdSet.has(targetNodeId)) {
                    edges.push({ sourceNodeId, targetNodeId });
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
        return edges;
    }

    private seedEdgeRoutesForFixedLayout(root: any): void {
        const obstacles = this.collectNodeObstacles(root);
        const visit = (element: any): void => {
            if (!element) {
                return;
            }

            if (element instanceof GEdge) {
                const edge = element as GEdge;
                const source = this.portAnchorInfo(edge.sourceId);
                const target = this.portAnchorInfo(edge.targetId);
                if (source && target) {
                    const sourceNodeId = this.getMovableNodeIdForElementId(edge.sourceId);
                    const targetNodeId = this.getMovableNodeIdForElementId(edge.targetId);
                    const route = this.orthogonalRoute(source, target, sourceNodeId, targetNodeId, obstacles);
                    if (route.length >= 2) {
                        (edge as any).routingPoints = route;
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
    }

    private collectNodeObstacles(root: any): Array<{ id: string; left: number; right: number; top: number; bottom: number }> {
        const obstacles: Array<{ id: string; left: number; right: number; top: number; bottom: number }> = [];
        const margin = 10;

        const visit = (element: any): void => {
            if (!element) {
                return;
            }

            if (this.isMovableNode(element)) {
                const id = String((element as any).id);
                const pos = this.absolutePosition(element as GModelElement);
                const w = (element as any).size?.width ?? 0;
                const h = (element as any).size?.height ?? 0;
                if (w > 0 && h > 0) {
                    obstacles.push({
                        id,
                        left: pos.x - margin,
                        right: pos.x + w + margin,
                        top: pos.y - margin,
                        bottom: pos.y + h + margin
                    });
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
        return obstacles;
    }

    private orthogonalRoute(
        start: { x: number; y: number; side: 'WEST' | 'EAST' },
        end: { x: number; y: number; side: 'WEST' | 'EAST' },
        sourceNodeId: string | undefined,
        targetNodeId: string | undefined,
        obstacles: Array<{ id: string; left: number; right: number; top: number; bottom: number }>
    ): Array<{ x: number; y: number }> {
        const filteredObstacles = obstacles.filter(o => o.id !== sourceNodeId && o.id !== targetNodeId);
        const portClearance = 20;
        const validCandidates: Array<Array<{ x: number; y: number }>> = [];

        const startLead = this.offsetFromPort(start, portClearance);
        const endLead = this.offsetFromPort(end, portClearance);

        if (startLead.x === endLead.x || startLead.y === endLead.y) {
            const direct = this.normalizePolyline([start, startLead, endLead, end]);
            if (this.isPathClear(direct, filteredObstacles)) {
                validCandidates.push(direct);
            }
        }

        const xCandidates = this.uniqueNumbers([
            startLead.x + 40,
            endLead.x - 40,
            Math.round((startLead.x + endLead.x) / 2),
            startLead.x + 120,
            endLead.x - 120,
            Math.max(startLead.x, endLead.x) + 120,
            Math.min(startLead.x, endLead.x) - 120
        ]);

        for (const x of xCandidates) {
            const candidate = [
                start,
                startLead,
                { x, y: startLead.y },
                { x, y: endLead.y },
                endLead,
                end
            ];
            const normalized = this.normalizePolyline(candidate);
            if (this.isPathClear(normalized, filteredObstacles)) {
                validCandidates.push(normalized);
            }
        }

        const yCandidates = this.uniqueNumbers([
            startLead.y - 80,
            startLead.y + 80,
            endLead.y - 80,
            endLead.y + 80,
            Math.round((startLead.y + endLead.y) / 2)
        ]);

        for (const y of yCandidates) {
            const candidate = [
                start,
                startLead,
                { x: startLead.x, y },
                { x: endLead.x, y },
                endLead,
                end
            ];
            const normalized = this.normalizePolyline(candidate);
            if (this.isPathClear(normalized, filteredObstacles)) {
                validCandidates.push(normalized);
            }
        }

        if (validCandidates.length > 0) {
            let best = validCandidates[0];
            let bestScore = this.routeScore(best, startLead, endLead);
            for (let index = 1; index < validCandidates.length; index++) {
                const candidate = validCandidates[index];
                const score = this.routeScore(candidate, startLead, endLead);
                if (score < bestScore) {
                    best = candidate;
                    bestScore = score;
                }
            }
            return best;
        }

        return this.normalizePolyline([
            start,
            startLead,
            { x: startLead.x + 120, y: startLead.y },
            { x: startLead.x + 120, y: endLead.y },
            endLead,
            end
        ]);
    }

    private offsetFromPort(anchor: { x: number; y: number; side: 'WEST' | 'EAST' }, distance: number): { x: number; y: number } {
        if (anchor.side === 'EAST') {
            return { x: anchor.x + distance, y: anchor.y };
        }
        return { x: anchor.x - distance, y: anchor.y };
    }

    private normalizePolyline(points: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> {
        const deduped: Array<{ x: number; y: number }> = [];
        for (const point of points) {
            const prev = deduped[deduped.length - 1];
            if (!prev || prev.x !== point.x || prev.y !== point.y) {
                deduped.push(point);
            }
        }
        return deduped.length >= 2 ? deduped : [points[0], points[points.length - 1]];
    }

    private uniqueNumbers(values: number[]): number[] {
        return [...new Set(values.map(v => Math.round(v)))];
    }

    private routeScore(
        points: Array<{ x: number; y: number }>,
        startLead: { x: number; y: number },
        endLead: { x: number; y: number }
    ): number {
        const length = this.polylineLength(points);
        const centerX = (startLead.x + endLead.x) / 2;
        const centerY = (startLead.y + endLead.y) / 2;
        let spreadPenalty = 0;
        for (const p of points) {
            spreadPenalty += Math.abs(p.x - centerX) * 0.05;
            spreadPenalty += Math.abs(p.y - centerY) * 0.08;
        }
        return length + spreadPenalty;
    }

    private polylineLength(points: Array<{ x: number; y: number }>): number {
        let total = 0;
        for (let i = 0; i < points.length - 1; i++) {
            const a = points[i];
            const b = points[i + 1];
            total += Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
        }
        return total;
    }

    private isPathClear(
        points: Array<{ x: number; y: number }>,
        obstacles: Array<{ id: string; left: number; right: number; top: number; bottom: number }>
    ): boolean {
        for (let i = 0; i < points.length - 1; i++) {
            const a = points[i];
            const b = points[i + 1];
            for (const rect of obstacles) {
                if (this.segmentIntersectsRect(a, b, rect)) {
                    return false;
                }
            }
        }
        return true;
    }

    private segmentIntersectsRect(
        a: { x: number; y: number },
        b: { x: number; y: number },
        rect: { left: number; right: number; top: number; bottom: number }
    ): boolean {
        if (a.x === b.x) {
            const x = a.x;
            const y1 = Math.min(a.y, b.y);
            const y2 = Math.max(a.y, b.y);
            const overlapY = y2 > rect.top && y1 < rect.bottom;
            return x > rect.left && x < rect.right && overlapY;
        }

        if (a.y === b.y) {
            const y = a.y;
            const x1 = Math.min(a.x, b.x);
            const x2 = Math.max(a.x, b.x);
            const overlapX = x2 > rect.left && x1 < rect.right;
            return y > rect.top && y < rect.bottom && overlapX;
        }

        return false;
    }

    private portAnchorInfo(portId: string): { x: number; y: number; side: 'WEST' | 'EAST' } | undefined {
        let port: GModelElement | undefined;
        try {
            port = this.modelState.index.get(portId);
        } catch {
            return undefined;
        }
        if (!(port instanceof GPort)) {
            return undefined;
        }

        const node = this.findParentNode(port);
        if (!node) {
            return undefined;
        }

        const nodePos = this.absolutePosition(node);
        const portPos = port.position ?? { x: 0, y: 0 };
        const w = port.size?.width && port.size.width > 0 ? port.size.width : WorkflowDiagramConstants.PORT_WIDTH_PX;
        const h = port.size?.height && port.size.height > 0 ? port.size.height : WorkflowDiagramConstants.PORT_HEIGHT_PX;

        const direction = (port as any).args?.[WorkflowDiagramMetadata.PORT_DIRECTION] as string | undefined;
        const side = direction === 'output' ? 'EAST'
            : direction === 'input' ? 'WEST'
            : port.type?.includes('output') ? 'EAST'
            : port.type?.includes('input') ? 'WEST'
            : 'WEST';

        const absPortX = nodePos.x + portPos.x;
        const absPortY = nodePos.y + portPos.y;
        const cy = absPortY + h / 2;

        if (side === 'EAST') {
            return { x: absPortX + w, y: cy, side: 'EAST' };
        }
        return { x: absPortX, y: cy, side: 'WEST' };
    }

    private findParentNode(element: GModelElement): GNode | undefined {
        let current: GModelElement | undefined = element;
        while (current) {
            if (current instanceof GNode) {
                return current;
            }
            current = (current as any).parent;
        }
        return undefined;
    }

    private absolutePosition(element: GModelElement): { x: number; y: number } {
        let x = 0;
        let y = 0;
        let current: GModelElement | undefined = element;
        while (current) {
            if (current instanceof GNode) {
                const pos = current.position;
                if (pos) {
                    x += pos.x;
                    y += pos.y;
                }
            }
            current = (current as any).parent;
        }
        return { x, y };
    }

    private orderNodesForSerpentine(nodes: any[], edges: Array<{ sourceNodeId: string; targetNodeId: string }>): string[] {
        const nodeIds = nodes.map(node => String(node.id));
        const byId = new Map(nodes.map(node => [String(node.id), node]));

        const outgoing = new Map<string, string[]>();
        const indegree = new Map<string, number>();
        const outdegree = new Map<string, number>();
        for (const id of nodeIds) {
            outgoing.set(id, []);
            indegree.set(id, 0);
            outdegree.set(id, 0);
        }

        for (const edge of edges) {
            if (!outgoing.has(edge.sourceNodeId) || !indegree.has(edge.targetNodeId)) {
                continue;
            }
            outgoing.get(edge.sourceNodeId)?.push(edge.targetNodeId);
            indegree.set(edge.targetNodeId, (indegree.get(edge.targetNodeId) ?? 0) + 1);
            outdegree.set(edge.sourceNodeId, (outdegree.get(edge.sourceNodeId) ?? 0) + 1);
        }

        const linear = nodeIds.length > 1
            && edges.length > 0
            && nodeIds.every(id => (indegree.get(id) ?? 0) <= 1 && (outdegree.get(id) ?? 0) <= 1);

        const posSort = (left: string, right: string): number => {
            const l = byId.get(left);
            const r = byId.get(right);
            const ly = l?.position?.y ?? 0;
            const ry = r?.position?.y ?? 0;
            if (ly !== ry) {
                return ly - ry;
            }
            const lx = l?.position?.x ?? 0;
            const rx = r?.position?.x ?? 0;
            if (lx !== rx) {
                return lx - rx;
            }
            return left.localeCompare(right);
        };

        if (!linear) {
            return [...nodeIds].sort(posSort);
        }

        const starts = nodeIds
            .filter(id => (indegree.get(id) ?? 0) === 0)
            .sort(posSort);

        const visited = new Set<string>();
        const ordered: string[] = [];

        const walk = (start: string): void => {
            let current: string | undefined = start;
            while (current && !visited.has(current)) {
                visited.add(current);
                ordered.push(current);
                const next = outgoing.get(current) ?? [];
                current = next.length > 0 ? next[0] : undefined;
            }
        };

        for (const start of starts) {
            walk(start);
        }

        for (const id of [...nodeIds].sort(posSort)) {
            if (!visited.has(id)) {
                walk(id);
            }
        }

        return ordered;
    }

    private isMovableNode(element: any): boolean {
        const type = element?.type as string | undefined;
        return typeof type === 'string' && type.startsWith('node:');
    }

    private isBoundaryNode(element: any): boolean {
        const type = element?.type as string | undefined;
        return type === WorkflowDiagramTypes.NODE_BOUNDARY_INPUT || type === WorkflowDiagramTypes.NODE_BOUNDARY_OUTPUT;
    }

    private isBoundaryInputNode(element: any): boolean {
        return (element?.type as string | undefined) === WorkflowDiagramTypes.NODE_BOUNDARY_INPUT;
    }

    private isBoundaryOutputNode(element: any): boolean {
        return (element?.type as string | undefined) === WorkflowDiagramTypes.NODE_BOUNDARY_OUTPUT;
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
