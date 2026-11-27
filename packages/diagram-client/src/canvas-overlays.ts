/**
 * What the platform draws over the diagram's canvas, measured: Fit keeps the
 * drawing clear of it (`fit-clear-of-overlays.ts`), and so does a surface's
 * `reveal` with `fit`.
 */
import type { Rect } from './fit-geometry';
import { overlaps } from './fit-geometry';

/**
 * The mark a product puts on what it draws over the canvas (a card, a
 * banner, a toolbar of its own) for Fit and `reveal` to keep the drawing
 * clear of it, as they do of the platform's overlays.
 *
 * - The mark is there by its presence; `"false"` takes it off.
 * - Put it on the one element that holds the card, not on each of its
 *   parts: every overlay is one more obstacle for each fit.
 * - It is read when a fit runs. A card shown after the diagram's first view
 *   counts from the next Fit, so put the card (empty, if its content comes
 *   later) on the page before the first view.
 * - Not counted while it cannot be seen: `hidden`, inside a hidden part of
 *   the canvas, smaller than 2 px, or not visible to the browser
 *   (`display`, `visibility`, an opacity of 0).
 * - A card placed in `freeArea()` is measured there before it carries the
 *   mark, since the area left free then leaves it out.
 */
export const CANVAS_OVERLAY_ATTRIBUTE = 'data-canvas-overlay';

/**
 * The overlays. The chat card (bottom centre, half the width) and the outline
 * (left) float over the canvas as the palette does; the docked property panel
 * is not here because it shrinks the canvas instead of covering it. The last
 * is a product's own, marked with {@link CANVAS_OVERLAY_ATTRIBUTE}.
 */
export const CANVAS_OVERLAYS = [
    '.tool-palette',
    '.minimize-palette-button',
    '.floating-tool-btn',
    '.workflow-breadcrumb-overlay',
    '.workflow-fab-stack',
    '.property-panel.floating:not(.collapsed)',
    '.workflow-chat-panel.visible',
    '.workflow-hierarchy-outline:not([hidden])',
    `[${CANVAS_OVERLAY_ATTRIBUTE}]:not([${CANVAS_OVERLAY_ATTRIBUTE}="false"]):not([hidden])`
];

/**
 * Whether a product's marked card is visible to the browser. The platform's
 * overlays say whether they are shown by a class of their own (`visible`,
 * `collapsed`, `hidden`) and are not asked: one fading in is counted.
 */
function visibleIfMarked(element: HTMLElement): boolean {
    if (!element.hasAttribute(CANVAS_OVERLAY_ATTRIBUTE) || typeof element.checkVisibility !== 'function') {
        return true;
    }
    return element.checkVisibility({ opacityProperty: true, visibilityProperty: true });
}

/** The overlays shown over `canvas` (in the page's pixels), in the canvas's own pixels. */
export function overlaysOn(canvas: Rect): Rect[] {
    if (typeof document === 'undefined') {
        return [];
    }
    const scrollX = window.scrollX ?? 0;
    const scrollY = window.scrollY ?? 0;
    const area: Rect = { x: 0, y: 0, width: canvas.width, height: canvas.height };
    const covered: Rect[] = [];
    for (const element of document.querySelectorAll<HTMLElement>(CANVAS_OVERLAYS.join(','))) {
        if (element.closest('.sprotty-hidden') || !visibleIfMarked(element)) {
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
