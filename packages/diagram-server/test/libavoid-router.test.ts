/**
 * The libavoid router is a fallback-on-failure component: when it cannot load,
 * `routeOrthogonal` returns undefined and the caller silently keeps the old
 * router. That is the right runtime behaviour and a terrible failure mode for a
 * test suite, because a broken build would look like a pass.
 *
 * So these tests assert the two things separately: that routing is genuinely
 * available, and that what it produces is correct.
 */
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { readFileSync } from 'node:fs';
import {
    isLibavoidAvailable,
    routeOrthogonal,
    type RouterObstacle,
    type RouterConnector
} from '../src/routing/libavoid-router';

// Point the loader at the installed package; the extension build copies these
// same two files next to the bundle instead.
// The vendored, eval-free build — see vendor/libavoid/README.md.
process.env.WORKFLOW_DIAGRAM_LIBAVOID_DIR ??= path.resolve(__dirname, '../../../vendor/libavoid');

const orthogonal = (points: { x: number; y: number }[]): boolean =>
    points.every((p, i) => {
        if (i === 0) return true;
        const q = points[i - 1];
        return Math.abs(p.x - q.x) < 0.5 || Math.abs(p.y - q.y) < 0.5;
    });

function hitsBox(points: { x: number; y: number }[], box: RouterObstacle): boolean {
    for (let i = 1; i < points.length; i++) {
        const a = points[i - 1];
        const b = points[i];
        const x1 = Math.min(a.x, b.x), x2 = Math.max(a.x, b.x);
        const y1 = Math.min(a.y, b.y), y2 = Math.max(a.y, b.y);
        if (x2 > box.x + 0.5 && x1 < box.x + box.width - 0.5
            && y2 > box.y + 0.5 && y1 < box.y + box.height - 0.5) {
            return true;
        }
    }
    return false;
}

describe('libavoid router', () => {
    it('is available — a fallback to the built-in router would hide real regressions', async () => {
        expect(await isLibavoidAvailable()).toBe(true);
    });

    it('routes around an obstacle instead of through it', async () => {
        const blocker: RouterObstacle = { id: 'blocker', x: 180, y: 0, width: 80, height: 400 };
        const obstacles: RouterObstacle[] = [
            { id: 'a', x: 0, y: 0, width: 80, height: 50 },
            blocker,
            { id: 'b', x: 400, y: 300, width: 80, height: 50 }
        ];
        const connectors: RouterConnector[] = [
            { id: 'e1', source: { x: 80, y: 25 }, target: { x: 400, y: 325 } }
        ];

        const routes = await routeOrthogonal(obstacles, connectors);
        expect(routes).toBeDefined();

        const route = routes!.get('e1');
        expect(route).toBeDefined();
        expect(route!.length).toBeGreaterThanOrEqual(2);
        expect(orthogonal(route!)).toBe(true);
        expect(hitsBox(route!, blocker)).toBe(false);
    });

    it('pins each route to the anchors it was given', async () => {
        const obstacles: RouterObstacle[] = [
            { id: 'a', x: 0, y: 0, width: 60, height: 40 },
            { id: 'b', x: 300, y: 200, width: 60, height: 40 }
        ];
        const connectors: RouterConnector[] = [
            { id: 'e', source: { x: 60, y: 20 }, target: { x: 300, y: 220 } }
        ];
        const route = (await routeOrthogonal(obstacles, connectors))!.get('e')!;
        expect(route[0]).toEqual({ x: 60, y: 20 });
        expect(route[route.length - 1]).toEqual({ x: 300, y: 220 });
    });

    it('separates parallel routes rather than stacking them on one lane', async () => {
        // Four connectors that would all take the same channel if nothing nudged
        // them apart. This is the defect the built-in router cannot fix: it
        // registers channels without ever offsetting them.
        const obstacles: RouterObstacle[] = [
            { id: 'left', x: 0, y: 0, width: 60, height: 200 },
            { id: 'right', x: 400, y: 0, width: 60, height: 200 }
        ];
        const connectors: RouterConnector[] = [0, 1, 2, 3].map(i => ({
            id: `e${i}`,
            source: { x: 60, y: 30 + i * 40 },
            target: { x: 400, y: 30 + i * 40 }
        }));

        const routes = await routeOrthogonal(obstacles, connectors);
        expect(routes).toBeDefined();

        const ys = [0, 1, 2, 3].map(i => routes!.get(`e${i}`)![0].y);
        expect(new Set(ys).size).toBe(4);
    });

    it('returns an empty map for no connectors without touching the solver', async () => {
        const routes = await routeOrthogonal([{ id: 'a', x: 0, y: 0, width: 10, height: 10 }], []);
        expect(routes).toBeDefined();
        expect(routes!.size).toBe(0);
    });
});

