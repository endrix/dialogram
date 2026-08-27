/**
 * Orthogonal connector routing via libavoid (Adaptagrams), compiled to WASM.
 *
 * ## Why this exists
 *
 * The diagram needs a router that takes node positions as GIVEN and computes
 * only the edges: after a drag, after a hand-computed placement, and on reopen
 * from a persisted layout. ELK cannot do that job. `elk.algorithm: fixed` looks
 * like it should — it is the one ELK algorithm that honours pre-set coordinates
 * — but it is a PLACEMENT provider, not a router. It reads existing edge
 * sections only to size the graph and hands them back untouched, and it throws
 * outright when an edge has none ("The edge needs to have exactly one edge
 * section. Found: 0"). Its `elk.edgeRouting` option is never consulted.
 *
 * That gap is why this codebase grew three hand-written orthogonal routers.
 * libavoid is the thing they were each approximating: a real connector router
 * that takes fixed obstacles and produces orthogonal routes.
 *
 * ## Why libavoid rather than fixing ours
 *
 * Measured on identical node positions and the identical 58-edge network, per
 * edge-route quality:
 *
 *   router                     crossings   overlaps          bends   length
 *   dialogram Manhattan             285   43 (12758px)         166   59162
 *   libavoid + nudging              239    1 (   40px)          94   55909
 *
 * It wins on every axis at once, and the 12758px of doubled-up line — edges
 * drawn exactly on top of each other — is the defect our `gridRoute` cannot fix
 * because it registers channels without ever offsetting them. libavoid solves
 * that with one option, `nudgeOrthogonalSegmentsConnectedToShapes`.
 *
 * ## Cost
 *
 * Superlinear in connector count, which is why callers should pass only the
 * edges they actually need routed and let the rest stay as they are:
 *
 *   1 edge 3ms · 14 edges (one node's incident set) 10ms · 29 edges 26ms ·
 *   58 edges 337ms · one-time WASM init 30ms
 *
 * A drag reroutes one node's edges, so it lands in the 10ms band.
 *
 * ## Loading
 *
 * `node_modules` is excluded from the .vsix, so the dependency is copied into
 * the bundle output at build time and loaded from there by an absolute path.
 * The import specifier is computed rather than literal so esbuild leaves it
 * alone — the package uses `import.meta.url` internally and cannot survive
 * being inlined into a CJS bundle.
 *
 * Every failure path returns `undefined` rather than throwing: the caller keeps
 * its existing router as a fallback, so a missing or broken WASM build degrades
 * the routing quality instead of breaking the diagram.
 */

import * as path from 'node:path';
import * as url from 'node:url';
import { snapRouteEndpoints } from './persisted-edge-routes';

export interface RouterPoint {
    x: number;
    y: number;
}

/** A node the router must route around. Absolute, unpadded diagram coordinates. */
export interface RouterObstacle {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
}

/** One connector, given as the two port anchor points it must join. */
export interface RouterConnector {
    id: string;
    source: RouterPoint;
    target: RouterPoint;
    /** Which side of its node each anchor sits on, so the route can leave along it. */
    sourceSide?: 'WEST' | 'EAST';
    targetSide?: 'WEST' | 'EAST';
}

export interface LibavoidRoutingOptions {
    /** Clearance kept between a route and a node box. */
    shapeBufferDistance?: number;
    /** Separation between parallel routes sharing a channel. */
    idealNudgingDistance?: number;
    /**
     * How far off the port the route is allowed to start.
     *
     * Port anchors sit only 9px outside their node, which caps how much
     * clearance the router can be given: a buffer at or above that swallows the
     * endpoint and libavoid routes through the node. Clamping the buffer instead
     * makes every route graze the boxes, which reads as edges boxing a node in.
     *
     * So the connector is handed endpoints pushed `portStub` further out along
     * the port's own side, and the short stub back to the real anchor is added
     * afterwards. The endpoints are then far enough out to allow a proper buffer,
     * and the stub is axis-aligned so the result stays orthogonal.
     */
    portStub?: number;
}

const DEFAULT_OPTIONS: Required<LibavoidRoutingOptions> = {
    shapeBufferDistance: 15,
    idealNudgingDistance: 8,
    portStub: 20
};

/**
 * Where the copied dependency lives, most specific first.
 *
 * `WORKFLOW_DIAGRAM_LIBAVOID_DIR` exists so tests and a dev run can point at
 * `node_modules/libavoid-js/dist` without a build step.
 */
