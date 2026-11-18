/**
 * Fit, clear of what is drawn over the canvas.
 *
 * The canvas carries overlays of its own: the tool palette (and its chevron)
 * at the top right, the properties button at the top left, the crumb at the
 * bottom left, the buttons at the bottom right. The stock fit fills the whole
 * canvas with the drawing, edge to edge, so whatever lies under an overlay
 * (an automaton's top states under the palette, a box at the left edge under
 * the button) cannot be seen or reached, and fitting again gives the same view.
 *
 * Here the drawing is fitted, with a margin, into the largest part of the
 * canvas no overlay covers: for each overlay, the canvas left of it, right of
 * it, above or below it, whichever lets the drawing be drawn biggest.
 */
import { Bounds, Dimension, FitToScreenCommand, type Viewport } from '@eclipse-glsp/client';
import type { GModelRoot } from '@eclipse-glsp/sprotty';
import { injectable } from 'inversify';
import { FIT_MARGIN, overlaps, viewportClearOf, type Rect } from './fit-geometry';

/** What the diagram's client draws over its canvas. */
const CANVAS_OVERLAYS = [
    '.tool-palette',
    '.minimize-palette-button',
    '.floating-tool-btn',
    '.workflow-breadcrumb-overlay',
    '.workflow-fab-stack',
    '.workflow-hierarchy-outline:not([hidden])',
    '.property-panel.floating:not(.collapsed)'
];

/** The overlays shown over `canvas` (in the page's pixels), in the canvas's own pixels. */
function overlaysOn(canvas: Bounds): Rect[] {
    if (typeof document === 'undefined') {
        return [];
    }
    const scrollX = window.scrollX ?? 0;
    const scrollY = window.scrollY ?? 0;
    const area: Rect = { x: 0, y: 0, width: canvas.width, height: canvas.height };
    const covered: Rect[] = [];
    for (const element of document.querySelectorAll<HTMLElement>(CANVAS_OVERLAYS.join(','))) {
        if (element.closest('.sprotty-hidden')) {
            continue;
        }
        const box = element.getBoundingClientRect();
        const rect = { x: box.left + scrollX - canvas.x, y: box.top + scrollY - canvas.y, width: box.width, height: box.height };
        if (rect.width >= 2 && rect.height >= 2 && overlaps(rect, area)) {
            covered.push(rect);
        }
    }
    return covered;
}

@injectable()
export class FitClearOfOverlaysCommand extends FitToScreenCommand {
    override getNewViewport(bounds: Bounds, model: GModelRoot): Viewport | undefined {
        const canvas = model.canvasBounds;
        if (!Dimension.isValid(canvas)) {
            return super.getNewViewport(bounds, model);
        }
        return viewportClearOf(bounds, canvas, overlaysOn(canvas), this.action.padding ?? FIT_MARGIN, this.action.maxZoom)
            ?? super.getNewViewport(bounds, model);
    }
}
