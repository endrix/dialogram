/**
 * How tangled a laid-out diagram is: the number of times its routed edges
 * cross. Each edge is the polyline from the centre of what it starts on,
 * through its bend points, to the centre of what it ends on. Two segments of
 * different edges cross when each one's ends lie strictly on either side of
 * the other: edges meeting at a port, or running along one another, do not
 * count.
 *
 * Bend points are relative to the element holding the edge (a group's edges
 * to the group), so each polyline is read in diagram coordinates.
 */
import { GEdge, type GModelElement } from '@eclipse-glsp/server';

interface Point {
    x: number;
    y: number;
}

interface Polyline {
    points: Point[];
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

/** The crossings between the routed edges under `root`. */
export function edgeCrossings(root: GModelElement): number {
    const byId = new Map<string, GModelElement>();
    const edges: GEdge[] = [];
    const visit = (element: GModelElement): void => {
        byId.set(element.id, element);
        if (element instanceof GEdge) {
            edges.push(element);
        }
        for (const child of element.children ?? []) {
            visit(child);
        }
    };
    visit(root);
    const lines = edges
        .map(edge => polylineOf(edge, byId))
        .filter((line): line is Polyline => line !== undefined);
    let count = 0;
    for (let i = 0; i < lines.length; i++) {
        for (let j = i + 1; j < lines.length; j++) {
            count += crossingsBetween(lines[i], lines[j]);
        }
    }
    return count;
}

function polylineOf(edge: GEdge, byId: Map<string, GModelElement>): Polyline | undefined {
    const source = byId.get(edge.sourceId);
    const target = byId.get(edge.targetId);
    if (!source || !target) {
        return undefined;
    }
    const origin = edge.parent ? absoluteOf(edge.parent) : { x: 0, y: 0 };
    const bends = ((edge.routingPoints ?? []) as Point[]).map(p => ({ x: origin.x + p.x, y: origin.y + p.y }));
    const points = [centreOf(source), ...bends, centreOf(target)];
    const xs = points.map(p => p.x);
    const ys = points.map(p => p.y);
    return { points, minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

function absoluteOf(element: GModelElement): Point {
    let x = 0;
    let y = 0;
    for (let current: GModelElement | undefined = element; current; current = current.parent) {
        const position = (current as { position?: Point }).position;
        x += position?.x ?? 0;
        y += position?.y ?? 0;
    }
    return { x, y };
}

function centreOf(element: GModelElement): Point {
    const at = absoluteOf(element);
    const size = (element as { size?: { width?: number; height?: number } }).size;
    return { x: at.x + (size?.width ?? 0) / 2, y: at.y + (size?.height ?? 0) / 2 };
}

function crossingsBetween(p: Polyline, q: Polyline): number {
    if (p.maxX < q.minX || q.maxX < p.minX || p.maxY < q.minY || q.maxY < p.minY) {
        return 0;
    }
    let count = 0;
    for (let a = 0; a + 1 < p.points.length; a++) {
        for (let b = 0; b + 1 < q.points.length; b++) {
            if (segmentsCross(p.points[a], p.points[a + 1], q.points[b], q.points[b + 1])) {
                count++;
            }
        }
    }
    return count;
}

function orientation(a: Point, b: Point, c: Point): number {
    return Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
}

function segmentsCross(a: Point, b: Point, c: Point, d: Point): boolean {
    const o1 = orientation(a, b, c);
    const o2 = orientation(a, b, d);
    const o3 = orientation(c, d, a);
    const o4 = orientation(c, d, b);
    return o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0 && o1 !== o2 && o3 !== o4;
}
