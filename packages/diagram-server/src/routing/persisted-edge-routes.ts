/**
 * Applying persisted edge routes to a freshly loaded GModel.
 *
 * A layout file stores each edge's polyline in absolute diagram coordinates, captured when the
 * layout was saved. Node geometry, however, is NOT stored: node sizes are recomputed from the
 * source on every load (label text, port names and the sizing constants all feed into them). So
 * the moment any of those inputs change, a persisted polyline's endpoints no longer sit on the
 * ports they belong to and the edge renders detached — a visible gap between the port marker and
 * the start of the line, growing with the size delta.
 *
 * Therefore the persisted polyline is treated as the *shape* of the route only: its endpoints are
 * re-snapped to the port anchors of the current model, and the adjacent bend is carried along so a
 * segment that was orthogonal stays orthogonal.
 */

import { GEdge, GModelElement, GModelIndex, GModelRoot, GPort } from '@eclipse-glsp/server';
import { WorkflowDiagramConstants, WorkflowDiagramMetadata, portAnchor } from '@dialogram/shared';
import { cleanLegacyFanoutPoints } from '../server/gmodel-convert';

type Point = { x: number; y: number };

function absolutePosition(element: GModelElement | undefined): Point {
    let x = 0;
    let y = 0;
    let current: any = element;
    while (current) {
        const position = current.position as { x?: number; y?: number } | undefined;
        if (position) {
            x += position.x ?? 0;
            y += position.y ?? 0;
        }
        current = current.parent;
    }
    return { x, y };
}

/**
 * The point on a port's border where an edge attaches, in absolute diagram coordinates:
 * the right edge for outputs, the left edge for inputs, vertically centred.
 *
 * Returns `undefined` when the id does not resolve to a port, which leaves the persisted route
 * untouched — only port-to-port edges (all Workflow edges are) can be re-snapped meaningfully.
 */
function portAnchorAbsolute(index: GModelIndex, portId: string | undefined): Point | undefined {
    if (typeof portId !== 'string' || portId === '') {
        return undefined;
    }
    const port = index.find(portId);
    if (!(port instanceof GPort)) {
        return undefined;
    }

    // Geometry lives in shared so the webview's live router computes the same
    // anchor; see packages/shared/src/port-anchor.ts.
    return portAnchor({
        absolute: absolutePosition(port),
        size: (port as any).size as { width?: number; height?: number } | undefined,
        direction: (port as any).args?.[WorkflowDiagramMetadata.PORT_DIRECTION] as string | undefined,
        type: port.type
    });
}

/**
 * Move `points[endIndex]` to `anchor`, dragging the neighbouring bend along the axis the segment
 * was aligned on. Without this a purely horizontal first segment turns diagonal as soon as the
 * port's y moved (different port count, different node height), which reads as a broken route.
 * The neighbour is only touched when it is an interior bend — a two-point route has no bend to
 * carry and both of its points are anchors.
 */
function snapEndpointAt(points: Point[], endIndex: number, anchor: Point): void {
    const neighbourIndex = endIndex === 0 ? 1 : endIndex - 1;
    const previous = points[endIndex];
    const neighbour = points[neighbourIndex];
    const neighbourIsBend = neighbourIndex > 0 && neighbourIndex < points.length - 1;

    points[endIndex] = { x: anchor.x, y: anchor.y };

    if (!neighbourIsBend || !neighbour || !previous) {
        return;
    }
    if (previous.y === neighbour.y) {
        neighbour.y = anchor.y;
    } else if (previous.x === neighbour.x) {
        neighbour.x = anchor.x;
    }
}

/**
 * Pin a polyline's two endpoints to the given port anchors, keeping its interior bends.
 *
 * Used wherever a route's coordinates and the model's port placement can disagree: replaying a
 * layout file saved against different node sizes, and applying ELK's output (ELK re-centres a
 * FIXED_POS port on a whole-pixel routing lane, so a port of odd height comes back half a pixel
 * off the position the server assigned it). Snapping here means the server's port placement is
 * the single source of truth for where an edge attaches, on every path.
 */
