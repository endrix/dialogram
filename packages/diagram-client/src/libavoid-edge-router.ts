/**
 * The live tier: edge routes computed in the webview, every frame, while the
 * mouse is still down.
 *
 * ## Why this exists
 *
 * Until now edges did not move during a drag at all. The client queued the
 * incident edges, dispatched one operation on release, and waited for the
 * server to route and send the model back. For the whole of that window the
 * canvas had no routing points to draw, so it drew straight port-to-port lines
 * — the diagonals — and the edges only snapped into place afterwards.
 *
 * Sprotty already has the extension point for this (`IEdgeRouter`, invoked from
 * the render pass). `views.ts` deliberately bypassed it because the stock
 * router computes anchors differently and produced artifacts. That reason is
 * now gone: anchors come from `@dialogram/shared`, so this router and the
 * server's land on the same point by construction, and the committed route
 * replaces the live one without a visible jump.
 *
 * ## Batching
 *
 * `route()` is called once per edge per render pass, but libavoid routes a
 * whole connector set in one transaction — that is where its nudging and
 * crossing avoidance come from, and routing edges one at a time would both lose
 * that and cost a Router per edge.
 *
 * So the work is batched: the first `route()` after anything moves recomputes
 * the affected set and fills a cache; every other call that frame is a lookup.
 * Only edges incident to a node that actually moved are recomputed, which is
 * the same scoping the server uses and keeps a drag in the single-digit
 * millisecond band rather than the ~700ms a full-graph solve costs.
 */

import {
    AbstractEdgeRouter,
    type LinearRouteOptions,
    type Point,
    type ResolvedHandleMove,
    type RoutedPoint,
    type GRoutableElement,
    type GRoutingHandle
} from '@eclipse-glsp/sprotty';
import { injectable } from 'inversify';
import { portAnchor, portStubOffsets, portStubKey, type PortSide, type PortStubOffset } from '@dialogram/shared';
import { isLibavoidReady, libavoid } from './libavoid-loader';

export const LIBAVOID_ROUTER_KIND = 'libavoid';

/** Kept identical to the server's, so both tiers produce the same geometry. */
const SHAPE_BUFFER = 15;
const PORT_STUB = 25;
const NUDGE = 8;

/** Mutable during route construction; sprotty's Point is readonly. */
interface XY {
    x: number;
    y: number;
}

interface Box {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
}

function absolutePosition(element: any): XY {
    let x = 0;
    let y = 0;
    let current = element;
    while (current) {
        if (current.position) {
            x += current.position.x || 0;
            y += current.position.y || 0;
        }
        current = current.parent;
    }
    return { x, y };
}

function isNode(element: any): boolean {
    return typeof element?.type === 'string' && element.type.startsWith('node:');
}

function parentNodeOf(element: any): any | undefined {
    let current = element?.parent;
    while (current) {
        if (isNode(current)) {
            return current;
        }
        current = current.parent;
    }
    return undefined;
}

function rootOf(element: any): any {
    let current = element;
    while (current?.parent) {
        current = current.parent;
    }
    return current;
}

function collectNodes(root: any, into: Box[] = []): Box[] {
    for (const child of root?.children ?? []) {
        if (isNode(child)) {
            const pos = absolutePosition(child);
            const size = child.size ?? child.bounds;
            if (size && size.width > 0 && size.height > 0) {
                into.push({ id: String(child.id), x: pos.x, y: pos.y, width: size.width, height: size.height });
            }
        }
        collectNodes(child, into);
    }
    return into;
}

function anchorOf(port: any): { x: number; y: number; side: PortSide } | undefined {
    if (!port) {
        return undefined;
    }
    return portAnchor({
        absolute: absolutePosition(port),
        size: port.size ?? port.bounds,
        direction: port.args?.['cal:portDirection'] as string | undefined,
        type: port.type
    });
}

@injectable()
export class LibavoidEdgeRouter extends AbstractEdgeRouter {
    get kind(): string {
        return LIBAVOID_ROUTER_KIND;
    }

    /** edge id -> route, valid for the current node geometry. */
    private cache = new Map<string, XY[]>();

    /** Node id -> "x,y" at the time the cache was filled. */
    private geometry = new Map<string, string>();

