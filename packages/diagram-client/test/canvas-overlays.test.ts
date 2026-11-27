// @vitest-environment happy-dom
/**
 * What Fit keeps the drawing clear of: the platform's overlays, and a
 * product's own card marked with `data-canvas-overlay`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { CANVAS_OVERLAY_ATTRIBUTE, overlaysOn } from '../src/canvas-overlays';

const canvas = { x: 0, y: 0, width: 1200, height: 800 };

/** An element drawn at `box` (page pixels). */
function drawn(box: { left: number; top: number; width: number; height: number }, setup: (el: HTMLElement) => void): HTMLElement {
    const el = document.createElement('div');
    setup(el);
    el.getBoundingClientRect = () => ({ ...box, x: box.left, y: box.top, right: box.left + box.width, bottom: box.top + box.height, toJSON: () => box }) as DOMRect;
    document.body.appendChild(el);
    return el;
}

afterEach(() => {
    document.body.replaceChildren();
});

describe('the canvas overlays', () => {
    it('count a product card marked as one', () => {
        drawn({ left: 10, top: 60, width: 280, height: 400 }, el => el.setAttribute(CANVAS_OVERLAY_ATTRIBUTE, ''));
        expect(overlaysOn(canvas)).toEqual([{ x: 10, y: 60, width: 280, height: 400 }]);
    });

    it('leave out a marked card that is hidden, or a card with no mark', () => {
        drawn({ left: 10, top: 60, width: 280, height: 400 }, el => {
            el.setAttribute(CANVAS_OVERLAY_ATTRIBUTE, '');
            el.hidden = true;
        });
        drawn({ left: 400, top: 60, width: 280, height: 400 }, el => el.classList.add('product-card'));
        expect(overlaysOn(canvas)).toEqual([]);
    });

    it('measure a marked card in the canvas pixels', () => {
        drawn({ left: 110, top: 90, width: 200, height: 100 }, el => el.setAttribute(CANVAS_OVERLAY_ATTRIBUTE, ''));
        expect(overlaysOn({ x: 100, y: 50, width: 1200, height: 800 })).toEqual([{ x: 10, y: 40, width: 200, height: 100 }]);
    });
});
