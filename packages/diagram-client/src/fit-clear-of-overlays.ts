/**
 * Fit, clear of what is drawn over the canvas.
 *
 * The canvas carries overlays of its own: the tool palette (and its chevron)
 * at the top right, the properties button at the top left, the crumb at the
 * bottom left, the buttons at the bottom right, the chat card and the outline
 * when they are open (`canvas-overlays.ts`). The stock fit fills the whole
 * canvas with the drawing, edge to edge, so whatever lies under an overlay
 * (an automaton's top states under the palette, a box at the left edge under
 * the button) cannot be seen or reached, and fitting again gives the same view.
 *
 * Here the drawing is fitted, with a margin, into the largest part of the
 * canvas no overlay covers: for each overlay, the canvas left of it, right of
 * it, above or below it, whichever lets the drawing be drawn biggest.
 *
 * What the drawing is, is `viewport-content.ts`'s: a surface's bounds join
 * the graph's, and labels no view draws are left out. A fit that names no
 * `maxZoom` zooms no further than the profile's `clientBehavior.fitMaxZoom`.
 */
import { Dimension, FitToScreenCommand, type Bounds, type Viewport } from '@eclipse-glsp/client';
import type { GModelRoot } from '@eclipse-glsp/sprotty';
import { inject, injectable, optional } from 'inversify';
import { FIT_MARGIN, viewportClearOf } from './fit-geometry';
import { overlaysOn } from './canvas-overlays';
import { DiagramSurfaceHost } from './diagram-surface-host';
import { HiddenRenderRecord, frameBounds, viewportContentBounds } from './viewport-content';
import { fitMaxZoom } from './profile';

@injectable()
export class FitClearOfOverlaysCommand extends FitToScreenCommand {
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

    override getNewViewport(bounds: Bounds, model: GModelRoot): Viewport | undefined {
        const canvas = model.canvasBounds;
        if (!Dimension.isValid(canvas)) {
            return super.getNewViewport(bounds, model);
        }
        const margin = this.action.padding ?? FIT_MARGIN;
        const cap = this.action.maxZoom ?? fitMaxZoom();
        // No free area with room for the margin: the whole canvas, as the stock
        // fit does, but capped (the stock fit knows only the action's maxZoom).
        return viewportClearOf(bounds, canvas, overlaysOn(canvas), margin, cap)
            ?? viewportClearOf(bounds, canvas, [], margin, cap)
            ?? super.getNewViewport(bounds, model);
    }
}
