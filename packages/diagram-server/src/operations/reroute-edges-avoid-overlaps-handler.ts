import { Operation } from '@eclipse-glsp/protocol';
import {
    GEdge,
    GGraph,
    GModelRecordingCommand,
    GNode,
    GPort,
    ModelState,
    OperationHandler,
    type Command,
    type MaybePromise
} from '@eclipse-glsp/server';
import { inject, injectable } from 'inversify';
import { LayoutPersistenceService } from '../services/layout-persistence-service';
import { WORKFLOW_NETWORK_MODEL_KEY } from '@dialogram/shared';
import type { WorkflowDiagramModel } from '@dialogram/shared';
import { WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import { WorkflowDiagramConstants, portAnchor } from '@dialogram/shared';
import { GModelSerializer } from '@eclipse-glsp/server';
import { routeOrthogonal, type RouterConnector, type RouterObstacle } from '../routing/libavoid-router';
import { layoutTargetOf } from '../server/layout-target';

/** Every segment axis-aligned? A diagonal means the polyline is not a valid route. */
export function isOrthogonalPolyline(points: readonly { x: number; y: number }[]): boolean {
    for (let i = 1; i < points.length; i++) {
        const dx = Math.abs(points[i].x - points[i - 1].x);
        const dy = Math.abs(points[i].y - points[i - 1].y);
        if (dx > 0.5 && dy > 0.5) {
            return false;
        }
    }
    return true;
}

interface RerouteTiming {
    anchorMs: number;
    routeMs: number;
    persistMs: number;
    /**
     * `slide` means no router ran because none was needed: every edge kept
     * its route, with its ends moved onto the ports. That is the fast path
     * working, not a failure.
     */
    router: 'libavoid' | 'manhattan' | 'slide' | 'none';
}

export const WORKFLOW_REROUTE_EDGES_AVOID_OVERLAPS_OPERATION_KIND = 'dialogram.rerouteEdgesAvoidOverlaps' as const;

export interface WorkflowRerouteEdgesAvoidOverlapsOperation extends Operation {
    kind: typeof WORKFLOW_REROUTE_EDGES_AVOID_OVERLAPS_OPERATION_KIND;
    /** If empty/undefined, reroutes all edges in the diagram. */
    elementIds?: string[];
    /** Optional: current drag positions so routing matches interactive preview. */
    movedElements?: { elementId: string; position: { x: number; y: number } }[];
    /** When true, update routes but skip persistence (drag preview). */
    preview?: boolean;
    /**
     * Optional source tag for server-side callers.
     * - 'client' (default): client-issued reroute operation
     * - 'changeBounds': reroute triggered by ChangeBounds (e.g. keyboard nudge)
     */
    source?: 'client' | 'changeBounds';
    /** Client clock at dispatch — end-to-end timing only. */
    clientDispatchedAt?: number;
    /** Which client path armed this reroute. */
    trigger?: 'finished' | 'quiet' | 'requeue';
}

/**
 * Obstacle-aware Manhattan (orthogonal) edge router.
 *
 * This handler computes edge routes directly from port anchor positions and
 * node bounding-boxes.  It does NOT call ELK — edges are routed purely with
 * geometry, guaranteeing that:
 *   - Nodes never move.
 *   - Edge segments are always horizontal or vertical.
 *   - Edges route around (not through) non-endpoint nodes.
 */
@injectable()
export class WorkflowRerouteEdgesAvoidOverlapsOperationHandler extends OperationHandler {
    override readonly operationType = WORKFLOW_REROUTE_EDGES_AVOID_OVERLAPS_OPERATION_KIND;

    @inject(ModelState)
    protected override modelState!: ModelState;

    @inject(GModelSerializer)
    protected serializer!: GModelSerializer;

    @inject(LayoutPersistenceService)
    protected layoutPersistence!: LayoutPersistenceService;

    override createCommand(operation: WorkflowRerouteEdgesAvoidOverlapsOperation): MaybePromise<Command | undefined> {
        if (!this.timeReroute) {
            return new GModelRecordingCommand(this.modelState, this.serializer, () => this.executeOperation(operation));
        }
        // GModelRecordingCommand deep-clones and JSON-diffs the WHOLE model around
        // doExecute, so the gap between `inner` and `command` below is pure
        // bookkeeping overhead — on a large graph it can dwarf the routing itself.
        const arrivedAt = Date.now();
        const transit = operation.clientDispatchedAt ? arrivedAt - operation.clientDispatchedAt : undefined;
        let innerMs = 0;
        const timing: RerouteTiming = { routeMs: 0, router: 'none', anchorMs: 0, persistMs: 0 };
        const cmd = new GModelRecordingCommand(this.modelState, this.serializer, async () => {
            const t = Date.now();
            await this.executeOperation(operation, timing);
            innerMs = Date.now() - t;
        });
        const originalExecute = cmd.execute.bind(cmd);
        (cmd as any).execute = async () => {
            const t = Date.now();
            await originalExecute();
            const commandMs = Date.now() - t;
            console.info('[cal-reroute timing]', {
                trigger: operation.trigger ?? '(none)',
                preview: Boolean(operation.preview),
                edges: operation.elementIds?.length ?? 'all',
                clientToServerMs: transit,
                anchorMs: timing.anchorMs,
                routeMs: timing.routeMs,
                persistMs: timing.persistMs,
                executeMs: innerMs,
                recordingOverheadMs: commandMs - innerMs,
                totalServerMs: commandMs,
                router: timing.router
            });
        };
        return cmd;
    }

    /**
     * Internal entrypoint for other server handlers (e.g. ChangeBounds) to reroute
     * without going through the operation dispatch pipeline.
     */
    async runReroute(operation: WorkflowRerouteEdgesAvoidOverlapsOperation): Promise<void> {
        await this.executeOperation(operation);
    }

    private readonly debugReroute: number = Number(process.env.WORKFLOW_DIAGRAM_DEBUG_REROUTE ?? '0') || 0;

    /**
     * Which router computes the routes an edge cannot keep (see `slideRoute`).
     *
     * libavoid, routing the edges on one port as one shared path: that is
     * what the layout drew, a trunk into the port, and what the built-in
     * router cannot draw, since it gives every edge its own channel. libavoid
     * also measures better on crossings, overlaps, bends and length. What
     * made it worse on a real drag before was the stagger of the endpoints on
     * a port, which turned every fan-in into a comb; `sharedPortPaths` is the
     * cure. The built-in router remains the fallback when libavoid is
     * unavailable or cannot solve an edge, and the choice for a reroute of
     * every edge in a large diagram, since libavoid's cost is superlinear in
     * the connector count (58 edges 337ms).
     *
     *   WORKFLOW_DIAGRAM_ROUTER=manhattan   the built-in router throughout
     */
    private readonly useLibavoid: boolean =
        (process.env.WORKFLOW_DIAGRAM_ROUTER ?? '').toLowerCase() !== 'manhattan';
    /** A reroute of every edge goes to libavoid only up to this many edges. */
    private static readonly LIBAVOID_MAX_EDGES = 200;

    /**
     * `WORKFLOW_DIAGRAM_DUMP_ROUTING=1` writes the exact router input — node
     * boxes and port anchors, in absolute coordinates — to a JSON file per
     * reroute. That file is enough to replay a drag offline against either
     * router, which is what the harness was missing.
     */
    private readonly dumpRoutingInput: boolean = process.env.WORKFLOW_DIAGRAM_DUMP_ROUTING === '1';

    /** `WORKFLOW_DIAGRAM_TIME_REROUTE=1` logs the full drag -> visible-edges timing. */
    private readonly timeReroute: boolean = process.env.WORKFLOW_DIAGRAM_TIME_REROUTE === '1';

    /**
     * Per-call timing. Deliberately NOT instance state: reroutes overlap during a
     * drag, and shared fields report another call's numbers (which is how this
     * first showed routeMs > executeMs, an impossibility).
     */

    // ═══════════════════════════════════════════════════════════════════
    // Graph traversal helpers
    // ═══════════════════════════════════════════════════════════════════

    private applyMovedElements(root: GGraph, operation: WorkflowRerouteEdgesAvoidOverlapsOperation): void {
        const moved = Array.isArray(operation.movedElements) ? operation.movedElements : [];
        for (const entry of moved) {
            const id = (entry as any)?.elementId;
            const pos = (entry as any)?.position;
            if (typeof id !== 'string' || !pos) { continue; }
            const x = Number((pos as any).x);
            const y = Number((pos as any).y);
            if (!Number.isFinite(x) || !Number.isFinite(y)) { continue; }
            const el = this.modelState.index.find(id);
            if (el) { (el as any).position = { x, y }; }
        }
    }

    private absPos(element: any): { x: number; y: number } {
        let x = 0;
        let y = 0;
        let current = element;
        while (current) {
            if (current.position) {
                x += Number(current.position.x) || 0;
                y += Number(current.position.y) || 0;
            }
            current = current.parent;
        }
        return { x, y };
    }

    private sizeOf(element: any): { width: number; height: number } {
        const w = element?.size?.width ?? element?.bounds?.width ?? 0;
        const h = element?.size?.height ?? element?.bounds?.height ?? 0;
        return { width: Number.isFinite(w) ? w : 0, height: Number.isFinite(h) ? h : 0 };
    }

    private portAnchorInfo(portId: string): { x: number; y: number; side: 'WEST' | 'EAST'; nodeId: string | undefined } | undefined {
        const port = this.modelState.index.find(portId);
        if (!(port instanceof GPort)) { return undefined; }
        const parentNode = this.findParentNode(port);
        if (!parentNode) { return undefined; }

        // Shared geometry — the webview's live router must land on the same
        // anchor or edges jump when the mouse is released.
        const anchor = portAnchor({
            absolute: this.absPos(port),
            size: this.sizeOf(port),
            direction: (port as any).args?.[WorkflowDiagramMetadata.PORT_DIRECTION] as string | undefined,
            side: (port as any).args?.[WorkflowDiagramMetadata.PORT_SIDE] as string | undefined,
            type: port.type
        });
        return { ...anchor, nodeId: String((parentNode as any).id) };
    }

    private findParentNode(element: any): GNode | undefined {
        let current = element?.parent;
        while (current) {
            if (current instanceof GNode) { return current; }
            current = current.parent;
        }
        return undefined;
    }

    /** Resolve any element id (node/port/child) to the id of its enclosing node. */
    private nodeIdForElement(elementId: string): string | undefined {
        let cur: any = this.modelState.index.find(elementId);
        while (cur) {
            const t = cur.type as string | undefined;
            if (typeof t === 'string' && t.startsWith('node:')) { return String(cur.id); }
            cur = cur.parent;
        }
        return undefined;
    }

    private shouldRerouteEdge(edge: GEdge, selectedIds: Set<string>, resetAll: boolean): boolean {
        if (resetAll) { return true; }
        const edgeId = String(edge.id);
        if (selectedIds.has(edgeId)) { return true; }
        const sourceId = edge.sourceId as string | undefined;
        const targetId = edge.targetId as string | undefined;
        if (typeof sourceId === 'string' && selectedIds.has(sourceId)) { return true; }
        if (typeof targetId === 'string' && selectedIds.has(targetId)) { return true; }
        // Traverse parents.
        for (const endId of [sourceId, targetId]) {
            if (typeof endId === 'string') {
                let current: any = this.modelState.index.find(endId);
                while (current) {
                    if (selectedIds.has(String(current.id))) { return true; }
                    current = current.parent;
                }
            }
        }
        return false;
    }

    /** Return node IDs that an edge's endpoints belong to (excluded from obstacles). */
    private edgeEndpointNodeIds(edge: GEdge): Set<string> {
        const ids = new Set<string>();
        for (const endId of [edge.sourceId, edge.targetId]) {
            if (!endId) { continue; }
            const el = this.modelState.index.find(endId);
            if (el instanceof GNode) { ids.add(String((el as any).id)); }
            else if (el instanceof GPort) {
                const n = this.findParentNode(el);
                if (n) { ids.add(String((n as any).id)); }
            }
        }
        return ids;
    }

    // ═══════════════════════════════════════════════════════════════════
    // Obstacle-aware Manhattan edge router
    // ═══════════════════════════════════════════════════════════════════

    private static readonly PAD = 15;      // obstacle padding around node boxes
    /** The shortest stub a kept route may leave a port on (see `slideRoute`). */
    private static readonly MIN_STUB_PX = 8;
    private static readonly STUB = 25;     // horizontal stub length from ports
    private static readonly EDGE_GAP = 8;  // px between parallel edges in same channel

    /** Collect padded bounding boxes for all GNodes in the graph. */
    private collectObstacles(
        root: GGraph,
        pad: number = WorkflowRerouteEdgesAvoidOverlapsOperationHandler.PAD
    ): Array<{ id: string; x: number; y: number; r: number; b: number }> {
        const obs: Array<{ id: string; x: number; y: number; r: number; b: number }> = [];
        const visit = (el: any): void => {
            // A group is a region, not an obstacle: its members are the
            // obstacles, and an edge inside it, or one passing through its
            // frame at a boundary port, has to be able to cross its box.
            if (el instanceof GNode && el.position && el.type !== WorkflowDiagramTypes.NODE_GROUP) {
                const pos = this.absPos(el);
                const sz = this.sizeOf(el);
                if (sz.width > 0 && sz.height > 0) {
                    obs.push({
                        id: String((el as any).id),
                        x: pos.x - pad,
                        y: pos.y - pad,
                        r: pos.x + sz.width + pad,
                        b: pos.y + sz.height + pad,
                    });
                }
            }
            const ch = (el as any).children as any[] | undefined;
            if (Array.isArray(ch)) { for (const c of ch) { visit(c); } }
        };
        visit(root);
        return obs;
    }

    /** Does a horizontal segment at y from x1→x2 intersect any obstacle?
     *  @param excludeId  optional obstacle id to skip (e.g. endpoint node). */
    private hBlocked(
        x1: number, x2: number, y: number,
        obs: ReadonlyArray<{ id?: string; x: number; y: number; r: number; b: number }>,
        excludeId?: string
    ): boolean {
        const lo = Math.min(x1, x2);
        const hi = Math.max(x1, x2);
        for (const o of obs) {
            if (excludeId && (o as any).id === excludeId) { continue; }
            if (y > o.y && y < o.b && hi > o.x && lo < o.r) { return true; }
        }
        return false;
    }

    /** Does a vertical segment at x from y1→y2 intersect any obstacle?
     *  @param excludeId  optional obstacle id to skip. */
    private vBlocked(
        x: number, y1: number, y2: number,
        obs: ReadonlyArray<{ id?: string; x: number; y: number; r: number; b: number }>,
        excludeId?: string
    ): boolean {
        const lo = Math.min(y1, y2);
        const hi = Math.max(y1, y2);
        for (const o of obs) {
            if (excludeId && (o as any).id === excludeId) { continue; }
            if (x > o.x && x < o.r && hi > o.y && lo < o.b) { return true; }
        }
        return false;
    }

    /** Does an orthogonal segment a→b pass through a single node box? */
    private segmentHitsBox(
        a: { x: number; y: number },
        b: { x: number; y: number },
        box: { x: number; y: number; r: number; b: number }
    ): boolean {
        if (Math.abs(a.y - b.y) < 0.5) {            // horizontal
            const y = a.y;
            const x1 = Math.min(a.x, b.x);
            const x2 = Math.max(a.x, b.x);
            return y > box.y && y < box.b && x2 > box.x && x1 < box.r;
        }
        if (Math.abs(a.x - b.x) < 0.5) {            // vertical
            const x = a.x;
            const y1 = Math.min(a.y, b.y);
            const y2 = Math.max(a.y, b.y);
            return x > box.x && x < box.r && y2 > box.y && y1 < box.b;
        }
        return false;
    }

    // ── Channel registry (prevents parallel edge overlap) ──────────────

    /**
     * Tracks which X positions are occupied by vertical segments and which
     * Y positions by horizontal segments.  When a new edge wants to use a
     * channel that's already taken, it is offset by EDGE_GAP.
     */
    private allocateChannel(
        desired: number,
        registry: number[],
        gap: number
    ): number {
        // Find all occupied positions "close" to desired.
        const nearby = registry.filter(v => Math.abs(v - desired) < gap * 0.9);
        if (nearby.length === 0) {
            registry.push(desired);
            return desired;
        }
        // Offset alternately: +gap, -gap, +2gap, -2gap, …
        for (let m = 1; m <= nearby.length + 5; m++) {
            for (const sign of [1, -1]) {
                const candidate = desired + sign * m * gap;
                if (!registry.some(v => Math.abs(v - candidate) < gap * 0.9)) {
                    registry.push(candidate);
                    return candidate;
                }
            }
        }
        // Should never happen; fall through.
        const fb = desired + (nearby.length + 1) * gap;
        registry.push(fb);
        return fb;
    }

    /**
     * Compute an orthogonal route from source to target, avoiding obstacles.
     *
     * Strategy (for EAST→WEST, forward connection):
     *   src ──stub──→ (midX, srcY) ──vertical──→ (midX, tgtY) ──stub──→ tgt
     *
     * If the vertical channel at midX is blocked, scan obstacle boundaries
     * for a clear channel.  If nothing works, route around all obstacles
     * via the top or bottom of the diagram.
     *
     * For backward edges (target left of source) or same-side ports, routes
     * loop around via top/bottom.
     *
     * All chosen vertical/horizontal channels are registered in `vChannels`
     * / `hChannels` so subsequent edges get offset instead of overlapping.
     */
    private computeRoute(
        src: { x: number; y: number; side: 'WEST' | 'EAST'; nodeId: string | undefined },
        tgt: { x: number; y: number; side: 'WEST' | 'EAST'; nodeId: string | undefined },
        allObs: ReadonlyArray<{ id: string; x: number; y: number; r: number; b: number }>,
        excludeIds: Set<string>,
        vChannels: number[],
        hChannels: number[]
    ): Array<{ x: number; y: number }> {
        const stub = WorkflowRerouteEdgesAvoidOverlapsOperationHandler.STUB;
        const gap = WorkflowRerouteEdgesAvoidOverlapsOperationHandler.EDGE_GAP;

        // Use ALL obstacles for middle-segment routing (no exclusion).
        const obs = allObs;

        // Compute stub exit/entry that clears the endpoint node's padded box.
        const srcBox = src.nodeId ? allObs.find(o => o.id === src.nodeId) : undefined;
        const tgtBox = tgt.nodeId ? allObs.find(o => o.id === tgt.nodeId) : undefined;

        let srcExit: number;
        if (src.side === 'EAST') {
            srcExit = srcBox ? Math.max(src.x + stub, srcBox.r + 5) : src.x + stub;
        } else {
            srcExit = srcBox ? Math.min(src.x - stub, srcBox.x - 5) : src.x - stub;
        }
        let tgtEntry: number;
        if (tgt.side === 'WEST') {
            tgtEntry = tgtBox ? Math.min(tgt.x - stub, tgtBox.x - 5) : tgt.x - stub;
        } else {
            tgtEntry = tgtBox ? Math.max(tgt.x + stub, tgtBox.r + 5) : tgt.x + stub;
        }

        // ── Forward: source EAST, target WEST, enough horizontal room ──
        if (src.side === 'EAST' && tgt.side === 'WEST' && srcExit < tgtEntry) {
            // Straight horizontal (same Y)?
            if (Math.abs(src.y - tgt.y) < 1 && !this.hBlocked(srcExit, tgtEntry, src.y, obs)) {
                // Register horizontal channel
                this.allocateChannel(src.y, hChannels, gap);
                return this.clean([
                    { x: src.x, y: src.y },
                    { x: tgt.x, y: tgt.y },
                ]);
            }

            // Try midpoint, then scan for clear vertical channel.
            const midDefault = (srcExit + tgtEntry) / 2;
            const candidates: number[] = [midDefault];
            for (const o of obs) {
                candidates.push(o.x - 5);
                candidates.push(o.r + 5);
            }
            // Evenly spaced probes.
            const step = 20;
            for (let cx = srcExit + step; cx < tgtEntry; cx += step) {
                candidates.push(cx);
            }

            for (const rawMidX of candidates) {
                if (rawMidX < srcExit - 5 || rawMidX > tgtEntry + 5) { continue; }
                // Probe with raw candidate first — do NOT allocate yet.
                if (!this.try5Route(src, srcExit, tgt, tgtEntry, rawMidX, obs)) { continue; }
                // Raw position is clear. Allocate channel (may offset).
                const midX = this.allocateChannel(rawMidX, vChannels, gap);
                // Re-verify the allocated (possibly offset) position.
                if (midX < srcExit - 5 || midX > tgtEntry + 5
                    || !this.try5Route(src, srcExit, tgt, tgtEntry, midX, obs)) {
                    // Allocated position is blocked — can't use this candidate.
                    // (Channel is burned, but that's acceptable for the offset position.)
                    continue;
                }
                this.allocateChannel(src.y, hChannels, gap);
                this.allocateChannel(tgt.y, hChannels, gap);
                return this.clean([
                    { x: src.x, y: src.y },
                    { x: srcExit, y: src.y },
                    { x: midX, y: src.y },
                    { x: midX, y: tgt.y },
                    { x: tgtEntry, y: tgt.y },
                    { x: tgt.x, y: tgt.y },
                ]);
            }

            // No clear forward channel — grid-based shortest-path router.
            return this.gridRoute(src, srcExit, tgt, tgtEntry, obs, vChannels, hChannels);
        }

        // ── Tight forward: target is genuinely to the right (src.x < tgt.x) but the
        //    nodes are so close that the exit/entry stubs overlap (srcExit >=
        //    tgtEntry), so the forward block above was skipped. Route a simple S
        //    through the gap midpoint instead of the large detour gridRoute makes.
        //    Only used when that route is obstacle-clear; otherwise fall through. ──
        if (src.side === 'EAST' && tgt.side === 'WEST' && src.x < tgt.x) {
            const midX = (src.x + tgt.x) / 2;
            if (!this.hBlocked(src.x, midX, src.y, obs)
                && !this.vBlocked(midX, src.y, tgt.y, obs)
                && !this.hBlocked(midX, tgt.x, tgt.y, obs)) {
                this.allocateChannel(midX, vChannels, gap);
                return this.clean([
                    { x: src.x, y: src.y },
                    { x: midX, y: src.y },
                    { x: midX, y: tgt.y },
                    { x: tgt.x, y: tgt.y },
                ]);
            }
        }

        // ── Backward or same-side — grid-based shortest-path router ──
        return this.gridRoute(src, srcExit, tgt, tgtEntry, obs, vChannels, hChannels);
    }

    /**
     * Try a 5-point route through a vertical channel at midX.
     * Returns the route if fully unblocked, or undefined.
     */
    private try5Route(
        src: { x: number; y: number; nodeId?: string }, srcExit: number,
        tgt: { x: number; y: number; nodeId?: string }, tgtEntry: number,
        midX: number,
        obs: ReadonlyArray<{ id?: string; x: number; y: number; r: number; b: number }>
    ): Array<{ x: number; y: number }> | undefined {
        const minY = Math.min(src.y, tgt.y);
        const maxY = Math.max(src.y, tgt.y);

        // All three segments must avoid ALL obstacles (including endpoint nodes).
        // The stubs (port → srcExit, tgtEntry → port) are emitted but never
        // checked — those naturally pass alongside/through the endpoint node.
        if (this.hBlocked(Math.min(srcExit, midX), Math.max(srcExit, midX), src.y, obs)) {
            return undefined;
        }
        if (this.vBlocked(midX, minY, maxY, obs)) {
            return undefined;
        }
        if (this.hBlocked(Math.min(midX, tgtEntry), Math.max(midX, tgtEntry), tgt.y, obs)) {
            return undefined;
        }

        return this.clean([
            { x: src.x, y: src.y },
            { x: srcExit, y: src.y },
            { x: midX, y: src.y },
            { x: midX, y: tgt.y },
            { x: tgtEntry, y: tgt.y },
            { x: tgt.x, y: tgt.y },
        ]);
    }

    /**
     * Route around all obstacles by going above or below the obstacle field.
     * Works for backward connections and any case where a clear forward
     * channel cannot be found.
     */
    private routeAround(
        src: { x: number; y: number }, srcExit: number,
        tgt: { x: number; y: number }, tgtEntry: number,
        obs: ReadonlyArray<{ x: number; y: number; r: number; b: number }>
    ): Array<{ x: number; y: number }> {
        let top = Infinity;
        let bot = -Infinity;
        for (const o of obs) {
            top = Math.min(top, o.y);
            bot = Math.max(bot, o.b);
        }
        if (!Number.isFinite(top)) { top = Math.min(src.y, tgt.y) - 60; }
        if (!Number.isFinite(bot)) { bot = Math.max(src.y, tgt.y) + 60; }

        const avgY = (src.y + tgt.y) / 2;
        const topDetour = top - 30;
        const botDetour = bot + 30;
        const detourY = Math.abs(avgY - topDetour) <= Math.abs(avgY - botDetour)
            ? topDetour : botDetour;

        return this.clean([
            { x: src.x, y: src.y },
            { x: srcExit, y: src.y },
            { x: srcExit, y: detourY },
            { x: tgtEntry, y: detourY },
            { x: tgtEntry, y: tgt.y },
            { x: tgt.x, y: tgt.y },
        ]);
    }

    /**
     * Grid-based obstacle-aware shortest-path router (Dijkstra).
     *
     * Builds a visibility grid from obstacle boundaries, then finds the
     * minimum-bend path from (srcExit, srcY) to (tgtEntry, tgtY) while
     * avoiding ALL obstacles.  Unlike the previous ad-hoc cascade of
     * U-route / step-around / routeAround, this is provably correct:
     * every segment of the returned path is guaranteed obstacle-free.
     *
     * Cost function: 100 000 × bends + Manhattan distance.
     * This produces the path with the fewest turns; among equal-bend
     * paths, the shortest one wins.
     *
     * Falls back to the raw routeAround (global detour) only if the
     * grid search finds no path at all (should never happen with the
     * margin grid lines added around the obstacle field).
     */
    private gridRoute(
        src: { x: number; y: number; nodeId?: string }, srcExit: number,
        tgt: { x: number; y: number; nodeId?: string }, tgtEntry: number,
        obs: ReadonlyArray<{ id?: string; x: number; y: number; r: number; b: number }>,
        vChannels: number[],
        hChannels: number[]
    ): Array<{ x: number; y: number }> {
        const gap = WorkflowRerouteEdgesAvoidOverlapsOperationHandler.EDGE_GAP;

        // ── 1. Build visibility grid ─────────────────────────────────
        const xSet = new Set<number>([srcExit, tgtEntry]);
        const ySet = new Set<number>([src.y, tgt.y]);
        for (const o of obs) {
            xSet.add(o.x - 5);  // routing lane left of obstacle
            xSet.add(o.r + 5);  // routing lane right of obstacle
            ySet.add(o.y - 5);  // routing lane above obstacle
            ySet.add(o.b + 5);  // routing lane below obstacle
        }
        // Margins so the router can wrap around the whole obstacle field.
        let gTop = Infinity, gBot = -Infinity;
        let gLeft = Infinity, gRight = -Infinity;
        for (const o of obs) {
            gTop = Math.min(gTop, o.y);
            gBot = Math.max(gBot, o.b);
            gLeft = Math.min(gLeft, o.x);
            gRight = Math.max(gRight, o.r);
        }
        if (Number.isFinite(gTop)) { ySet.add(gTop - 30); }
        if (Number.isFinite(gBot)) { ySet.add(gBot + 30); }
        if (Number.isFinite(gLeft)) { xSet.add(gLeft - 30); }
        if (Number.isFinite(gRight)) { xSet.add(gRight + 30); }

        const xs = [...xSet].sort((a, b) => a - b);
        const ys = [...ySet].sort((a, b) => a - b);
        const C = xs.length;  // columns
        const R = ys.length;  // rows

        const sxi = xs.indexOf(srcExit);
        const syi = ys.indexOf(src.y);
        const txi = xs.indexOf(tgtEntry);
        const tyi = ys.indexOf(tgt.y);

        // ── 2. Pre-compute segment clearance ─────────────────────────
        //   hOK[yi * (C-1) + xi]  = 1 iff H from xs[xi]→xs[xi+1] at ys[yi] is clear
        //   vOK[xi * (R-1) + yi]  = 1 iff V from ys[yi]→ys[yi+1] at xs[xi] is clear
        const hOK = new Uint8Array(R * (C - 1));
        for (let yi = 0; yi < R; yi++) {
            for (let xi = 0; xi < C - 1; xi++) {
                hOK[yi * (C - 1) + xi] = this.hBlocked(xs[xi], xs[xi + 1], ys[yi], obs) ? 0 : 1;
            }
        }
        const vOK = new Uint8Array(C * (R - 1));
        for (let xi = 0; xi < C; xi++) {
            for (let yi = 0; yi < R - 1; yi++) {
                vOK[xi * (R - 1) + yi] = this.vBlocked(xs[xi], ys[yi], ys[yi + 1], obs) ? 0 : 1;
            }
        }

        // ── 3. Dijkstra ──────────────────────────────────────────────
        // State = (xi, yi, dir)  where dir: 0=start 1=H 2=V
        const BEND = 100000;
        const N = C * R * 3;
        const dist = new Float64Array(N).fill(Infinity);
        const prev = new Int32Array(N).fill(-1);

        // Binary min-heap keyed by dist[]
        const heap: number[] = [];
        const hUp = (i: number): void => {
            while (i > 0) {
                const p = (i - 1) >> 1;
                if (dist[heap[p]] <= dist[heap[i]]) break;
                [heap[p], heap[i]] = [heap[i], heap[p]];
                i = p;
            }
        };
        const hDn = (i: number): void => {
            const n = heap.length;
            while (true) {
                let m = i;
                const l = 2 * i + 1, r = 2 * i + 2;
                if (l < n && dist[heap[l]] < dist[heap[m]]) m = l;
                if (r < n && dist[heap[r]] < dist[heap[m]]) m = r;
                if (m === i) break;
                [heap[i], heap[m]] = [heap[m], heap[i]];
                i = m;
            }
        };
        const push = (s: number): void => { heap.push(s); hUp(heap.length - 1); };
        const pop = (): number => {
            const top = heap[0];
            const last = heap.pop()!;
            if (heap.length > 0) { heap[0] = last; hDn(0); }
            return top;
        };

        const key = (xi: number, yi: number, d: number): number => (yi * C + xi) * 3 + d;

        const startS = key(sxi, syi, 0);
        dist[startS] = 0;
        push(startS);

        let found = false;
        while (heap.length > 0) {
            const cur = pop();
            const cd = cur % 3;
            const gi = (cur - cd) / 3;
            const cy = Math.floor(gi / C);
            const cx = gi - cy * C;

            if (dist[cur] === Infinity) break;          // unreachable
            if (cx === txi && cy === tyi) { found = true; break; }

            // Relax: right
            if (cx < C - 1 && hOK[cy * (C - 1) + cx]) {
                const nd = 1;
                const nc = dist[cur] + Math.abs(xs[cx + 1] - xs[cx]) + ((cd !== 0 && cd !== nd) ? BEND : 0);
                const ns = key(cx + 1, cy, nd);
                if (nc < dist[ns]) { dist[ns] = nc; prev[ns] = cur; push(ns); }
            }
            // left
            if (cx > 0 && hOK[cy * (C - 1) + (cx - 1)]) {
                const nd = 1;
                const nc = dist[cur] + Math.abs(xs[cx] - xs[cx - 1]) + ((cd !== 0 && cd !== nd) ? BEND : 0);
                const ns = key(cx - 1, cy, nd);
                if (nc < dist[ns]) { dist[ns] = nc; prev[ns] = cur; push(ns); }
            }
            // down
            if (cy < R - 1 && vOK[cx * (R - 1) + cy]) {
                const nd = 2;
                const nc = dist[cur] + Math.abs(ys[cy + 1] - ys[cy]) + ((cd !== 0 && cd !== nd) ? BEND : 0);
                const ns = key(cx, cy + 1, nd);
                if (nc < dist[ns]) { dist[ns] = nc; prev[ns] = cur; push(ns); }
            }
            // up
            if (cy > 0 && vOK[cx * (R - 1) + (cy - 1)]) {
                const nd = 2;
                const nc = dist[cur] + Math.abs(ys[cy] - ys[cy - 1]) + ((cd !== 0 && cd !== nd) ? BEND : 0);
                const ns = key(cx, cy - 1, nd);
                if (nc < dist[ns]) { dist[ns] = nc; prev[ns] = cur; push(ns); }
            }
        }

        if (!found) {
            // Safety-net: should never happen with margins.
            return this.routeAround(src, srcExit, tgt, tgtEntry, obs);
        }

        // ── 4. Reconstruct path ──────────────────────────────────────
        let endS = -1;
        let endCost = Infinity;
        for (const d of [0, 1, 2]) {
            const s = key(txi, tyi, d);
            if (dist[s] < endCost) { endCost = dist[s]; endS = s; }
        }
        const rawPath: Array<{ x: number; y: number }> = [];
        for (let s = endS; s !== -1; s = prev[s]) {
            const d = s % 3;
            const gi = (s - d) / 3;
            const yi = Math.floor(gi / C);
            const xi = gi - yi * C;
            rawPath.push({ x: xs[xi], y: ys[yi] });
        }
        rawPath.reverse();

        // ── 5. Register channels (no offset — raw grid positions are
        //       guaranteed obstacle-free; offsetting could push into
        //       obstacles, which is exactly the bug we are fixing). ──
        for (let i = 1; i < rawPath.length; i++) {
            const p = rawPath[i - 1];
            const c = rawPath[i];
            if (Math.abs(p.x - c.x) < 0.5) {
                vChannels.push(p.x);   // register vertical channel
            } else if (Math.abs(p.y - c.y) < 0.5) {
                hChannels.push(p.y);   // register horizontal channel
            }
        }

        // ── 6. Wrap with port endpoints and clean ────────────────────
        return this.clean([
            { x: src.x, y: src.y },
            ...rawPath,
            { x: tgt.x, y: tgt.y },
        ]);
    }

    /** Remove consecutive duplicate points and collinear interior points. */
    private clean(route: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> {
        if (route.length <= 2) { return route; }

        // Step 1: deduplicate consecutive points.
        const dd: Array<{ x: number; y: number }> = [route[0]];
        for (let i = 1; i < route.length; i++) {
            const prev = dd[dd.length - 1];
            if (Math.abs(route[i].x - prev.x) > 0.5 || Math.abs(route[i].y - prev.y) > 0.5) {
                dd.push(route[i]);
            }
        }
        if (dd.length <= 2) { return dd; }

        // Step 2: remove collinear interior points.
        const res: Array<{ x: number; y: number }> = [dd[0]];
        for (let i = 1; i < dd.length - 1; i++) {
            const prev = res[res.length - 1];
            const curr = dd[i];
            const next = dd[i + 1];
            const hCol = Math.abs(prev.y - curr.y) < 1 && Math.abs(curr.y - next.y) < 1;
            const vCol = Math.abs(prev.x - curr.x) < 1 && Math.abs(curr.x - next.x) < 1;
            if (!hCol && !vCol) { res.push(curr); }
        }
        res.push(dd[dd.length - 1]);
        return res;
    }

    // ═══════════════════════════════════════════════════════════════════
    // Persistence helpers
    // ═══════════════════════════════════════════════════════════════════

    private collectNodePositions(root: GGraph): Map<string, { x: number; y: number }> {
        const result = new Map<string, { x: number; y: number }>();
        const visit = (element: any, pax: number, pay: number): void => {
            if (!element) { return; }
            const rx = element.position?.x ?? 0;
            const ry = element.position?.y ?? 0;
            const ax = pax + rx;
            const ay = pay + ry;
            const type = element.type as string | undefined;
            if (typeof type === 'string' && type.startsWith('node:')) {
                const args = element.args as Record<string, unknown> | undefined;
                const key = (args?.[WorkflowDiagramMetadata.AST_PATH] ??
                    args?.[WorkflowDiagramMetadata.ENTITY_NAME] ??
                    args?.[WorkflowDiagramMetadata.PORT_NAME]) as unknown;
                if (typeof key === 'string' && key.trim() !== '' && element.position) {
                    result.set(key, { x: ax, y: ay });
                }
            }
            const ch = element.children as any[] | undefined;
            if (Array.isArray(ch)) { for (const c of ch) { visit(c, ax, ay); } }
        };
        visit(root, 0, 0);
        return result;
    }

    private collectEdgeRoutes(root: GGraph): Map<string, { x: number; y: number }[]> {
        const result = new Map<string, { x: number; y: number }[]>();
        const sigCounts = this.buildEdgeSignatureCounts(root);
        const visit = (element: any): void => {
            if (!element) { return; }
            if (element instanceof GEdge) {
                const args = element.args as Record<string, unknown> | undefined;
                const key = this.edgeRouteKeyFor(args, sigCounts);
                const rps = (element as any).routingPoints as { x: number; y: number }[] | undefined;
                if (typeof key === 'string' && Array.isArray(rps) && rps.length >= 2) {
                    result.set(key, rps);
                }
            }
            const ch = element.children as any[] | undefined;
            if (Array.isArray(ch)) { for (const c of ch) { visit(c); } }
        };
        visit(root);
        return result;
    }

    private edgeSignatureFromArgs(args: Record<string, unknown> | undefined): string | undefined {
        if (!args) { return undefined; }
        const norm = (v: unknown): string =>
            (typeof v === 'string' && v.trim() !== '') ? v.trim() : 'boundary';
        const from = norm(args['wf:from']);
        const to = norm(args['wf:to']);
        const out = typeof args['wf:outPort'] === 'string' ? args['wf:outPort'] as string : undefined;
        const inp = typeof args['wf:inPort'] === 'string' ? args['wf:inPort'] as string : undefined;
        if (!out || !inp) { return undefined; }
        return `${from}|${out}|${to}|${inp}`;
    }

    private buildEdgeSignatureCounts(root: GGraph): Map<string, number> {
        const counts = new Map<string, number>();
        const visit = (el: any): void => {
            if (!el) { return; }
            if (el instanceof GEdge) {
                const sig = this.edgeSignatureFromArgs(el.args as Record<string, unknown> | undefined);
                if (sig) { counts.set(sig, (counts.get(sig) ?? 0) + 1); }
            }
            const ch = el.children as any[] | undefined;
            if (Array.isArray(ch)) { for (const c of ch) { visit(c); } }
        };
        visit(root);
        return counts;
    }

    private edgeRouteKeyFor(
        args: Record<string, unknown> | undefined,
        sigCounts: Map<string, number>
    ): string | undefined {
        const sig = this.edgeSignatureFromArgs(args);
        const path = args?.[WorkflowDiagramMetadata.AST_PATH];
        if (sig) {
            const cnt = sigCounts.get(sig) ?? 0;
            if (cnt > 1) {
                return (typeof path === 'string' && path.trim() !== '') ? `${sig}|${path}` : undefined;
            }
            return sig;
        }
        return (typeof path === 'string' && path.trim() !== '') ? path as string : undefined;
    }

    // ═══════════════════════════════════════════════════════════════════
    // Main execution
    // ═══════════════════════════════════════════════════════════════════

    /**
     * The edge's route with its ends moved onto the ports as they are now,
     * or undefined when that route would not do and the router has to run.
     *
     * ELK routes the edges together: edges into one port share a trunk. The
     * router here routes each edge on its own and gives each its own
     * channel, so rerouting a moved node's edges from scratch turns the
     * trunk into a comb of parallel lines with a knot at the port, and the
     * picture drifts from the layout with every move. Keeping the route and
     * sliding only its ends keeps the trunk where the layout put it.
     *
     * The end goes to the port's anchor and the bend next to it follows on
     * the movement axis, so the stub out of the port stays straight. The
     * route is refused when it has no interior bend to carry (sliding a
     * straight line gives a diagonal, and a persisted one at that), when the
     * stub would turn back through its own node, when a segment would run
     * through a node, or when the result is not orthogonal.
     */
    private slideRoute(
        edge: GEdge,
        nodeBoxes: ReadonlyArray<{ id: string; x: number; y: number; r: number; b: number }>
    ): { x: number; y: number }[] | undefined {
        const rps = (edge as any).routingPoints as { x: number; y: number }[] | undefined;
        if (!Array.isArray(rps) || rps.length < 3) { return undefined; }
        const srcId = typeof edge.sourceId === 'string' ? edge.sourceId : undefined;
        const tgtId = typeof edge.targetId === 'string' ? edge.targetId : undefined;
        const srcA = srcId ? this.portAnchorInfo(srcId) : undefined;
        const tgtA = tgtId ? this.portAnchorInfo(tgtId) : undefined;
        if (!srcA || !tgtA) { return undefined; }

        const slid = rps.map(p => ({ x: p.x, y: p.y }));
        const last = slid.length - 1;
        slid[0] = { x: srcA.x, y: srcA.y };
        slid[1] = { x: slid[1].x, y: srcA.y };
        slid[last] = { x: tgtA.x, y: tgtA.y };
        slid[last - 1] = { x: slid[last - 1].x, y: tgtA.y };
        if (!isOrthogonalPolyline(slid)) { return undefined; }

        // The stub leaves the port outwards: an EAST port to the right, a
        // WEST port to the left, and by a real length. A node moved past its
        // bend would send the stub back through itself; one moved up to its
        // bend would leave the port on a vertical.
        const minStub = WorkflowRerouteEdgesAvoidOverlapsOperationHandler.MIN_STUB_PX;
        const outward = (anchor: { x: number; side: 'WEST' | 'EAST' }, bend: { x: number }): boolean =>
            anchor.side === 'EAST' ? bend.x >= anchor.x + minStub : bend.x <= anchor.x - minStub;
        if (!outward(srcA, slid[1]) || !outward(tgtA, slid[last - 1])) { return undefined; }

        // No segment through a node. The stubs are allowed to touch their
        // own node; the trunk is not allowed to touch any, the moved node
        // included: a node dragged onto its own trunk gets a new route.
        for (let i = 0; i < last; i++) {
            for (const box of nodeBoxes) {
                if (i === 0 && box.id === srcA.nodeId) { continue; }
                if (i === last - 1 && box.id === tgtA.nodeId) { continue; }
                if (this.segmentHitsBox(slid[i], slid[i + 1], box)) { return undefined; }
            }
        }
        return this.clean(slid);
    }

    /**
     * The nodes at the ends of a route that moved since the route was drawn:
     * the end whose port anchor is no longer where the route starts or
     * ends. The operation names the incident edges, not the dragged node,
     * and the node at the far end of an edge did not move with it.
     */
    private movedEndpointNodeIds(edge: GEdge): Set<string> {
        const rps = (edge as any).routingPoints as { x: number; y: number }[] | undefined;
        if (!Array.isArray(rps) || rps.length < 2) { return this.edgeEndpointNodeIds(edge); }
        const ids = new Set<string>();
        const ends: Array<[string | undefined, { x: number; y: number }]> = [
            [typeof edge.sourceId === 'string' ? edge.sourceId : undefined, rps[0]],
            [typeof edge.targetId === 'string' ? edge.targetId : undefined, rps[rps.length - 1]]
        ];
        for (const [portId, point] of ends) {
            const anchor = portId ? this.portAnchorInfo(portId) : undefined;
            if (!anchor?.nodeId) { continue; }
            if (Math.abs(anchor.x - point.x) > 0.5 || Math.abs(anchor.y - point.y) > 0.5) { ids.add(anchor.nodeId); }
        }
        return ids;
    }

    private async executeOperation(operation: WorkflowRerouteEdgesAvoidOverlapsOperation, timing?: RerouteTiming): Promise<void> {
        const nowMs = Date.now();
        const startedAt = nowMs;
        const src = operation.source ?? 'client';
        this.modelState.set('workflow.lastRerouteAtMs', nowMs);
        this.modelState.set('workflow.lastRerouteSource', src);
        if (src !== 'changeBounds') {
            this.modelState.set('workflow.lastClientRerouteAtMs', nowMs);
        }

        const root = this.modelState.root;
        if (!(root instanceof GGraph)) { return; }

        const selectedIds = new Set(Array.isArray(operation.elementIds) ? operation.elementIds : []);
        const resetAll = selectedIds.size === 0;

        if (this.debugReroute >= 1) {
            console.info('[cal-reroute] start (manhattan)', {
                preview: Boolean(operation.preview),
                selectedIds: selectedIds.size,
                resetAll,
                moved: Array.isArray(operation.movedElements) ? operation.movedElements.length : 0,
            });
        }

        // Apply pending move positions.
        this.applyMovedElements(root, operation);

        // Snapshot existing routes for debug comparison.
        const preEdgeRoutesById = new Map<string, { x: number; y: number }[] | undefined>();
        const visitSnap = (el: any): void => {
            if (el instanceof GEdge) {
                const id = String((el as any).id);
                const rps = (el as any).routingPoints as { x: number; y: number }[] | undefined;
                preEdgeRoutesById.set(id, Array.isArray(rps) && rps.length >= 2
                    ? rps.map(p => ({ x: p.x, y: p.y })) : undefined);
            }
            const ch = (el as any).children as any[] | undefined;
            if (Array.isArray(ch)) { for (const c of ch) { visitSnap(c); } }
        };
        visitSnap(root);

        // Collect all node bounding boxes as obstacles.
        const obstacles = this.collectObstacles(root);

        // Boxes of the nodes that just moved (selection-scoped reroutes only). A
        // FOREIGN edge — one not connected to a moved node — whose current route
        // now passes through one of these boxes should also be rerouted, so it
        // goes around the node instead of being covered by it. (resetAll already
        // reroutes everything, so this only matters for a scoped move/drag.)
        //
        // The dragged node isn't named in the operation — the final reroute carries
        // the incident *edge* ids in `elementIds` and no `movedElements`. But the
        // dragged node is an endpoint of every one of its incident edges, so derive
        // the candidate moved nodes from those edges' endpoints (also accept node
        // ids / movedElements when present, e.g. serpentine / preview).
        const movedNodeIds = new Set<string>();
        for (const id of selectedIds) {
            const el = this.modelState.index.find(id);
            if (el instanceof GEdge) {
                for (const nid of this.movedEndpointNodeIds(el)) { movedNodeIds.add(nid); }
            } else {
                const nid = this.nodeIdForElement(id);
                if (nid) { movedNodeIds.add(nid); }
            }
        }
        for (const m of (Array.isArray(operation.movedElements) ? operation.movedElements : [])) {
            const nid = this.nodeIdForElement(String((m as any)?.elementId));
            if (nid) { movedNodeIds.add(nid); }
        }
        // A foreign edge is rerouted when the node now covers it, not when
        // the node came within the router's padding of it.
        const pad = WorkflowRerouteEdgesAvoidOverlapsOperationHandler.PAD;
        const nodeBoxes = obstacles.map(o => ({ id: o.id, x: o.x + pad, y: o.y + pad, r: o.r - pad, b: o.b - pad }));
        const movedNodeBoxes = resetAll ? [] : nodeBoxes.filter(o => movedNodeIds.has(o.id));
        const edgeHitByMovedNode = (edge: GEdge): boolean => {
            if (movedNodeBoxes.length === 0) { return false; }
            const rps = (edge as any).routingPoints as { x: number; y: number }[] | undefined;
            if (!Array.isArray(rps) || rps.length < 2) { return false; }
            const endpointNodeIds = this.edgeEndpointNodeIds(edge);
            for (const box of movedNodeBoxes) {
                if (endpointNodeIds.has(box.id)) { continue; } // edge connects here — already handled
                for (let i = 0; i < rps.length - 1; i++) {
                    if (this.segmentHitsBox(rps[i], rps[i + 1], box)) { return true; }
                }
            }
            return false;
        };

        // ── Slide: a selected edge keeps its route, with its ends on the ports ──
        // See slideRoute. An edge it refuses goes to the router below.
        const slidEdgeIds = new Set<string>();
        if (!resetAll) {
            for (const edgeId of selectedIds) {
                const el = this.modelState.index.find(edgeId);
                if (!(el instanceof GEdge)) { continue; }
                const route = this.slideRoute(el, nodeBoxes);
                if (route) {
                    (el as any).routingPoints = route;
                    slidEdgeIds.add(String((el as any).id));
                }
            }
        }

        // ── Collect edges to route, then sort for deterministic channel allocation ──
        const edgesToRoute: GEdge[] = [];
        const visitCollect = (el: any): void => {
            if (el instanceof GEdge && !slidEdgeIds.has(String((el as any).id))
                && (this.shouldRerouteEdge(el, selectedIds, resetAll) || edgeHitByMovedNode(el))) {
                edgesToRoute.push(el);
            }
            const ch = (el as any).children as any[] | undefined;
            if (Array.isArray(ch)) { for (const c of ch) { visitCollect(c); } }
        };
        visitCollect(root);

        if (edgesToRoute.length === 0) {
            if (timing) { timing.router = 'slide'; }
            if (this.debugReroute >= 1) {
                console.info('[cal-reroute] slide — ' + slidEdgeIds.size + ' edges kept their routes');
            }
            await this.persistRoutes(root, operation);
            this.logPerf(operation, startedAt, slidEdgeIds.size, 0, 'slide');
            return;
        }

        // Sort edges by source port Y (top→bottom) so top-most edges get inside
        // channels and later edges spread outward. Break ties by target Y.
        edgesToRoute.sort((a, b) => {
            const aS = typeof a.sourceId === 'string' ? this.portAnchorInfo(a.sourceId) : undefined;
            const bS = typeof b.sourceId === 'string' ? this.portAnchorInfo(b.sourceId) : undefined;
            const ay = aS?.y ?? 0;
            const by = bS?.y ?? 0;
            if (Math.abs(ay - by) > 0.5) { return ay - by; }
            const aT = typeof a.targetId === 'string' ? this.portAnchorInfo(a.targetId) : undefined;
            const bT = typeof b.targetId === 'string' ? this.portAnchorInfo(b.targetId) : undefined;
            return (aT?.y ?? 0) - (bT?.y ?? 0);
        });

        // Shared channel registries — edges route one-at-a-time and later edges
        // are offset from earlier ones when they would share a channel.
        const vChannels: number[] = [];
        const hChannels: number[] = [];

        let routed = 0;
        let changed = 0;

        // Resolve every endpoint once — both routers need the same anchors, and
        // an edge whose ports have gone missing is skipped by both.
        const anchorStartedAt = Date.now();
        const routable: Array<{
            edge: GEdge;
            src: NonNullable<ReturnType<typeof this.portAnchorInfo>>;
            tgt: NonNullable<ReturnType<typeof this.portAnchorInfo>>;
        }> = [];
        for (const edge of edgesToRoute) {
            const srcId = typeof edge.sourceId === 'string' ? edge.sourceId : undefined;
            const tgtId = typeof edge.targetId === 'string' ? edge.targetId : undefined;
            const srcA = srcId ? this.portAnchorInfo(srcId) : undefined;
            const tgtA = tgtId ? this.portAnchorInfo(tgtId) : undefined;
            if (srcA && tgtA) { routable.push({ edge, src: srcA, tgt: tgtA }); }
        }

        const applyRoute = (edge: GEdge, route: { x: number; y: number }[]): void => {
            (edge as any).routingPoints = route;
            routed++;
            if (this.debugReroute >= 1) {
                const id = String((edge as any).id);
                if (this.routingSignature(preEdgeRoutesById.get(id)) !== this.routingSignature(route)) { changed++; }
            }
        };

        // libavoid is the preferred router: on identical geometry it beats the
        // built-in one on crossings, overlaps, bends and length simultaneously.
        // It is asked only for the scoped edge set because its cost is
        // superlinear in connector count, while obstacles are cheap — so every
        // node is passed, and only the edges that need routing.
        if (timing) { timing.anchorMs = Date.now() - anchorStartedAt; }
        const routeStartedAt = Date.now();
        let usedLibavoid = false;
        if (this.useLibavoid && routable.length <= WorkflowRerouteEdgesAvoidOverlapsOperationHandler.LIBAVOID_MAX_EDGES) {
            const shapes: RouterObstacle[] = obstacles.map(o => ({
                id: o.id,
                // `obstacles` carries PAD already baked in; libavoid keeps its own
                // clearance, so hand it the true node box and let it do the padding.
                x: o.x + WorkflowRerouteEdgesAvoidOverlapsOperationHandler.PAD,
                y: o.y + WorkflowRerouteEdgesAvoidOverlapsOperationHandler.PAD,
                width: (o.r - o.x) - 2 * WorkflowRerouteEdgesAvoidOverlapsOperationHandler.PAD,
                height: (o.b - o.y) - 2 * WorkflowRerouteEdgesAvoidOverlapsOperationHandler.PAD
            }));
            const connectors: RouterConnector[] = routable.map(r => ({
                id: String((r.edge as any).id),
                source: { x: r.src.x, y: r.src.y },
                target: { x: r.tgt.x, y: r.tgt.y },
                sourceSide: r.src.side,
                targetSide: r.tgt.side
            }));
            const routes = await routeOrthogonal(shapes, connectors, {
                shapeBufferDistance: WorkflowRerouteEdgesAvoidOverlapsOperationHandler.PAD,
                idealNudgingDistance: WorkflowRerouteEdgesAvoidOverlapsOperationHandler.EDGE_GAP,
                // Matches the built-in router's stub, so edges leave a port the
                // same distance either way and clearance stays at PAD.
                portStub: WorkflowRerouteEdgesAvoidOverlapsOperationHandler.STUB,
                sharedPortPaths: true
            });
            if (routes) {
                usedLibavoid = true;
                for (const r of routable) {
                    const route = routes.get(String((r.edge as any).id));
                    // A connector libavoid could not solve falls through to the
                    // built-in router rather than being left with a stale route.
                    if (route && route.length >= 2) {
                        applyRoute(r.edge, route);
                    } else {
                        const exclude = this.edgeEndpointNodeIds(r.edge);
                        applyRoute(r.edge, this.computeRoute(r.src, r.tgt, obstacles, exclude, vChannels, hChannels));
                    }
                }
            }
        }

        if (!usedLibavoid) {
            for (const r of routable) {
                const exclude = this.edgeEndpointNodeIds(r.edge);
                applyRoute(r.edge, this.computeRoute(r.src, r.tgt, obstacles, exclude, vChannels, hChannels));
            }
        }

        if (timing) {
            timing.routeMs = Date.now() - routeStartedAt;
            timing.router = usedLibavoid ? 'libavoid' : 'manhattan';
        }

        if (this.dumpRoutingInput) {
            void this.writeRoutingInput(obstacles, routable, Boolean(operation.preview), usedLibavoid);
        }

        if (this.debugReroute >= 1) {
            console.info('[cal-reroute] result', {
                router: usedLibavoid ? 'libavoid' : 'manhattan',
                preview: Boolean(operation.preview),
                routedEdges: routed,
                changedEdges: changed,
            });
        }

        await this.persistRoutes(root, operation);
        this.logPerf(operation, startedAt, slidEdgeIds.size, routed, usedLibavoid ? 'libavoid' : 'manhattan');
    }

    /** Always-on breadcrumb, like the layout's: what a persisted reroute did and how long it took. */
    private logPerf(operation: WorkflowRerouteEdgesAvoidOverlapsOperation, startedAt: number, kept: number, routed: number, router: string): void {
        if (operation.preview) { return; }
        // eslint-disable-next-line no-console
        console.log(`[dialogram perf] reroute (${operation.source ?? 'client'}): ${kept} kept, ${routed} routed by ${router}, ${Date.now() - startedAt}ms`);
    }

    /** Persist the layout, positions and routes; not for a preview (a drag). */
    private async persistRoutes(root: GGraph, operation: WorkflowRerouteEdgesAvoidOverlapsOperation): Promise<void> {
        if (operation.preview) { return; }
        const dm = this.modelState.get(WORKFLOW_NETWORK_MODEL_KEY) as WorkflowDiagramModel | undefined;
        if (!dm) { return; }

        const { filePath: workflowFilePath, networkId } = layoutTargetOf(dm as any);

        const positions = this.collectNodePositions(root);
        const routes = this.collectEdgeRoutes(root);
        await this.layoutPersistence.saveLayoutImmediate(workflowFilePath, networkId, positions, routes);

        const layoutMeta = this.modelState.get('workflow.layoutPersistence') as
            | {
                workflowFilePath: string; networkId: string; hasPersistedLayout: boolean;
                hasPersistedEdgeRoutes: boolean; didInitialLayout: boolean;
                hasClientBounds: boolean; allowInitialLayoutPersistence: boolean;
            }
            | undefined;
        if (layoutMeta) {
            layoutMeta.hasPersistedEdgeRoutes = routes.size > 0;
            this.modelState.set('workflow.layoutPersistence', layoutMeta);
        }
    }

    private routingSignature(points: { x: number; y: number }[] | undefined): string {
        if (!Array.isArray(points) || points.length === 0) { return '∅'; }
        return points.map(p => `${Math.round(p.x)}:${Math.round(p.y)}`).join('|');
    }

    /**
     * Capture the router input so a bad drag can be replayed offline.
     * Best-effort: a failure here must never affect the reroute.
     */
    private async writeRoutingInput(
        obstacles: ReadonlyArray<{ id: string; x: number; y: number; r: number; b: number }>,
        routable: ReadonlyArray<{ edge: GEdge; src: { x: number; y: number }; tgt: { x: number; y: number } }>,
        preview: boolean,
        usedLibavoid: boolean
    ): Promise<void> {
        try {
            const os = await import('node:os');
            const pathMod = await import('node:path');
            const fsp = await import('node:fs/promises');
            const pad = WorkflowRerouteEdgesAvoidOverlapsOperationHandler.PAD;
            const payload = {
                preview,
                pad,
                // Unpadded node boxes, exactly what both routers are handed.
                nodes: obstacles.map(o => ({
                    id: o.id,
                    x: o.x + pad,
                    y: o.y + pad,
                    width: (o.r - o.x) - 2 * pad,
                    height: (o.b - o.y) - 2 * pad
                })),
                router: usedLibavoid ? 'libavoid' : 'manhattan',
                edges: routable.map(r => ({
                    id: String((r.edge as any).id),
                    source: { x: r.src.x, y: r.src.y },
                    target: { x: r.tgt.x, y: r.tgt.y },
                    // What we actually wrote onto the edge. If this is orthogonal
                    // but the screen shows diagonals, the loss is downstream.
                    applied: ((r.edge as any).routingPoints ?? []).map((p: any) => ({ x: p.x, y: p.y }))
                }))
            };
            const dir = pathMod.join(os.tmpdir(), 'dialogram-routing');
            await fsp.mkdir(dir, { recursive: true });
            const file = pathMod.join(dir, `routing-${process.pid}-${Date.now()}.json`);
            await fsp.writeFile(file, JSON.stringify(payload, null, 2), 'utf8');
            console.info('[cal-reroute] wrote routing input:', file);
        } catch (error) {
            console.warn('[cal-reroute] could not write routing input', error);
        }
    }

}
