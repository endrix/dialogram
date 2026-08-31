/**
 * Where each edge starts, when a port carries more than one edge.
 *
 * This lives in shared for the same reason `port-anchor.ts` does: the server
 * routes on commit, the client routes live during a drag, and any disagreement
 * between them is visible as an edge jumping the instant the mouse is released.
 * The two routers already share the anchor arithmetic; where the route begins is
 * the other half of the same join, so it is defined once here rather than twice.
 *
 * ## What this fixes
 *
 * Both routers hand libavoid endpoints pushed a fixed distance off the port (an
 * anchor sits only 9px outside its node, too close for a usable clearance), and
 * join the anchor back to the route with an L afterwards.
 *
 * Give two edges the same start and libavoid separates them the only way it can:
 * it nudges each one HALF the nudging distance off the shared row, in opposite
 * directions. Both routes then come back missing the anchor's row, so both get
 * an L — and a 4px step a few pixels off the port is not read as a branch. It is
 * read as a kink in an edge that should have left the port straight, which is
 * what was reported at `rob.Com`, twice.
 *
 * The fix is to separate the starts BEFORE routing rather than let libavoid do
 * it after: the first edge on a port starts exactly on the port's row and keeps
 * it, so it leaves the port dead straight like an edge on any unshared port.
 * Each additional edge starts one nudging distance further along the port's side
 * AND one across it, toward wherever that edge is heading, so it reads as a
 * branch peeling off the first — the way a schematic fans a bus out of a pin.
 *
 * Measured on the reported geometry, for an anchor at y = 393.5:
 *
 * | | first edge | second |
 * | --- | --- | --- |
 * | libavoid separating them | 389.5 — kinks | 397.5 — kinks |
 * | separated up front | 393.5 — straight | 401.5 — one branch |
 *
 * Staggering the distance as well as the offset matters because it is what puts
 * the two turns on different x. Without it both edges corner at the same place
 * and merge into a blob at the port, which is the same complaint one step
 * earlier.
 */

import type { PortSide } from './port-anchor';

/** One end of one edge, as the fan-out sees it. */
export interface PortStubEndpoint {
    /** Stable identity of the edge. */
    id: string;
    /** Which end of that edge this is. */
    end: 'source' | 'target';
    /** The port anchor, in absolute diagram coordinates. */
    x: number;
    y: number;
    side: PortSide;
    /** The y of the edge's OTHER end — which way this edge is heading. */
    towardY: number;
}

/** A node box a start point must not land inside. */
export interface PortStubObstacle {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface PortStubOptions {
    /** The base distance every end starts off its port. */
    portStub: number;
    /** The router's nudging distance — one step of the fan. */
    nudge: number;
}

/** Where one edge starts, relative to its port anchor. */
export interface PortStubOffset {
    /** How far out along the port's side. */
    distance: number;
    /** How far across it; 0 for the edge that keeps the port's own row. */
    across: number;
}

/** Identifies one end of one edge in the returned map. */
export function portStubKey(id: string, end: 'source' | 'target'): string {
    return `${end}:${id}`;
}

function insideObstacle(x: number, y: number, obstacles: readonly PortStubObstacle[]): boolean {
    return obstacles.some(
        o => o.width > 0 && o.height > 0
            && x > o.x && x < o.x + o.width
            && y > o.y && y < o.y + o.height
    );
}

/**
 * The start offset for every end that should differ from the base.
 *
 * Keyed by {@link portStubKey}; ends absent from the map start at `portStub`
 * straight off their anchor, so a caller can treat a miss as "nothing special
 * here". Only ports carrying more than one end appear at all, and the first edge
 * on such a port is deliberately absent too — keeping the port's row is the
 * whole point of it being first.
 *
 * Which edge comes first is decided by edge id: arbitrary, but STABLE, which is
 * the property that actually matters. Ranking by geometry instead — say, the
 * edge heading closest to the port's row — reads slightly better on a static
 * diagram but can swap mid-drag as the nodes move, and a swap pops both edges
 * across each other under the cursor.
 *
 * A start that would land inside a node falls back to the base, giving up the
 * fan for that edge. A blurred port is cosmetic; an endpoint buried in an
 * obstacle makes libavoid route straight through that node.
 */
export function portStubOffsets(
    endpoints: readonly PortStubEndpoint[],
    obstacles: readonly PortStubObstacle[],
    options: PortStubOptions
): Map<string, PortStubOffset> {
    const groups = new Map<string, PortStubEndpoint[]>();
    for (const endpoint of endpoints) {
        const at = `${Math.round(endpoint.x)},${Math.round(endpoint.y)},${endpoint.side}`;
        const group = groups.get(at) ?? [];
        group.push(endpoint);
        groups.set(at, group);
    }

    const offsets = new Map<string, PortStubOffset>();
    for (const group of groups.values()) {
        if (group.length < 2) {
            continue;
        }
        [...group]
            .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
            .forEach((endpoint, rank) => {
                if (rank === 0) {
                    return;
                }
                // Fan toward where this edge is going, so the branch never has
                // to double back across the trunk to reach its own side.
                const away = endpoint.towardY >= endpoint.y ? 1 : -1;
                const offset: PortStubOffset = {
                    distance: options.portStub + rank * options.nudge,
                    across: away * rank * options.nudge
                };
                const x = endpoint.side === 'EAST'
                    ? endpoint.x + offset.distance
                    : endpoint.x - offset.distance;
                if (!insideObstacle(x, endpoint.y + offset.across, obstacles)) {
                    offsets.set(portStubKey(endpoint.id, endpoint.end), offset);
                }
            });
    }
    return offsets;
}
