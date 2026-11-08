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

import { LayoutPersistenceService } from '../services/layout-persistence-service';
import { GModelSerializer } from '@eclipse-glsp/server';
import { persistLayout } from '../server/layout-snapshot';
import { portAnchorAbsolute } from '../routing/persisted-edge-routes';

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

    private normalizeToFullPolyline(edge: any, maybeIntermediate: { x: number; y: number }[]): { x: number; y: number }[] {
        const src = portAnchorAbsolute(this.modelState.index, edge?.sourceId);
        const tgt = portAnchorAbsolute(this.modelState.index, edge?.targetId);
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

    private async executeOperation(operation: ChangeRoutingPointsOperation): Promise<void> {
        let didApply = false;
        for (const entry of operation.newRoutingPoints) {
            didApply = this.applyRoutingPoints(entry) || didApply;
        }
        if (!didApply) {
            return;
        }

        // A route change alone: the node positions already on disk stand.
        await persistLayout(this.modelState, this.layoutPersistence, { keepPersistedPositions: true });
    }
}
