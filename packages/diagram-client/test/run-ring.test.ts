/**
 * The colour ring that turns around a node while it is running.
 *
 * The reference is a conic-gradient border — the ring an assistant shows while
 * it works. SVG has no conic gradient, so the perimeter is cut into slices and
 * each is stroked its own hue. That makes three things load-bearing, and none
 * of them announce themselves when wrong: the palette has to close, the slices
 * have to tile, and the whole ring has to turn as one.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { __testables } from '../src/views';
import { runRingFilterMarkup, RUN_RING_FILTER_ID } from '../src/run-ring-filter';

const { renderRunRing, RUN_RING_SLICES } = __testables;
const here = path.dirname(fileURLToPath(import.meta.url));
const css = readFileSync(path.join(here, '../src/diagram-client.css'), 'utf8');

const ring = (w = 140, h = 60): any => renderRunRing(w, h);
const slices = (w = 140, h = 60): any[] => ring(w, h).children;

describe('the ring', () => {
    it('carries the node’s own perimeter', () => {
        // The dash and the travel distance both come from this, so they agree
        // whatever the node's size and the loop closes without a jump.
        expect(ring().props.style['--wf-spin-length']).toBe(String(2 * (140 + 60)));
        expect(ring(300, 120).props.style['--wf-spin-length']).toBe('840');
    });

    it('cuts the border into slices that tile it exactly', () => {
        const slice = Number(ring().props.style['--wf-ring-slice']);

        expect(slices()).toHaveLength(RUN_RING_SLICES);
        expect(slice * RUN_RING_SLICES).toBeCloseTo(1, 10);
    });

    it('traces the node’s own outline', () => {
        expect(slices()[0].props.attrs).toMatchObject({ width: 140, height: 60, rx: 4, ry: 4 });
    });
});

describe('the colours', () => {
    const hueOf = (s: any) => Number(/hsl\((\d+)/.exec(s.props.attrs.stroke)![1]);

    it('gives every slice its own', () => {
        const hues = slices().map(hueOf);

        expect(new Set(hues).size).toBe(RUN_RING_SLICES);
    });

    /**
     * A ring whose palette does not close shows a seam once a lap, exactly
     * where the last colour meets the first — and it turns, so the seam travels
     * and is impossible to miss once seen.
     */
    it('closes the wheel, so the ring has no seam', () => {
        const hues = slices().map(hueOf);
        const step = hues[1] - hues[0];
        const wrap = (360 - hues[hues.length - 1]) + hues[0];

        expect(hues[0]).toBe(0);
        expect(wrap).toBeCloseTo(step, 5);
    });

    it('walks the wheel evenly rather than clustering', () => {
        const hues = slices().map(hueOf);
        const steps = hues.slice(1).map((h, i) => h - hues[i]);

        expect(Math.max(...steps) - Math.min(...steps)).toBeLessThanOrEqual(1);
    });
});

describe('turning as one ring', () => {
    it('starts each slice a slice further into the cycle', () => {
        // Same animation, same distance: only the delay differs. Without the
        // stagger every slice sits on top of the others and the border shows
        // one colour at a time.
        const phases = slices().map((s: any) => Number(s.props.style['--wf-ring-phase']));

        expect(phases[0]).toBe(0);
        for (let i = 1; i < phases.length; i++) {
            expect(phases[i] - phases[i - 1]).toBeCloseTo(1 / RUN_RING_SLICES, 10);
        }
    });

    it('turns the delay into a negative offset', () => {
        // A positive delay would hold every slice still until its turn came.
        expect(css).toMatch(/animation-delay:\s*calc\(.*--wf-ring-phase.*\*\s*-1\)/);
    });

    /**
     * `stroke-dashoffset` counts backwards along the path, and a rect's path
     * runs clockwise from its top-left — so counting DOWN is what sends the
     * ring clockwise. Counting up is equally valid CSS and reverses it.
     */
    it('counts down, which is what makes it clockwise', () => {
        const frames = /@keyframes workflow-node-spin\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';

        expect(frames).toContain('stroke-dashoffset');
        expect(/from\s*\{[^}]*stroke-dashoffset:\s*var\(--wf-spin-length\)/.test(frames)).toBe(true);
        expect(/to\s*\{[^}]*stroke-dashoffset:\s*0/.test(frames)).toBe(true);
    });

    it('runs at a constant speed', () => {
        // Eased, the ring would hesitate at one corner every lap.
        expect(css).toMatch(/animation:\s*workflow-node-spin[^;]*linear/);
    });
});

describe('the bloom', () => {
    it('is what the ring asks for by name', () => {
        // A ring pointing at a filter nobody defined draws unfiltered — a flat
        // rainbow outline, with nothing to say the glow went missing.
        expect(css).toContain(`filter: url(#${RUN_RING_FILTER_ID})`);
        expect(runRingFilterMarkup()).toContain(`id="${RUN_RING_FILTER_ID}"`);
    });

    it('keeps the hues saturated', () => {
        // The default linearRGB interpolation washes them towards grey, which
        // is the one thing the ring cannot afford.
        expect(runRingFilterMarkup()).toContain('color-interpolation-filters="sRGB"');
    });

    it('lays the blur under the ring rather than over it', () => {
        const markup = runRingFilterMarkup();

        expect(markup.indexOf('in="blurred"')).toBeLessThan(markup.indexOf('in="SourceGraphic"'));
    });
});

describe('when motion is not wanted', () => {
    const reduced = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/g)]
        .map(m => m[1]).find(block => block.includes('node-run-ring')) ?? '';

    it('stops the ring turning but leaves it whole', () => {
        // Unlike a single travelling dash, a stopped ring is still a complete
        // border, so the node still reads as running.
        expect(reduced).toMatch(/animation:\s*none/);
        expect(reduced).not.toMatch(/stroke-dasharray:\s*none/);
    });
});

describe('the heartbeat it replaces', () => {
    it('is gone, rather than running underneath', () => {
        expect(css).not.toContain('workflow-node-glow');
    });
});
