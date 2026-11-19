/**
 * What the platform draws over the diagram's canvas, measured: Fit keeps the
 * drawing clear of it (`fit-clear-of-overlays.ts`), and so does a surface's
 * `reveal` with `fit`.
 */
import type { Rect } from './fit-geometry';
import { overlaps } from './fit-geometry';

/**
 * The overlays. The chat card (bottom centre, half the width) and the outline
 * (left) float over the canvas as the palette does; the docked property panel
 * is not here because it shrinks the canvas instead of covering it.
 */
export const CANVAS_OVERLAYS = [
    '.tool-palette',
    '.minimize-palette-button',
    '.floating-tool-btn',
    '.workflow-breadcrumb-overlay',
    '.workflow-fab-stack',
    '.property-panel.floating:not(.collapsed)',
    '.workflow-chat-panel.visible',
    '.workflow-hierarchy-outline:not([hidden])'
];

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