function candidateDirs(): string[] {
    const dirs: string[] = [];
    const fromEnv = process.env.WORKFLOW_DIAGRAM_LIBAVOID_DIR;
    if (fromEnv) {
        dirs.push(path.resolve(fromEnv));
    }
    // Bundled extension: esbuild emits to `out/`, the copy step puts it alongside.
    if (typeof __dirname === 'string') {
        dirs.push(path.join(__dirname, 'libavoid'));
        dirs.push(__dirname);
    }
    return dirs;
}

type AvoidModule = any;

let loadPromise: Promise<AvoidModule | undefined> | undefined;

async function loadAvoid(): Promise<AvoidModule | undefined> {
    for (const dir of candidateDirs()) {
        try {
            // Computed specifier: esbuild does not follow this, which is the point.
            const entry = url.pathToFileURL(path.join(dir, 'libavoid-node.mjs')).href;
            const mod = await import(/* @vite-ignore */ entry);
            const AvoidLib = mod?.AvoidLib ?? mod?.default?.AvoidLib;
            if (!AvoidLib) {
                continue;
            }
            await AvoidLib.load(path.join(dir, 'libavoid.wasm'));
            const instance = AvoidLib.getInstance();
            if (instance?.Router) {
                return instance;
            }
        } catch {
            // Try the next candidate; a total miss falls back to the old router.
        }
    }
    console.warn('[libavoid-router] libavoid is unavailable; falling back to the built-in router');
    return undefined;
}

/** Resolve the WASM module once per process. */
export function initLibavoid(): Promise<AvoidModule | undefined> {
    if (!loadPromise) {
        loadPromise = loadAvoid();
    }
    return loadPromise;
}

/** Whether routing through libavoid is possible in this process. */
export async function isLibavoidAvailable(): Promise<boolean> {
    return (await initLibavoid()) !== undefined;
}

/**
 * Route `connectors` orthogonally around `obstacles`.
 *
 * Returns a route per connector id, or `undefined` if libavoid is unavailable —
 * the caller is expected to fall back rather than treat this as an error.
 *
 * All obstacles should be passed even when only a few connectors are routed:
 * they are what the routes avoid. Only the connectors passed are solved, and
 * the cost is superlinear in that count, so pass the scoped set.
 */

/**
 * The smallest gap between any connector endpoint and any node box.
 *
 * This is the hard ceiling on `shapeBufferDistance`: a buffer at or above it
 * swallows an endpoint, and libavoid then treats the inside of that node as
 * traversable. Returns Infinity when there is nothing to constrain.
 */
function minAnchorClearance(
    obstacles: readonly RouterObstacle[],
    connectors: readonly RouterConnector[]
): number {
    let min = Infinity;
    for (const c of connectors) {
        for (const p of [c.source, c.target]) {
            for (const o of obstacles) {
                if (!(o.width > 0) || !(o.height > 0)) {
                    continue;
                }
                // Distance from the point to the rectangle; 0 when inside.
                const dx = Math.max(o.x - p.x, 0, p.x - (o.x + o.width));
                const dy = Math.max(o.y - p.y, 0, p.y - (o.y + o.height));
                const d = Math.hypot(dx, dy);
                if (d < min) {
                    min = d;
                }
            }
        }
    }
    return min;
}

