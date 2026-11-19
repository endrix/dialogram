/**
 * What Fit and Center frame: the content, as the reader sees it.
 *
 * Sprotty's commands frame the elements they are given, else the selection,
 * else every element with bounds. Two things are wrong with "every element"
 * here:
 *
 * - An element its parent's view does not draw still has bounds: the name
 *   label a node's view leaves out, the compartment of a node drawn as a
 *   symbol. The server lays them out for a box they are never drawn in, and
 *   the fit framed them anyway, off-centre and zoomed out for nothing. The
 *   hidden render, where GLSP measures what is drawn, says what is: an element
 *   whose parent was drawn there while it was not is left out, and so is all
 *   it holds. Until there is a hidden render, nothing is left out.
 * - A surface (`diagram-surface.ts`) draws content the graph does not have.
 *   Its bounds join the graph's, and its selection counts as a selection.
 *
 * The order is Sprotty's, with the surface's selection beside the graph's:
 * the elements named, else what is selected, else everything there is.
 */
import { CenterCommand, limitViewport, type Bounds, type Viewport } from '@eclipse-glsp/client';
import type { GModelRoot } from '@eclipse-glsp/sprotty';
import { inject, injectable, optional } from 'inversify';
import type { SurfaceBounds } from './diagram-surface';
import { isValidBounds } from './diagram-surface';
import { DiagramSurfaceHost } from './diagram-surface-host';
import { keepOnCanvas, largestFreeArea, viewportCentredIn, withinZoomLimits } from './fit-geometry';
import { overlaysOn } from './canvas-overlays';

/** The union of two rectangles, an invalid one (negative size) ignored. */
export function combineBounds(a: Bounds | undefined, b: Bounds | undefined): Bounds | undefined {
    const validA = isValidBounds(a) ? a : undefined;
    const validB = isValidBounds(b) ? b : undefined;
    if (!validA || !validB) {
        return validA ?? validB;
    }
    const x = Math.min(validA.x, validB.x);
    const y = Math.min(validA.y, validB.y);
    return {
        x,
        y,
        width: Math.max(validA.x + validA.width, validB.x + validB.width) - x,
        height: Math.max(validA.y + validA.height, validB.y + validB.height) - y
    };
}

/**
 * The ids of the elements the last hidden render drew. GLSP draws every
 * element there, whatever the viewport, to measure it, so what is missing was
 * left out by its parent's view, not by the zoom.
 */
@injectable()
export class HiddenRenderRecord {
    private drawing = new Set<string>();
    private last: ReadonlySet<string> | undefined;

    decorate<T>(vnode: T, element: { id?: string }): T {
        if (typeof element?.id === 'string') {
            this.drawing.add(element.id);
        }
        return vnode;
    }

    postUpdate(): void {
        if (this.drawing.size > 0) {
            this.last = this.drawing;
        }
        this.drawing = new Set();
    }

    /** The ids drawn by the last hidden render; nothing before the first. */
    drawn(): ReadonlySet<string> | undefined {
        return this.last;
    }
}

/** The part of a model element Fit and Center read. */
interface ContentElement {
    id: string;
    parent?: ContentElement;
    selected?: boolean;
    bounds?: Bounds;
}

/** What frames the content besides the graph: a surface's bounds and selection. */
export interface SurfaceContent {
    bounds?: SurfaceBounds;
    selectionBounds?: SurfaceBounds;
}

/**
 * The bounds Fit and Center frame, in the model's coordinates, or nothing
 * when there is nothing to frame.
 *
 * @param boundsOf an element's bounds in the root's coordinates (Sprotty's
 *        `boundsInViewport`)
 */
export function viewportContentBounds(
    model: { index: { getById(id: string): unknown; all(): Iterable<unknown> | { forEach(f: (e: unknown) => void): void } } },
    elementIds: readonly string[],
    boundsOf: (element: ContentElement) => Bounds,
    drawn: ReadonlySet<string> | undefined,
    surface: SurfaceContent | undefined
): Bounds | undefined {
    const all: ContentElement[] = [];
    const index = model.index.all();
    if (typeof (index as Iterable<unknown>)[Symbol.iterator] === 'function') {
        for (const element of index as Iterable<unknown>) {
            all.push(element as ContentElement);
        }
    } else {
        (index as { forEach(f: (e: unknown) => void): void }).forEach(element => all.push(element as ContentElement));
    }
    const hasBounds = (element: ContentElement | undefined): element is ContentElement =>
        !!element && typeof element === 'object' && 'bounds' in element;
    const union = (elements: readonly ContentElement[]): Bounds | undefined =>
        elements.reduce<Bounds | undefined>((sum, element) => combineBounds(sum, boundsOf(element)), undefined);

    // The elements named.
    const named = elementIds.map(id => model.index.getById(id) as ContentElement | undefined).filter(hasBounds);
    if (named.length > 0) {
        return union(named);
    }
    // What is selected: the graph's, else the surface's.
    const selected = all.filter(element => hasBounds(element) && element.selected === true);
    if (selected.length > 0) {
        return union(selected);
    }
    if (isValidBounds(surface?.selectionBounds)) {
        return surface!.selectionBounds;
    }
    // Everything there is, but what the hidden render left out; everything,
    // as Sprotty frames it, when that leaves nothing (a view that draws what
    // it holds itself, not through the platform's render of each child).
    const leftOut = new Map<ContentElement, boolean>();
    const isLeftOut = (element: ContentElement): boolean => {
        const known = leftOut.get(element);
        if (known !== undefined) {
            return known;
        }
        const parent = element.parent;
        const result = !!drawn && !!parent && typeof parent === 'object'
            && (isLeftOut(parent) || (drawn.has(parent.id) && !drawn.has(element.id)));
        leftOut.set(element, result);
        return result;
    };
    const shown = all.filter(element => hasBounds(element) && !isLeftOut(element));
    const graph = union(shown) ?? union(all.filter(hasBounds));
    return combineBounds(graph, surface?.bounds);
}

