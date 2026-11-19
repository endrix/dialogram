/**
 * Where Fit puts a drawing so that what is drawn over the canvas covers none
 * of it: the largest part of the canvas the overlays leave free, the drawing
 * a margin inside it, centred. Plain geometry, in the canvas's pixels (the
 * free areas) and the model's units (the content), so it is tested alone.
 */
import type { Viewport } from '@eclipse-glsp/sprotty';

export interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** The space, in screen pixels, kept between the drawing and the free area's edges. */
export const FIT_MARGIN = 16;

export function overlaps(a: Rect, b: Rect): boolean {
    return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * The parts of the canvas the overlays leave free: for each overlay, one of
 * the four sides of it, within what the overlays before it left.
 */
export function freeAreas(canvas: { width: number; height: number }, covered: readonly Rect[]): Rect[] {
    let areas: Rect[] = [{ x: 0, y: 0, width: canvas.width, height: canvas.height }];
    for (const over of covered) {
        const next: Rect[] = [];
        for (const area of areas) {
            if (!overlaps(area, over)) {
                next.push(area);
                continue;
            }
            const right = over.x + over.width;
            const bottom = over.y + over.height;
            next.push(...[
                { x: area.x, y: area.y, width: over.x - area.x, height: area.height },
                { x: right, y: area.y, width: area.x + area.width - right, height: area.height },
                { x: area.x, y: area.y, width: area.width, height: over.y - area.y },
                { x: area.x, y: bottom, width: area.width, height: area.y + area.height - bottom }
            ].filter(side => side.width > 0 && side.height > 0));
        }
        areas = largest(next);
    }
    return areas;
}

function contains(outer: Rect, inner: Rect): boolean {
    return outer.x <= inner.x && outer.y <= inner.y
        && outer.x + outer.width >= inner.x + inner.width && outer.y + outer.height >= inner.y + inner.height;
}

/** `areas` without those another holds (one of equal ones kept): a smaller one never fits the drawing bigger. */
function largest(areas: Rect[]): Rect[] {
    return areas.filter((area, index) => !areas.some((other, at) =>
        at !== index && contains(other, area) && (!contains(area, other) || at < index)));
}

/**
 * The largest free area of the canvas, by its surface (the first of equal
 * ones): where Center puts the content's middle, and what a diagram surface
 * is told is free. The whole canvas when nothing covers it.
 */
export function largestFreeArea(canvas: { width: number; height: number }, covered: readonly Rect[]): Rect | undefined {
    let best: Rect | undefined;
    for (const area of freeAreas(canvas, covered)) {
        if (!best || area.width * area.height > best.width * best.height) {
            best = area;
        }
    }
    return best;
}

/**
 * The viewport that keeps `zoom` and puts the middle of `content` (in the
 * model's units) in the middle of `area` (in the canvas's pixels).
 */
export function viewportCentredIn(content: Rect, area: Rect, zoom: number): Viewport {
    return {
        scroll: {
            x: content.x + content.width / 2 - (area.x + area.width / 2) / zoom,
            y: content.y + content.height / 2 - (area.y + area.height / 2) / zoom
        },
        zoom
    };
}

/**
 * `viewport` moved, along each axis on which `content` (in the model's units)
 * fits the canvas at the viewport's zoom but runs off it, back onto the
 * canvas, `margin` screen pixels inside the edge where there is room for it.
 * Centred in a free area narrower than it, content that fits the canvas
 * would run off the canvas's edge: it stops inside the edge instead, as near
 * the free area's middle as the canvas lets it. Along an axis on which it is
 * larger than the canvas, content that would leave part of the canvas empty
 * while it runs off the other edge is moved to cover the whole canvas, as
 * near the free area's middle as that allows. Content already all on the
 * canvas, and content larger than it that already covers it, are left where
 * they are.
 */
export function keepOnCanvas(viewport: Viewport, content: Rect, canvas: { width: number; height: number }, margin = FIT_MARGIN): Viewport {
    const zoom = viewport.zoom;
    const along = (scroll: number, start: number, size: number, extent: number): number => {
        const shown = size * zoom;
        const at = (start - scroll) * zoom;
        if (shown > extent) {
            const covering = Math.min(Math.max(at, extent - shown), 0);
            return covering === at ? scroll : start - covering / zoom;
        }
        if (!(shown <= extent)) {
            return scroll;
        }
        if (at >= 0 && at + shown <= extent) {
            return scroll;
        }
        const room = Math.min(margin, (extent - shown) / 2);
        const kept = Math.min(Math.max(at, room), extent - shown - room);
        return kept === at ? scroll : start - kept / zoom;
    };
    return {
        scroll: {
            x: along(viewport.scroll.x, content.x, content.width, canvas.width),
            y: along(viewport.scroll.y, content.y, content.height, canvas.height)
        },
        zoom
    };
}

/**
 * `viewport` at a zoom within `limits`, with the middle of `content` (in the
 * model's units) kept where `viewport` draws it on screen: a fit that wants
 * more than the limit is a fit at the limit, still centred, not one whose
 * scroll was worked out for a zoom it did not get.
 */
export function withinZoomLimits(viewport: Viewport, content: Rect, limits: { min: number; max: number } | undefined): Viewport {
    if (!limits || !(limits.min > 0) || !(limits.max >= limits.min)) {
        return viewport;
    }
    const zoom = Math.min(limits.max, Math.max(limits.min, viewport.zoom));
    if (zoom === viewport.zoom) {
        return viewport;
    }
    const middle = { x: content.x + content.width / 2, y: content.y + content.height / 2 };
    const ratio = viewport.zoom / zoom;
    return {
        scroll: {
            x: middle.x - (middle.x - viewport.scroll.x) * ratio,
            y: middle.y - (middle.y - viewport.scroll.y) * ratio
        },
        zoom
    };
}

/**
 * The viewport that draws `content` (in the model's units) as big as it can
 * be, `margin` screen pixels inside one of the canvas's free areas, centred
 * there; nothing when no free area has room for the margin. (A fit's
 * `padding` is taken as that margin: in screen pixels, not the model's
 * units, so it looks the same at any zoom.)
 */
export function viewportClearOf(
    content: Rect,
    canvas: { width: number; height: number },
    covered: readonly Rect[],
    margin: number,
    maxZoom?: number
): Viewport | undefined {
    let best: { zoom: number; area: Rect } | undefined;
    for (const area of freeAreas(canvas, covered)) {
        const width = area.width - 2 * margin;
        const height = area.height - 2 * margin;
        if (width <= 0 || height <= 0) {
            continue;
        }
        let zoom = Math.min(
            content.width > 0 ? width / content.width : Infinity,
            content.height > 0 ? height / content.height : Infinity
        );
        if (maxZoom !== undefined) {
            zoom = Math.min(zoom, maxZoom);
        }
        if (!Number.isFinite(zoom)) {
            zoom = 1;
        }
        const roomier = best !== undefined && Math.abs(zoom - best.zoom) < 1e-9
            && area.width * area.height > best.area.width * best.area.height;
        if (best === undefined || zoom > best.zoom + 1e-9 || roomier) {
            best = { zoom, area };
        }
    }
    if (!best) {
        return undefined;
    }
    const middle = { x: best.area.x + best.area.width / 2, y: best.area.y + best.area.height / 2 };
    return {
        scroll: {
            x: content.x + content.width / 2 - middle.x / best.zoom,
            y: content.y + content.height / 2 - middle.y / best.zoom
        },
        zoom: best.zoom
    };
}
