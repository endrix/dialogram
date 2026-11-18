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