export function snapRouteEndpoints(points: Point[], source: Point, target: Point): Point[] {
    if (points.length < 2) {
        return [source, ...points.map(p => ({ x: p.x, y: p.y })), target];
    }

    const snapped = points.map(p => ({ x: p.x, y: p.y }));
    snapEndpointAt(snapped, 0, source);
    snapEndpointAt(snapped, snapped.length - 1, target);
    return snapped;
}

/**
 * Re-anchor a persisted polyline onto the current model's port anchors, keeping its interior
 * bends. Falls back to the persisted points verbatim when an endpoint cannot be resolved.
 */
export function normalizePersistedRouteToFullPolyline(
    index: GModelIndex,
    edge: GEdge,
    persisted: Point[]
): Point[] {
    const source = portAnchorAbsolute(index, (edge as any).sourceId);
    const target = portAnchorAbsolute(index, (edge as any).targetId);
    if (!source || !target) {
        return persisted;
    }
    return snapRouteEndpoints(persisted, source, target);
}

function edgeSignatureFromArgs(args: Record<string, unknown> | undefined): string | undefined {
    if (!args) {
        return undefined;
    }

    const normalizeEndpoint = (value: unknown): string =>
        typeof value === 'string' && value.trim() !== '' ? value.trim() : 'boundary';

    const fromEntity = normalizeEndpoint(args['wf:from']);
    const toEntity = normalizeEndpoint(args['wf:to']);
    const outPort = typeof args['wf:outPort'] === 'string' ? (args['wf:outPort'] as string) : undefined;
    const inPort = typeof args['wf:inPort'] === 'string' ? (args['wf:inPort'] as string) : undefined;

    if (!outPort || !inPort) {
        return undefined;
    }

    return `${fromEntity}|${outPort}|${toEntity}|${inPort}`;
}

function buildEdgeSignatureCounts(root: GModelRoot): Map<string, number> {
    const counts = new Map<string, number>();
    const visit = (element: any): void => {
        if (!element) {
            return;
        }
        if (element instanceof GEdge) {
            const signature = edgeSignatureFromArgs(element.args as Record<string, unknown> | undefined);
            if (signature) {
                counts.set(signature, (counts.get(signature) ?? 0) + 1);
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
    return counts;
}

function edgeRouteKeyFor(
    args: Record<string, unknown> | undefined,
    signatureCounts: Map<string, number>
): string | undefined {
    const signature = edgeSignatureFromArgs(args);
    const astPath = args?.[WorkflowDiagramMetadata.AST_PATH];

    if (signature) {
        const count = signatureCounts.get(signature) ?? 0;
        if (count > 1) {
            if (typeof astPath === 'string' && astPath.trim() !== '') {
                return `${signature}|${astPath}`;
            }
            return undefined;
        }
        return signature;
    }

    if (typeof astPath === 'string' && astPath.trim() !== '') {
        return astPath;
    }

    return undefined;
}

/**
 * Apply the persisted routes to every edge of `root` that has one, re-snapped to the current
 * port anchors.
 */
export function applyPersistedEdgeRoutes(root: GModelRoot, edgeRoutes: Map<string, Point[]>): void {
    const index = new GModelIndex();
    index.indexRoot(root);
    const signatureCounts = buildEdgeSignatureCounts(root);

    const visit = (element: any): void => {
        if (!element) {
            return;
        }
        if (element instanceof GEdge) {
            const args = element.args as Record<string, unknown> | undefined;
            const key = edgeRouteKeyFor(args, signatureCounts);
            if (!key) {
                return;
            }
            const astPath = args?.[WorkflowDiagramMetadata.AST_PATH];
            const points = edgeRoutes.get(key)
                ?? (typeof astPath === 'string' && astPath.trim() !== '' ? edgeRoutes.get(astPath) : undefined);
            if (points) {
                const full = normalizePersistedRouteToFullPolyline(index, element, points);
                const cleaned = cleanLegacyFanoutPoints(full);
                (element as any).routingPoints = cleaned.length >= 2 ? cleaned : undefined;
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