/**
 * Captured from a real drag of the `stg` node in a reference network (27 nodes,
 * 8 rerouted edges). This fixture exists because of a specific shipped bug:
 * `shapeBufferDistance` was set to the obstacle padding (15) while port anchors
 * sit only 9px outside their node box, so every connector endpoint landed
 * inside its own shape's clearance region and libavoid routed three segments
 * straight through `stg` and `pe_thread_4`.
 *
 * It went unnoticed because the obvious check — "does a route cross a node it
 * does not attach to?" — excludes exactly the nodes that were being crossed.
 * The assertion below is deliberately strict: a route may not enter ANY node
 * box, including its own endpoints.
 */
describe('libavoid router — real drag geometry', () => {
    const fixture = JSON.parse(
        readFileSync(path.join(__dirname, 'fixtures-stg-drag.json'), 'utf8')
    ) as {
        pad: number;
        nodes: RouterObstacle[];
        edges: Array<{ id: string; source: { x: number; y: number }; target: { x: number; y: number } }>;
    };

    const connectors: RouterConnector[] = fixture.edges.map(e => ({
        id: e.id,
        source: e.source,
        target: e.target
    }));

    /** Segments entering any node box, endpoint nodes included. */
    function segmentsInsideNodes(route: { x: number; y: number }[]): number {
        let hits = 0;
        for (let i = 1; i < route.length; i++) {
            const a = route[i - 1];
            const b = route[i];
            const x1 = Math.min(a.x, b.x), x2 = Math.max(a.x, b.x);
            const y1 = Math.min(a.y, b.y), y2 = Math.max(a.y, b.y);
            for (const n of fixture.nodes) {
                if (x2 > n.x + 1 && x1 < n.x + n.width - 1 && y2 > n.y + 1 && y1 < n.y + n.height - 1) {
                    hits++;
                    break;
                }
            }
        }
        return hits;
    }

    it('never routes through a node, even the ones it attaches to', async () => {
        // Ask for the buffer that caused the bug; the router must clamp it.
        const routes = await routeOrthogonal(fixture.nodes, connectors, {
            shapeBufferDistance: fixture.pad
        });
        expect(routes).toBeDefined();
        expect(routes!.size).toBe(connectors.length);

        for (const [id, route] of routes!) {
            expect(segmentsInsideNodes(route), `edge ${id} passes through a node`).toBe(0);
        }
    });

    it('keeps every route orthogonal and anchored', async () => {
        const routes = await routeOrthogonal(fixture.nodes, connectors, {
            shapeBufferDistance: fixture.pad
        });
        for (const c of connectors) {
            const route = routes!.get(c.id)!;
            expect(orthogonal(route)).toBe(true);
            expect(route[0]).toEqual(c.source);
            expect(route[route.length - 1]).toEqual(c.target);
        }
    });
});

/**
 * Captured from a network where two adjacent EAST ports on `Frontend` — 21px
 * apart — feed opposite directions: `dec_Out` heads left to `Core`, `ftq_Bpd`
 * right to `Observe`. The leftward edge has to double back, and libavoid nudges
 * route ends, so it turned around 11px from its port instead of the requested
 * 25 — inside the gap to its neighbour, which is what the crowding looked like.
 *
 * The stub is now re-established before the anchors are attached, so a reversal
 * always happens clear of the port however libavoid nudges the ends.
 */
