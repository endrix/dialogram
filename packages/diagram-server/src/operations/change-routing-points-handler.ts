import 'reflect-metadata';

import { ChangeRoutingPointsOperation, type ElementAndRoutingPoints } from '@eclipse-glsp/protocol';
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

import { WorkflowDiagramMetadata } from '@dialogram/shared';
import { LayoutPersistenceService } from '../services/layout-persistence-service';
import { WORKFLOW_LAYOUT_PERSISTENCE_KEY, WORKFLOW_NETWORK_MODEL_KEY } from '@dialogram/shared';
import { WorkflowDiagramConstants } from '@dialogram/shared';
import type { WorkflowDiagramModel } from '@dialogram/shared';
import { GModelSerializer } from '@eclipse-glsp/server';

@injectable()
export class WorkflowChangeRoutingPointsOperationHandler extends OperationHandler {
    override readonly operationType = ChangeRoutingPointsOperation.KIND;

    @inject(ModelState)
    protected override modelState!: ModelState;

    @inject(GModelSerializer)
    protected serializer!: GModelSerializer;

    @inject(LayoutPersistenceService)
    protected layoutPersistence!: LayoutPersistenceService;

    override createCommand(operation: ChangeRoutingPointsOperation): MaybePromise<Command | undefined> {
        return new GModelRecordingCommand(this.modelState, this.serializer, () => this.executeOperation(operation));
    }

    private simplifyRoutingPoints(points: { x: number; y: number }[]): { x: number; y: number }[] {
        if (!Array.isArray(points) || points.length <= 1) {
            return points;
        }

        // Tolerance in diagram coordinates.
        const eps = 0.5;

        const eq = (a: { x: number; y: number }, b: { x: number; y: number }): boolean =>
            Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps;

        // 1) Remove consecutive duplicates / near-duplicates.
        const deduped: { x: number; y: number }[] = [];
        for (const p of points) {
            if (deduped.length === 0 || !eq(deduped[deduped.length - 1], p)) {
                deduped.push(p);
            }
        }
        if (deduped.length <= 2) {
            return deduped;
        }

        // 2) Remove colinear middle points A->B->C where B lies on the line segment AC.
        const isColinear = (a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }): boolean => {
            // Cross product magnitude near 0 => colinear.
            const abx = b.x - a.x;
            const aby = b.y - a.y;
            const bcx = c.x - b.x;
            const bcy = c.y - b.y;
            const cross = abx * bcy - aby * bcx;
            if (Math.abs(cross) > eps) {
                return false;
            }
            // Also ensure B is between A and C (dot product).
            const acx = c.x - a.x;
            const acy = c.y - a.y;
            const dot = (b.x - a.x) * acx + (b.y - a.y) * acy;
            if (dot < 0) {
                return false;
            }
            const acLen2 = acx * acx + acy * acy;
            return dot <= acLen2;
        };

        const simplified: { x: number; y: number }[] = [];
        for (const p of deduped) {
            simplified.push(p);
            while (simplified.length >= 3) {
                const c = simplified[simplified.length - 1];
                const b = simplified[simplified.length - 2];
                const a = simplified[simplified.length - 3];
                if (isColinear(a, b, c)) {
                    simplified.splice(simplified.length - 2, 1);
                } else {
                    break;
                }
            }
        }