    override route(edge: GRoutableElement): RoutedPoint[] {
        const source = anchorOf((edge as any).source);
        const target = anchorOf((edge as any).target);
        if (!source || !target) {
            return [];
        }

        if (isLibavoidReady()) {
            this.refresh(edge);
            const cached = this.cache.get(String(edge.id));
            if (cached && cached.length >= 2) {
                return cached.map((p, i) => ({
                    kind: i === 0 ? 'source' : i === cached.length - 1 ? 'target' : 'linear',
                    x: p.x,
                    y: p.y
                })) as RoutedPoint[];
            }
        }

        // Not ready, or this edge could not be solved: a straight run between the
        // anchors is still better than dropping the edge.
        return [
            { kind: 'source', x: source.x, y: source.y },
            { kind: 'target', x: target.x, y: target.y }
        ] as RoutedPoint[];
    }

    /**
     * Recompute the routes invalidated by whatever moved, at most once per
     * change. Cheap and returns immediately when nothing has moved, which is the
     * common case since this runs for every edge in the render pass.
     */
    private refresh(edge: GRoutableElement): void {
        const root = rootOf(edge);
        const boxes = collectNodes(root);

        const moved = new Set<string>();
        for (const box of boxes) {
            const key = `${box.x},${box.y}`;
            if (this.geometry.get(box.id) !== key) {
                moved.add(box.id);
                this.geometry.set(box.id, key);
            }
        }
        if (moved.size === 0) {
            return;
        }

        // Every edge touching a node that moved, plus anything not yet cached.
        const edges: any[] = [];
        const collect = (element: any): void => {
            for (const child of element?.children ?? []) {
                if (typeof child.type === 'string' && child.type.startsWith('edge')) {
                    const sourceNode = parentNodeOf((child as any).source);
                    const targetNode = parentNodeOf((child as any).target);
                    const touched = (sourceNode && moved.has(String(sourceNode.id)))
                        || (targetNode && moved.has(String(targetNode.id)))
                        || !this.cache.has(String(child.id));
                    if (touched) {
                        edges.push(child);
                    }
                }
                collect(child);
            }
        };
        collect(root);
        if (edges.length === 0) {
            return;
        }
        this.solve(boxes, edges);
    }

    /** One libavoid transaction for the whole affected set. */
    private solve(boxes: Box[], edges: any[]): void {
        const Avoid = libavoid();
        if (!Avoid) {
            return;
        }
        // libavoid 0.4.5 flat API — see vendor/libavoid/README.md.
        const orthogonal = Avoid.OrthogonalRouting;
        let router: any;
        try {
            router = new Avoid.Router(orthogonal);
            router.setRoutingParameter(Avoid.shapeBufferDistance, SHAPE_BUFFER);
            router.setRoutingParameter(Avoid.idealNudgingDistance, NUDGE);
            router.setRoutingOption(Avoid.nudgeOrthogonalSegmentsConnectedToShapes, true);

            for (const box of boxes) {
                new Avoid.ShapeRef(
                    router,
                    new Avoid.Rectangle(
                        new Avoid.Point(box.x, box.y),
                        new Avoid.Point(box.x + box.width, box.y + box.height)
                    )
                );
            }

            // Anchors first: how far each end starts off its port depends on how
            // many edges share that port, which is not knowable one edge at a
            // time. Same rule as the server, from shared, so the live route and
            // the committed route agree and the handover stays invisible.
            const ends = edges
                .map(edge => ({
                    id: String(edge.id),
                    source: anchorOf((edge as any).source),
                    target: anchorOf((edge as any).target)
                }))
                .filter(e => e.source && e.target);
            const stubs = portStubOffsets(
                ends.flatMap(e => [
                    { id: e.id, end: 'source' as const, ...e.source!, towardY: e.target!.y },
                    { id: e.id, end: 'target' as const, ...e.target!, towardY: e.source!.y }
                ]),
                boxes,
                { portStub: PORT_STUB, nudge: NUDGE }
            );
            const base: PortStubOffset = { distance: PORT_STUB, across: 0 };

            const refs: Array<{ id: string; ref: any; source: any; target: any }> = [];
            for (const { id: edgeId, source, target } of ends) {
                if (!source || !target) {
                    continue;
                }
                // Route from a stub off the port, not the port itself: an anchor
                // sits only PORT_WIDTH_PX outside its node, and an endpoint inside
                // a shape's clearance makes libavoid route through that shape.
                const from = this.stub(source, stubs.get(portStubKey(edgeId, 'source')) ?? base);
                const to = this.stub(target, stubs.get(portStubKey(edgeId, 'target')) ?? base);
                refs.push({
                    id: edgeId,
                    ref: new Avoid.ConnRef(
                        router,
                        new Avoid.ConnEnd(new Avoid.Point(from.x, from.y)),
                        new Avoid.ConnEnd(new Avoid.Point(to.x, to.y))
                    ),
                    source,
                    target
                });
            }

            router.processTransaction();

            for (const { id, ref, source, target } of refs) {
                const polyline = ref.displayRoute();
                const points: XY[] = [];
                for (let i = 0; i < polyline.size(); i++) {
                    const p = polyline.get_ps(i);
                    points.push({ x: p.x, y: p.y });
                }
                if (points.length >= 2) {
                    this.cache.set(id, this.attachStubs(points, source, target));
                }
            }
        } catch (error) {
            console.warn('[libavoid] live routing failed', error);
        } finally {
            router?.__destroy__();
        }
    }