describe('libavoid router — adjacent ports feeding opposite directions', () => {
    const fx = JSON.parse(
        readFileSync(path.join(__dirname, 'fixtures-frontend.json'), 'utf8')
    ) as { nodes: RouterObstacle[]; edges: Array<{ id: string; source: any; target: any }> };

    const sideOf = (p: { x: number; y: number }): 'WEST' | 'EAST' => {
        let best: { sc: number; side: 'WEST' | 'EAST' } | undefined;
        for (const n of fx.nodes) {
            const dl = Math.abs(p.x - n.x);
            const dr = Math.abs(p.x - (n.x + n.width));
            const inY = n.y - 2 <= p.y && p.y <= n.y + n.height + 2;
            const sc = Math.min(dl, dr) + (inY ? 0 : 1e6);
            if (!best || sc < best.sc) best = { sc, side: dl < dr ? 'WEST' : 'EAST' };
        }
        return best!.side;
    };

    const STUB = 25;
    const connectors: RouterConnector[] = fx.edges.map(e => ({
        id: e.id, source: e.source, target: e.target,
        sourceSide: sideOf(e.source), targetSide: sideOf(e.target)
    }));

    it('leaves every port on a horizontal stub with real clearance', async () => {
        const routes = (await routeOrthogonal(fx.nodes, connectors, {
            shapeBufferDistance: 15, portStub: STUB
        }))!;
        for (const c of connectors) {
            const r = routes.get(c.id)!;
            for (const [anchor, next] of [[r[0], r[1]], [r[r.length - 1], r[r.length - 2]]]) {
                expect(Math.abs(anchor.y - next.y), `stub not horizontal on ${c.id}`).toBeLessThan(0.5);
                // Deliberately a minimum, not an exact length. Requiring exactly
                // STUB meant snapping the ends onto the offset points, which drags
                // the adjacent bend — and since that x is shared by every edge
                // reaching one side of a node, it collapsed their separately
                // nudged channels into one. libavoid may end a few pixels short of
                // the offset; what matters is that the route does not turn around
                // on top of the port.
                expect(Math.abs(anchor.x - next.x), `stub too short on ${c.id}`).toBeGreaterThan(8);
            }
        }
    });

    it('keeps the two opposing neighbours apart and orthogonal', async () => {
        const routes = (await routeOrthogonal(fx.nodes, connectors, {
            shapeBufferDistance: 15, portStub: STUB
        }))!;
        for (const name of ['Frontend:dec_Out', 'Frontend:ftq_Bpd']) {
            const c = connectors.find(x => x.id.includes(name))!;
            const r = routes.get(c.id)!;
            expect(orthogonal(r), `${name} is not orthogonal`).toBe(true);
            expect(r[0]).toEqual(c.source);
            expect(r[r.length - 1]).toEqual(c.target);
        }
    });
});

/**
 * Captured from a drag where three outputs of one node fan out to three ports on
 * another. libavoid nudges their vertical channels apart (x = 292 / 300 / 308),
 * but an earlier stub-enforcement step snapped each route's ends onto the offset
 * points — and snapping an endpoint drags the adjacent bend. Since that offset x
 * is identical for every edge reaching one side of a node, all three channels
 * collapsed onto x = 300 and the edges drew as a single thick line.
 */
