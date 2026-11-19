/**
 * The zoom range a reader can reach.
 *
 * GLSP fixes it at 0.1 to 20 (`configureDiagramOptions`), in a module loaded
 * after every product module, so a product's rebinding of the viewer options
 * lost to it. A diagram is fine with that; a picture drawn by a surface may
 * not be: a drawing a millimetre wide, in micrometres, needs a zoom of 40 to
 * fill a screen, and one of its smallest parts 2000. The range
 * comes from the surface (`DiagramSurface.zoomLimits`), else the profile
 * (`clientBehavior.zoomLimits`), else GLSP's stays. It is set on the one
 * viewer-options object the container holds once the container is built, the
 * way Sprotty's `overrideViewerOptions` does: every reader of the limits (the
 * wheel, Fit, Center, a set viewport) reads that object when it acts.
 *
 * The scroll limits follow a lower zoom floor: Sprotty never zooms out past
 * the canvas width over the scroll range, so with GLSP's ±100 000 a floor
 * below 0.1 would be unreachable on a wide canvas. They are widened only then.
 */
import { isValidZoomLimits, surfacesBound, type DiagramSurface, type SurfaceZoomLimits } from './diagram-surface';

/** GLSP's scroll range, each way. */
const STOCK_SCROLL_LIMIT = 100_000;
/** The widest canvas, in CSS pixels, the zoom floor must still be reachable on. */
const WIDEST_CANVAS = 10_000;

export interface ViewportLimits {
    zoomLimits: { min: number; max: number };
    horizontalScrollLimits: { min: number; max: number };
    verticalScrollLimits: { min: number; max: number };
}

/**
 * The viewer options to set, or nothing when neither the surface nor the
 * profile asks for a range (GLSP's stays, untouched). A range that is not
 * positive, finite and ordered is ignored with a warning.
 */
export function resolveViewportLimits(
    profileLimits: unknown,
    surfaceLimits: unknown,
    warn: (message: string) => void = message => console.warn(message)
): ViewportLimits | undefined {
    const pick = (limits: unknown, from: string): SurfaceZoomLimits | undefined => {
        if (limits === undefined) {
            return undefined;
        }
        if (!isValidZoomLimits(limits)) {
            warn(`[dialogram] ${from} zoomLimits ${JSON.stringify(limits)} ignored: min and max must be positive and finite, min below max`);
            return undefined;
        }
        return limits;
    };
    const zoom = pick(surfaceLimits, 'the surface\'s') ?? pick(profileLimits, 'clientBehavior');
    if (!zoom) {
        return undefined;
    }
    const scroll = Math.max(STOCK_SCROLL_LIMIT, WIDEST_CANVAS / zoom.min);
    return {
        zoomLimits: { min: zoom.min, max: zoom.max },
        horizontalScrollLimits: { min: -scroll, max: scroll },
        verticalScrollLimits: { min: -scroll, max: scroll }
    };
}

/**
 * Set the limits on a built container's viewer options. `viewerOptionsId` and
 * `surfaceId` are the DI identifiers; passed in so this module needs no GLSP.
 */
export function applyViewportLimits(
    container: { isBound(id: unknown): boolean; get(id: unknown): unknown; getAll(id: unknown): unknown[] },
    viewerOptionsId: unknown,
    surfaceId: unknown,
    profileLimits: unknown
): ViewportLimits | undefined {
    if (!viewerOptionsId || !container.isBound(viewerOptionsId)) {
        return undefined;
    }
    let surfaceLimits: unknown;
    if (container.isBound(surfaceId)) {
        // The surface the host mounts, chosen as it chooses.
        surfaceLimits = surfacesBound(container.getAll(surfaceId) as Array<Partial<DiagramSurface> | undefined>).at(-1)?.zoomLimits;
    }
    const limits = resolveViewportLimits(profileLimits, surfaceLimits);
    if (limits) {
        Object.assign(container.get(viewerOptionsId) as object, limits);
    }
    return limits;
}
