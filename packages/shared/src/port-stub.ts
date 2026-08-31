/**
 * How far off its port each edge starts, when a port carries more than one edge.
 *
 * This lives in shared for the same reason `port-anchor.ts` does: the server
 * routes on commit, the client routes live during a drag, and any disagreement
 * between them is visible as an edge jumping the instant the mouse is released.
 * The two routers already share the anchor arithmetic; the stub distance is the
 * other half of the same join, so it is defined once here rather than twice.
 *
 * ## What this fixes
 *
 * Both routers hand libavoid endpoints pushed a fixed distance off the port
 * (an anchor sits only 9px outside its node, too close for a usable clearance),
 * then join the anchor back to the route with an L. That turn therefore happens
 * at exactly the stub distance — invisible for a port with one edge, but for a
 * port with several it put EVERY turn on the same x. The routes ran exactly
 * superimposed for the whole stub and then split there, each stepping aside by
 * the nudging distance. Two lines 8px apart parting in a 4px step at a shared
 * corner do not read as a fan-out: at stroke width, with rounded joins, they
 * merge into a blob hanging off the port.
 *
 * libavoid separates such corners on its own when the edges turn and then run a
 * long way — three edges off one port come back with corners 12px apart, unaided.
 * It cannot when the first move is just the nudge itself, which is far too short
 * a segment for nudging to act on. That is the case this exists for.
 *
 * So each additional edge on a port starts one nudging distance further out and
 * peels off at its own x, one after another, the way a schematic fans a bus out
 * of a pin.
 */

import type { PortSide } from './port-anchor';

/** One end of one edge, as the stagger sees it. */
export interface PortStubEndpoint {
    /** Stable identity of the edge. */
    id: string;
    /** Which end of that edge this is. */
    end: 'source' | 'target';
    /** The port anchor, in absolute diagram coordinates. */
    x: number;
    y: number;
    side: PortSide;
}

/** A node box the staggered start must not land inside. */
export interface PortStubObstacle {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface PortStubOptions {
    /** The base distance every end starts off its port. */
    portStub: number;
    /** The router's nudging distance — one step of the stagger. */
    nudge: number;
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
 * The stub distance for every end that should differ from the base.
 *
 * Keyed by {@link portStubKey}; ends absent from the map take `portStub`, so a
 * caller can treat a miss as "no stagger needed". Only ports carrying more than
 * one end appear at all.
 *
 * Ordering is by edge id — arbitrary, but STABLE, which is the property that
 * matters: a redraw or a drag must not reshuffle which edge turns first, or the
 * routes would swap places under the cursor.
 *
 * A staggered start that would land inside a node keeps the base distance. A
 * shared corner is a cosmetic flaw; an endpoint buried in an obstacle makes
 * libavoid route straight through that node, which is a real one.
 */
export function portStubDistances(
    endpoints: readonly PortStubEndpoint[],
    obstacles: readonly PortStubObstacle[],
    options: PortStubOptions
): Map<string, number> {
    const groups = new Map<string, PortStubEndpoint[]>();
    for (const endpoint of endpoints) {
        const at = `${Math.round(endpoint.x)},${Math.round(endpoint.y)},${endpoint.side}`;
        const group = groups.get(at) ?? [];
        group.push(endpoint);
        groups.set(at, group);
    }

    const distances = new Map<string, number>();
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
                const stub = options.portStub + rank * options.nudge;
                const x = endpoint.side === 'EAST' ? endpoint.x + stub : endpoint.x - stub;
                if (!insideObstacle(x, endpoint.y, obstacles)) {
                    distances.set(portStubKey(endpoint.id, endpoint.end), stub);
                }
            });
    }
    return distances;
}