describe('libavoid router — parallel edges between the same two nodes', () => {
    const fx = JSON.parse(
        readFileSync(path.join(__dirname, 'fixtures-shared-channel.json'), 'utf8')
    ) as { nodes: RouterObstacle[]; edges: Array<{ id: string; source: any; target: any }> };

    const sideOf = (p: { x: number; y: number }): 'WEST' | 'EAST' => {
        let best: { sc: number; side: 'WEST' | 'EAST' } | undefined;
        for (const n of fx.nodes) {
            const dl = Math.abs(p.x - n.x);
            const dr = Math.abs(p.x - (n.x + n.width));
            const inY = n.y - 2 <= p.y && p.y <= n.y + n.height + 2;
            const sc = Math.min(dl, dr) + (inY ? 0 : 1e6);
            if (!best || sc < best.sc) best = { sc, side: dl < dr ? 'WEST' : 'EAST' };
        }
        return best!.side;
    };

    const connectors: RouterConnector[] = fx.edges.map(e => ({
        id: e.id, source: e.source, target: e.target,
        sourceSide: sideOf(e.source), targetSide: sideOf(e.target)
    }));

    /** The x of every vertical segment in a route. */
    function verticalChannels(route: { x: number; y: number }[]): number[] {
        const xs: number[] = [];
        for (let i = 1; i < route.length; i++) {
            if (Math.abs(route[i].x - route[i - 1].x) < 0.5 && Math.abs(route[i].y - route[i - 1].y) > 0.5) {
                xs.push(Math.round(route[i].x));
            }
        }
        return xs;
    }

    it('keeps parallel edges on separate vertical channels', async () => {
        const routes = (await routeOrthogonal(fx.nodes, connectors, {
            shapeBufferDistance: 15, idealNudgingDistance: 8, portStub: 25
        }))!;

        const fanOut = connectors.filter(c => c.id.includes('pgm:') && !c.id.includes('FillReq'));
        expect(fanOut.length).toBe(3);

        const channels = fanOut.map(c => verticalChannels(routes.get(c.id)!)[0]);
        expect(new Set(channels).size, `channels collapsed: ${channels.join(', ')}`).toBe(3);

        // and far enough apart to read as separate lines
        const sorted = [...channels].sort((a, b) => a - b);
        for (let i = 1; i < sorted.length; i++) {
            expect(sorted[i] - sorted[i - 1]).toBeGreaterThanOrEqual(6);
        }
    });
});

/**
 * Captured from a network where two edges leave the SAME output port (`rob.Com`)
 * and go to different places. libavoid nudges their route ends apart vertically
 * to separate them — for an anchor at y = 393.5 it returned starts at y = 390
 * and y = 398 — so joining the anchor straight to that point drew a DIAGONAL
 * off the port, which is not a legal orthogonal route and looked broken.
 *
 * The join is now an L: out along the anchor's own row, then across to meet the
 * route. Both properties have to hold at once, and they pull against each
 * other: forcing the route back onto the anchor's row would restore
 * orthogonality by destroying the nudging (which is what collapsed parallel
 * channels into one thick line before).
 */