        return simplified;
    }

    private pointDistance(a: { x: number; y: number }, b: { x: number; y: number }): number {
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        return Math.sqrt(dx * dx + dy * dy);
    }

    private absolutePosition(element: any): { x: number; y: number } {
        let x = 0;
        let y = 0;
        let cur: any = element;
        while (cur) {
            const p = cur.position as { x?: number; y?: number } | undefined;
            if (p) {
                x += p.x ?? 0;
                y += p.y ?? 0;
            }
            cur = cur.parent;
        }
        return { x, y };
    }

    private portAnchorAbsolute(portId: string): { x: number; y: number } | undefined {
        const port: any = this.modelState.index.find(portId);
        if (!port) {
            return undefined;
        }
        // Find containing node (ports are typically children of nodes).
        let node: any = port;
        while (node && !(node as any).type?.startsWith?.('node:')) {
            node = node.parent;
        }
        if (!node) {
            return undefined;
        }

        const nodeAbs = this.absolutePosition(node);
        const portRel = (port.position as { x?: number; y?: number } | undefined) ?? { x: 0, y: 0 };
        const fallbackPortWidth = WorkflowDiagramConstants.PORT_WIDTH_PX;
        const fallbackPortHeight = WorkflowDiagramConstants.PORT_HEIGHT_PX;
        const w = (port.size?.width && port.size.width > 0) ? port.size.width : fallbackPortWidth;
        const h = (port.size?.height && port.size.height > 0) ? port.size.height : fallbackPortHeight;

        const direction = (port as any).args?.['cal:portDirection'] as string | undefined;
        const side = direction === 'output' ? 'EAST'
            : direction === 'input' ? 'WEST'
            : (port.type as string | undefined)?.includes('output') ? 'EAST'
            : (port.type as string | undefined)?.includes('input') ? 'WEST'
            : 'WEST';

        const absPortX = nodeAbs.x + (portRel.x ?? 0);
        const absPortY = nodeAbs.y + (portRel.y ?? 0);
        const cx = absPortX + w / 2;
        const cy = absPortY + h / 2;

        switch (side) {
            case 'WEST':
                return { x: absPortX, y: cy };
            case 'EAST':
                return { x: absPortX + w, y: cy };
            default:
                return { x: cx, y: cy };
        }
    }

    private normalizeToFullPolyline(edge: any, maybeIntermediate: { x: number; y: number }[]): { x: number; y: number }[] {
        const src = typeof edge?.sourceId === 'string' ? this.portAnchorAbsolute(edge.sourceId) : undefined;
        const tgt = typeof edge?.targetId === 'string' ? this.portAnchorAbsolute(edge.targetId) : undefined;
        if (!src || !tgt) {
            return maybeIntermediate;
        }

        const pts = Array.isArray(maybeIntermediate) ? maybeIntermediate : [];
        if (pts.length >= 2) {
            const d0 = this.pointDistance(pts[0], src);
            const dN = this.pointDistance(pts[pts.length - 1], tgt);
            // Heuristic: if the endpoints are already close to port anchors, assume it's a full polyline.
            if (d0 <= 20 && dN <= 20) {
                return pts;
            }
        }

        // Otherwise interpret provided points as intermediate bendpoints.
        const full = [src, ...pts, tgt];
        return full;
    }

    private applyRoutingPoints(entry: ElementAndRoutingPoints): boolean {
        const edge = this.modelState.index.findByClass(entry.elementId, GEdge);
        if (!edge) {
            return false;
        }

        const raw = (entry.newRoutingPoints ?? []).map(p => ({ x: p.x, y: p.y }));
        const full = this.normalizeToFullPolyline(edge, raw);
        const points = this.simplifyRoutingPoints(full);

        // Full polyline including endpoint anchors.
        (edge as any).routingPoints = points.length >= 2 ? points : undefined;

        // Mark as manually adjusted so interactive reroute doesn't wipe it "from scratch".
        (edge as any).args = (edge as any).args ?? {};
        if ((edge as any).routingPoints) {
            (edge as any).args['cal:manualRoute'] = true;
        } else {
            delete (edge as any).args['cal:manualRoute'];
        }
        return true;
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

    private async executeOperation(operation: ChangeRoutingPointsOperation): Promise<void> {
        let didApply = false;
        for (const entry of operation.newRoutingPoints) {
            didApply = this.applyRoutingPoints(entry) || didApply;
        }
        if (!didApply) {
            return;
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

        // Prefer persisted positions (stable keys) and only update routes.
        const persistedPositions = await this.layoutPersistence.loadLayout(workflowFilePath, networkId);
        const positions = persistedPositions ?? this.collectNodePositions(this.modelState.root);
        const routes = this.collectEdgeRoutes(this.modelState.root);

        await this.layoutPersistence.saveLayoutImmediate(workflowFilePath, networkId, positions, routes);

        const layoutMeta = this.modelState.get(WORKFLOW_LAYOUT_PERSISTENCE_KEY) as
            | {
                  hasPersistedEdgeRoutes: boolean;
              }
            | undefined;
        if (layoutMeta) {
            layoutMeta.hasPersistedEdgeRoutes = routes.size > 0;
            this.modelState.set(WORKFLOW_LAYOUT_PERSISTENCE_KEY, layoutMeta);
        }
    }
}
