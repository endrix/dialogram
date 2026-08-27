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
process.env.WORKFLOW_DIAGRAM_LIBAVOID_DIR ??= path.resolve(
    __dirname,
    '../../../node_modules/libavoid-js/dist'
);

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
 * Captured from a real drag of the `stg` node in a CalPy network (27 nodes,
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

    it('gives every edge the full stub at both ends, whichever way it leaves', async () => {
        const routes = (await routeOrthogonal(fx.nodes, connectors, {
            shapeBufferDistance: 15, portStub: STUB
        }))!;
        for (const c of connectors) {
            const r = routes.get(c.id)!;
            for (const [anchor, next] of [[r[0], r[1]], [r[r.length - 1], r[r.length - 2]]]) {
                // horizontal, and exactly STUB long — a shortened stub means the
                // route turned around next to the port.
                expect(Math.abs(anchor.y - next.y), `stub not horizontal on ${c.id}`).toBeLessThan(0.5);
                expect(Math.abs(Math.abs(anchor.x - next.x) - STUB), `stub not ${STUB}px on ${c.id}`).toBeLessThan(0.5);
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