    private stub(anchor: { x: number; y: number; side: PortSide }, at: PortStubOffset): XY {
        return anchor.side === 'EAST'
            ? { x: anchor.x + at.distance, y: anchor.y + at.across }
            : { x: anchor.x - at.distance, y: anchor.y + at.across };
    }

    /**
     * Attach the port anchors to whatever libavoid produced. Mirrors the server.
     *
     * Deliberately does NOT first pull the ends onto the stub points: snapping an
     * endpoint drags the adjacent bend with it, and the stub x is the same for
     * every edge reaching ports on one side of a node — which collapsed three
     * separately-nudged channels onto a single x and drew them as one thick line.
     */
    private attachStubs(
        points: XY[],
        source: { x: number; y: number; side: PortSide },
        target: { x: number; y: number; side: PortSide }
    ): XY[] {
        const body = points.map(p => ({ x: p.x, y: p.y }));
        // libavoid nudges route ends vertically to separate edges leaving the
        // same port, so its first point rarely sits on the anchor's own row.
        // Joining the two directly would draw a diagonal off the port; an L
        // keeps it orthogonal and keeps the nudging. Mirrors the server.
        const withStubs = [
            { x: source.x, y: source.y },
            ...this.bridge(source, body[0]),
            ...body,
            ...this.bridge(target, body[body.length - 1]).reverse(),
            { x: target.x, y: target.y }
        ];
        this.snap(withStubs, 0, source);
        this.snap(withStubs, withStubs.length - 1, target);
        return withStubs;
    }


    /** The corner joining a port anchor to a route end that is off its row. */
    private bridge(anchor: { x: number; y: number }, end: XY | undefined): XY[] {
        if (!end || Math.abs(anchor.y - end.y) < 0.01) {
            return [];
        }
        return [{ x: end.x, y: anchor.y }];
    }

    /** Move an endpoint onto `to`, carrying the adjacent bend so it stays orthogonal. */
    private snap(points: XY[], index: number, to: XY): void {
        const neighbourIndex = index === 0 ? 1 : index - 1;
        const previous = points[index];
        const neighbour = points[neighbourIndex];
        points[index] = { x: to.x, y: to.y };
        const isBend = neighbourIndex > 0 && neighbourIndex < points.length - 1;
        if (!isBend || !neighbour || !previous) {
            return;
        }
        if (previous.y === neighbour.y) {
            neighbour.y = to.y;
        } else if (previous.x === neighbour.x) {
            neighbour.x = to.x;
        }
    }

    // ── AbstractEdgeRouter plumbing ──────────────────────────────────────
    // Routes are computed, not hand-edited, so there are no interior handles.

    override createRoutingHandles(edge: GRoutableElement): void {
        this.addHandle(edge, 'source', 'routing-point', -2);
        this.addHandle(edge, 'target', 'routing-point', edge.routingPoints.length);
    }

    protected override getOptions(_edge: GRoutableElement): LinearRouteOptions {
        return { minimalPointDistance: 2, standardDistance: 20, selfEdgeOffset: 0.25 };
    }

    protected override getInnerHandlePosition(): Point | undefined {
        return undefined;
    }

    protected override applyInnerHandleMoves(_edge: GRoutableElement, _moves: ResolvedHandleMove[]): void {
        // No interior handles to move.
    }
}