/**
 * Set a viewport command's old and new viewports around `bounds`, as Sprotty's
 * `BoundsAwareViewportCommand.initialize` does once it has its bounds; a zoom
 * the limits change keeps the content's middle where the command put it, and
 * the content is then kept on the canvas as Center keeps it (`keepOnCanvas`).
 * A Fit the limits leave alone is on the canvas already, with its margin,
 * and does not move.
 */
export function frameBounds(
    model: GModelRoot,
    bounds: Bounds | undefined,
    newViewportFor: (bounds: Bounds, model: GModelRoot) => Viewport | undefined,
    viewerOptions: { zoomLimits?: unknown; horizontalScrollLimits?: unknown; verticalScrollLimits?: unknown } | undefined
): { oldViewport: Viewport; newViewport?: Viewport } | undefined {
    const root = model as unknown as { scroll?: { x: number; y: number }; zoom?: number; canvasBounds?: Bounds };
    if (!root.scroll || typeof root.zoom !== 'number') {
        return undefined;
    }
    const oldViewport = { scroll: root.scroll, zoom: root.zoom };
    if (!isValidBounds(bounds)) {
        return { oldViewport };
    }
    const proposed = newViewportFor(bounds, model);
    if (!proposed) {
        return { oldViewport };
    }
    const options = (viewerOptions ?? {}) as any;
    const zoomed = withinZoomLimits(proposed, bounds, options.zoomLimits);
    const canvas = root.canvasBounds;
    const placed = isValidBounds(canvas) && canvas.width > 0 && canvas.height > 0 ? keepOnCanvas(zoomed, bounds, canvas) : zoomed;
    return {
        oldViewport,
        newViewport: limitViewport(placed, root.canvasBounds as any, options.horizontalScrollLimits, options.verticalScrollLimits, options.zoomLimits)
    };
}

/**
 * Center, around the content as `viewportContentBounds` sees it: the
 * surface's included, the labels no view draws left out. Its middle goes to
 * the middle of the largest part of the canvas the overlays leave free, as
 * Fit's does, rather than under the palette's edge; at the zoom Sprotty's
 * Center gives (1, or the one there is with `retainZoom`), within the zoom
 * limits. Content that fits the canvas is never left partly off it: where the
 * free area is narrower than it, it stops a margin inside the canvas's edge.
 * Content larger than the canvas covers all of it, as near the free area's
 * middle as that allows.
 */
@injectable()
export class SurfaceAwareCenterCommand extends CenterCommand {
    override getNewViewport(bounds: Bounds, model: GModelRoot): Viewport | undefined {
        const centred = super.getNewViewport(bounds, model);
        const canvas = model.canvasBounds;
        if (!centred || !isValidBounds(canvas) || !(canvas.width > 0 && canvas.height > 0)) {
            return centred;
        }
        const area = largestFreeArea(canvas, overlaysOn(canvas));
        if (!area) {
            return centred;
        }
        const zoom = withinZoomLimits(centred, bounds, (this.viewerOptions as { zoomLimits?: { min: number; max: number } } | undefined)?.zoomLimits).zoom;
        return keepOnCanvas(viewportCentredIn(bounds, area, zoom), bounds, canvas);
    }

    @inject(DiagramSurfaceHost) @optional()
    protected readonly surfaceHost?: DiagramSurfaceHost;

    @inject(HiddenRenderRecord) @optional()
    protected readonly hiddenRender?: HiddenRenderRecord;

    override initialize(model: GModelRoot): void {
        const bounds = viewportContentBounds(
            model as never,
            this.getElementIds() ?? [],
            element => this.boundsInViewport(element as never, (element as { bounds: Bounds }).bounds, model as never),
            this.hiddenRender?.drawn(),
            this.surfaceHost?.content()
        );
        const framed = frameBounds(model, bounds, (b, m) => this.getNewViewport(b, m), this.viewerOptions);
        if (framed) {
            this.oldViewport = framed.oldViewport;
            this.newViewport = framed.newViewport;
        }
    }
}
