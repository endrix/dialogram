/**
 * Fit draws the diagram, with a margin, in the largest part of the canvas
 * the overlays leave free, centred there.
 */
import { describe, expect, it } from 'vitest';
import { freeAreas, viewportClearOf } from '../src/fit-geometry';

const canvas = { width: 1262, height: 877 };
// As measured live: the palette at the top right, the properties button, the crumb, the buttons.
const palette = { x: 848, y: 35, width: 369, height: 251 };
const button = { x: 10, y: 10, width: 32, height: 32 };
const crumb = { x: 10, y: 842, width: 44, height: 19 };
const fabs = { x: 1216, y: 789, width: 32, height: 72 };

/** Where `rect` (model units) is drawn on the canvas under `viewport`. */
function onScreen(rect: { x: number; y: number; width: number; height: number }, viewport: { scroll: { x: number; y: number }; zoom: number }) {
    return {
        x: (rect.x - viewport.scroll.x) * viewport.zoom,
        y: (rect.y - viewport.scroll.y) * viewport.zoom,
        width: rect.width * viewport.zoom,
        height: rect.height * viewport.zoom
    };
}

const clear = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
    a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;

describe('fit, clear of the overlays', () => {
    it('leaves, for one overlay, the canvas on each of its sides', () => {
        expect(freeAreas(canvas, [palette])).toEqual([
            { x: 0, y: 0, width: 848, height: 877 },
            { x: 1217, y: 0, width: 45, height: 877 },
            { x: 0, y: 0, width: 1262, height: 35 },
            { x: 0, y: 286, width: 1262, height: 591 }
        ]);
    });

    for (const [what, content] of [
        ['a square automaton', { x: -40, y: -30, width: 900, height: 830 }],
        ['a wide network', { x: 0, y: 0, width: 1400, height: 240 }],
        ['a tall column', { x: 0, y: 0, width: 200, height: 1600 }]
    ] as const) {
        it(`draws ${what} inside the canvas, a margin in, under no overlay`, () => {
            const covered = [palette, button, crumb, fabs];
            const viewport = viewportClearOf(content, canvas, covered, 16)!;
            const drawn = onScreen(content, viewport);
            expect(drawn.x).toBeGreaterThanOrEqual(16 - 1e-6);
            expect(drawn.y).toBeGreaterThanOrEqual(16 - 1e-6);
            expect(drawn.x + drawn.width).toBeLessThanOrEqual(canvas.width - 16 + 1e-6);
            expect(drawn.y + drawn.height).toBeLessThanOrEqual(canvas.height - 16 + 1e-6);
            for (const over of covered) {
                expect(clear(drawn, over)).toBe(true);
            }
        });
    }

    it('takes the side that draws the drawing biggest: left of the palette for a square, below it for a wide one', () => {
        const square = viewportClearOf({ x: 0, y: 0, width: 900, height: 830 }, canvas, [palette], 16)!;
        expect(onScreen({ x: 0, y: 0, width: 900, height: 830 }, square).x + 900 * square.zoom).toBeLessThanOrEqual(848);
        const wide = viewportClearOf({ x: 0, y: 0, width: 1400, height: 240 }, canvas, [palette], 16)!;
        expect(onScreen({ x: 0, y: 0, width: 1400, height: 240 }, wide).y).toBeGreaterThanOrEqual(286);
        expect(wide.zoom).toBeCloseTo((1262 - 32) / 1400);
    });

    it('fills the canvas, less the margin, with nothing over it', () => {
        const viewport = viewportClearOf({ x: 100, y: 50, width: 400, height: 200 }, { width: 832, height: 432 }, [], 16)!;
        expect(viewport.zoom).toBe(2);
        // Its top left drawn the margin in: (100 - 92) * 2 = 16, (50 - 42) * 2 = 16.
        expect(viewport.scroll).toEqual({ x: 92, y: 42 });
    });

    it('keeps to a zoom asked not to be passed, and gives nothing when no part is free', () => {
        expect(viewportClearOf({ x: 0, y: 0, width: 10, height: 10 }, canvas, [], 16, 1.5)!.zoom).toBe(1.5);
        expect(viewportClearOf({ x: 0, y: 0, width: 10, height: 10 }, canvas, [{ x: -1, y: -1, width: 2000, height: 2000 }], 16)).toBeUndefined();
    });
});