describe('libavoid router — several edges leaving one port', () => {
    const fx = JSON.parse(
        readFileSync(path.join(__dirname, 'fixtures-shared-port.json'), 'utf8')
    ) as { nodes: RouterObstacle[]; edges: Array<{ id: string; source: any; target: any }> };

    const sideOf = (p: { x: number; y: number }): 'WEST' | 'EAST' => {
        let best: { sc: number; side: 'WEST' | 'EAST' } | undefined;
        for (const n of fx.nodes) {
            const dl = Math.abs(p.x - n.x);
            const dr = Math.abs(p.x - (n.x + n.width));
            const inY = n.y - 2 <= p.y && p.y <= n.y + n.height + 2;
            const sc = Math.min(dl, dr) + (inY ? 0 : 1e6);
            if (!best || sc < best.sc) best = { sc, side: dl < dr ? 'WEST' : 'EAST' };
        }
        return best!.side;
    };
    const connectors: RouterConnector[] = fx.edges.map(e => ({
        id: e.id, source: e.source, target: e.target,
        sourceSide: sideOf(e.source), targetSide: sideOf(e.target)
    }));
    const opts = { shapeBufferDistance: 15, idealNudgingDistance: 8, portStub: 25 };

    it('never leaves a port on a diagonal', async () => {
        const routes = (await routeOrthogonal(fx.nodes, connectors, opts))!;
        for (const c of connectors) {
            const r = routes.get(c.id)!;
            expect(orthogonal(r), `${c.id} has a diagonal segment`).toBe(true);
            // and the very first step is along the port's own row
            expect(Math.abs(r[0].y - r[1].y), `${c.id} leaves its port diagonally`).toBeLessThan(0.5);
        }
    });

    it('still separates two edges that share a port', async () => {
        const routes = (await routeOrthogonal(fx.nodes, connectors, opts))!;
        const shared = connectors.filter(c => c.id.includes('rob:Com'));
        expect(shared.length).toBe(2);

        // They start at the same anchor, so they must diverge somewhere: the
        // long horizontal runs need to sit on different rows.
        const rows = shared.map(c => {
            const r = routes.get(c.id)!;
            let longest = { len: 0, y: 0 };
            for (let i = 1; i < r.length; i++) {
                if (Math.abs(r[i].y - r[i - 1].y) > 0.5) continue;
                const len = Math.abs(r[i].x - r[i - 1].x);
                if (len > longest.len) longest = { len, y: r[i].y };
            }
            return longest.y;
        });
        expect(Math.abs(rows[0] - rows[1])).toBeGreaterThan(4);
    });

    /**
     * The reported artifact, and the one that matters most: an edge on a shared
     * port must leave it STRAIGHT, like an edge on any other port.
     *
     * Handed two edges with the same start, libavoid separates them the only way
     * it can — half the nudging distance each, in opposite directions. Both then
     * come back off the anchor's row, both need an L to get back to it, and a
     * 4px step a few pixels off the port does not read as a branch. It reads as
     * a kink in an edge that should have gone straight out, which is exactly
     * what was reported at `rob.Com` (`Rb` and `Trap`, one edge each, leave
     * perfectly straight right below it).
     *
     * So the starts are separated BEFORE routing instead: the first edge keeps
     * the port's row and libavoid has no reason to move it. A "real" turn is one
     * bigger than the nudging distance; anything at or below that is the kink.
     */
    it('leaves the first edge on a shared port straight', async () => {
        const routes = (await routeOrthogonal(fx.nodes, connectors, opts))!;
        const shared = connectors
            .filter(c => c.id.includes('rob:Com'))
            .sort((a, b) => (a.id < b.id ? -1 : 1));
        expect(shared.length).toBe(2);

        /** How far the route first departs the anchor's row. */
        const firstTurn = (id: string): number => {
            const r = routes.get(id)!;
            const step = r.slice(1).find(p => Math.abs(p.y - r[0].y) > 0.5);
            return step ? Math.abs(step.y - r[0].y) : Infinity;
        };

        // The first edge goes straight out and only leaves the row to head for
        // its target.
        expect(firstTurn(shared[0].id)).toBeGreaterThan(opts.idealNudgingDistance);
        // The second branches off it by a FULL nudge, not the half-nudge kink
        // that libavoid produces when it has to separate them itself.
        expect(firstTurn(shared[1].id)).toBeGreaterThanOrEqual(opts.idealNudgingDistance);
    });

    /**
     * ...and they must not TURN at the same place either, which is the third
     * way this join has looked broken.
     *
     * Every end starts `portStub` off its port, so the L back to the anchor
     * turned at exactly that distance for every edge — put two edges on one port
     * and both corners landed on one x (444 here). The routes then ran
     * superimposed for the whole stub and split there in a 4px step. At stroke
     * width, with rounded joins, that is not a fan-out; it is a blob on the port,
     * which is what was reported at `rob.Com`.
     *
     * libavoid separates such corners by itself when both edges turn and run a
     * long way (three edges off one port in `fixtures-dense-core` come back
     * 12px apart with no help). It cannot here, because the first move is only
     * the 4px nudge — far too short for segment nudging to bite. Hence the
     * staggered stub, and hence this test: the previous two assertions both pass
     * with every corner piled on one x.
     */
    it('does not turn two edges off one port at the same x', async () => {
        const routes = (await routeOrthogonal(fx.nodes, connectors, opts))!;
        const shared = connectors.filter(c => c.id.includes('rob:Com'));
        expect(shared.length).toBe(2);

        // The corner is the last point still on the anchor's own row.
        const corners = shared.map(c => {
            const r = routes.get(c.id)!;
            let i = 1;
            while (i < r.length && Math.abs(r[i].y - r[0].y) < 0.5) {
                i++;
            }
            return r[i - 1].x;
        });
        expect(Math.abs(corners[0] - corners[1])).toBeGreaterThan(4);
    });
});