export async function routeOrthogonal(
    obstacles: readonly RouterObstacle[],
    connectors: readonly RouterConnector[],
    options: LibavoidRoutingOptions = {}
): Promise<Map<string, RouterPoint[]> | undefined> {
    if (connectors.length === 0) {
        return new Map();
    }
    const Avoid = await initLibavoid();
    if (!Avoid) {
        return undefined;
    }

    const requested = { ...DEFAULT_OPTIONS, ...options };
    // A connector endpoint that lies inside a shape's clearance region makes
    // libavoid route straight THROUGH that shape. Port anchors sit only
    // PORT_WIDTH_PX (9) outside their node box, so a buffer of 15 — the value
    // the obstacle padding uses — silently produced routes cutting across the
    // very nodes they attach to. The failure is invisible to any check that
    // excludes an edge's own endpoint nodes, which is how it shipped.
    //
    // Rather than hard-code a number that a future port geometry would
    // invalidate, derive the ceiling from the anchors actually passed in.
    // Push each endpoint out along its port's side before routing; the stub back
    // to the true anchor is re-attached afterwards.
    const offsetOf = (p: RouterPoint, side: 'WEST' | 'EAST' | undefined): RouterPoint =>
        side === 'EAST' ? { x: p.x + requested.portStub, y: p.y }
            : side === 'WEST' ? { x: p.x - requested.portStub, y: p.y }
                : p;
    const routed = connectors.map(c => ({
        id: c.id,
        source: offsetOf(c.source, c.sourceSide),
        target: offsetOf(c.target, c.targetSide)
    }));

    // The ceiling is set by where the router actually starts, i.e. the offset
    // points — not the anchors, which the stub now covers.
    const clearance = minAnchorClearance(obstacles, routed);
    const buffer = Math.max(1, Math.min(requested.shapeBufferDistance, clearance - 1));
    const opts = { ...requested, shapeBufferDistance: buffer };
    // libavoid 0.4.5 exposes flags, parameters and options as flat top-level
    // values. Pinned deliberately — see vendor/libavoid/README.md for the table
    // of what changes if this is ever moved to 0.5.x.
    const orthogonal = Avoid.OrthogonalRouting;
    let router: any;
    try {
        router = new Avoid.Router(orthogonal);
        router.setRoutingParameter(Avoid.shapeBufferDistance, opts.shapeBufferDistance);
        router.setRoutingParameter(Avoid.idealNudgingDistance, opts.idealNudgingDistance);
        // Without this, parallel routes sharing a channel land on identical
        // coordinates: 99 overlapping segment pairs on the reference network,
        // against 1 with it on. The other nudging options change nothing on
        // their own, and `crossingPenalty` is actively harmful — raising it made
        // crossings worse and the solve 200x slower.
        router.setRoutingOption(Avoid.nudgeOrthogonalSegmentsConnectedToShapes, true);

        for (const o of obstacles) {
            if (!(o.width > 0) || !(o.height > 0)) {
                continue;
            }
            new Avoid.ShapeRef(
                router,
                new Avoid.Rectangle(new Avoid.Point(o.x, o.y), new Avoid.Point(o.x + o.width, o.y + o.height))
            );
        }

        const byId = new Map(connectors.map(c => [c.id, c]));
        const refs: Array<{ id: string; ref: any }> = [];
        for (const c of routed) {
            refs.push({
                id: c.id,
                ref: new Avoid.ConnRef(
                    router,
                    new Avoid.ConnEnd(new Avoid.Point(c.source.x, c.source.y)),
                    new Avoid.ConnEnd(new Avoid.Point(c.target.x, c.target.y))
                )
            });
        }

        router.processTransaction();

        const routes = new Map<string, RouterPoint[]>();
        for (const { id, ref } of refs) {
            const polyline = ref.displayRoute();
            const points: RouterPoint[] = [];
            const size = polyline.size();
            for (let i = 0; i < size; i++) {
                const p = polyline.get_ps(i);
                points.push({ x: p.x, y: p.y });
            }
            if (points.length >= 2) {
                // libavoid nudges a route's last segment, which moves the endpoint
                // off the port anchor it was given — measured at up to 15px on a
                // real drag, which reads as the edge coming adrift from its port.
                // Pin both ends back onto the anchors, carrying the adjacent bend
                // so the leading and trailing segments stay orthogonal. This is
                // the same guarantee the ELK path relies on.
                const c = byId.get(id);
                if (!c) {
                    routes.set(id, points);
                    continue;
                }
                // Attach the port anchors to whatever libavoid produced.
                //
                // Note what this deliberately does NOT do: pull the route's ends
                // onto the offset points first. That looks like it enforces a
                // uniform stub, but snapping an endpoint drags the adjacent bend
                // with it — and the offset x is identical for every edge reaching
                // ports on the same side of a node. Three edges leaving one node
                // had their nudged channels (x = 292, 300, 308) collapsed onto a
                // single x = 300, so they drew as one thick line.
                //
                // libavoid already keeps the route clear of the port, because it
                // was handed endpoints pushed `portStub` out. Its own ends may sit
                // a few pixels in from those, which only shortens the stub — and a
                // shorter stub is far cheaper than losing the nudging.
                //
                // The connecting segment stays axis-aligned because libavoid ends
                // on the anchor's own horizontal line.
                const withStubs = [c.source, ...points, c.target];
                routes.set(id, snapRouteEndpoints(withStubs, c.source, c.target));
            }
        }
        return routes;
    } catch (error) {
        console.warn('[libavoid-router] routing failed; falling back to the built-in router', error);
        return undefined;
    } finally {
        // The router owns every ShapeRef and ConnRef created against it, so this
        // releases the whole transaction's WASM memory. Skipping it leaks on
        // every drag.
        try {
            router?.__destroy__();
        } catch {
            // Nothing useful to do if teardown itself fails.
        }
    }
}
