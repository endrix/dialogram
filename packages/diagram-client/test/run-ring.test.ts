/**
 * The colour ring that turns around a node while it is running.
 *
 * A conic gradient — which is what this effect is everywhere else, and which
 * SVG cannot paint: `stroke` takes a colour or an SVG paint server, and there
 * is no conic one. So the ring is an HTML element inside a `foreignObject`,
 * where CSS paints it directly.
 *
 * That choice brings its own ways to be silently wrong, and this pins them: the
 * element has to be in the HTML namespace, the glow needs somewhere to bleed
 * into, the angle has to be declared animatable, and the mask has to cut a band
 * rather than a filled box.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { __testables } from '../src/views';

const { renderRunRing, RUN_RING_BLEED_PX } = __testables;
const css = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/diagram-client.css'),
    'utf8'
);

const ring = (w = 140, h = 60): any => renderRunRing(w, h);

/**
 * The element's tag and data, whichever vnode shape produced it.
 *
 * The SVG factory is stubbed in this package's tests and the HTML one is not,
 * so a node built here can come back in either snabbdom's shape or the stub's.
 * Reading only one would assert against the harness rather than the view.
 */
const tagOf = (vnode: any): string => vnode.sel ?? vnode.tag;
const dataOf = (vnode: any): any => vnode.data ?? vnode.props;

describe('where the ring is drawn', () => {
    it('is a foreignObject, because CSS cannot paint an SVG stroke', () => {
        expect(tagOf(ring())).toBe('foreignObject');
    });

    /**
     * Children of a foreignObject belong to the HTML namespace. Built with the
     * SVG factory they are SVG-namespaced `div`s, which render nothing at all —
     * no error, just an empty node.
     */
    it('holds HTML, not SVG', () => {
        for (const child of ring().children) {
            expect(dataOf(child)?.ns, `${tagOf(child)} must not be SVG-namespaced`).toBeUndefined();
        }
    });

    /**
     * The stub cannot see this one.
     *
     * `@eclipse-glsp/client`'s SVG factory is stubbed in this package's tests
     * and produces no namespace, so building the children with it passes here
     * and renders nothing in the product. These read the REAL factories, where
     * the difference is the whole point, and then check the source actually
     * uses the right one.
     */
    it('uses a factory that does not namespace what it builds', async () => {
        const { svg: realSvg, html: realHtml } = await import('sprotty/lib/lib/jsx');

        expect((realSvg('div', null) as any).data.ns).toBe('http://www.w3.org/2000/svg');
        expect((realHtml('div', null) as any).data.ns).toBeUndefined();
    });

    it('builds the ring’s children with the HTML factory', () => {
        const source = readFileSync(
            path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/views.ts'),
            'utf8'
        );
        const body = /function renderRunRing\([\s\S]*?\n\}/.exec(source)?.[0] ?? '';

        expect(body, 'renderRunRing not found').toContain('foreignObject');
        expect(body).toContain("html('div'");
        expect(body).not.toMatch(/svg\('div'/);
    });

    it('leaves room for the glow to bleed past the node', () => {
        // A foreignObject clips what it holds, so a glow with no room is cut
        // off square at the node's edge.
        const { attrs } = dataOf(ring());

        expect(attrs.x).toBe(-RUN_RING_BLEED_PX);
        expect(attrs.y).toBe(-RUN_RING_BLEED_PX);
        expect(attrs.width).toBe(140 + 2 * RUN_RING_BLEED_PX);
        expect(attrs.height).toBe(60 + 2 * RUN_RING_BLEED_PX);
    });

    it('pulls the band back onto the node’s own edge', () => {
        // The bleed pushes the box outwards; the inset has to take it back, or
        // the ring floats away from the border it is marking.
        expect(css).toMatch(/inset:\s*var\(--wf-ring-bleed\)/);
    });

    it('draws the glow under the band', () => {
        expect(ring().children.map(tagOf)).toEqual(['div', 'div']);
        expect(dataOf(ring().children[0]).class['node-run-ring-glow']).toBe(true);
        expect(dataOf(ring().children[1]).class['node-run-ring-band']).toBe(true);
    });

    it('does not take the pointer from the node underneath', () => {
        expect(css).toMatch(/\.node-run-ring \{[^}]*pointer-events:\s*none/);
    });
});

describe('what makes it turn', () => {
    /**
     * The cost, not the look.
     *
     * `conic-gradient(from var(--angle))` with the angle animated is the
     * shorter way to write this, and it repaints the gradient every frame — per
     * ring, per glow, per running node. That version slowed the editor down.
     * Rotating a layer is composited: the gradient is rasterised once and the
     * frames after it cost nothing to draw.
     */
    it('rotates a layer rather than repainting the gradient', () => {
        const frames = /@keyframes workflow-node-ring-turn\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';

        expect(frames).toMatch(/transform:\s*rotate\(360deg\)/);
        expect(frames).not.toMatch(/--wf-ring-angle/);
    });

    it('does not animate the gradient’s own angle anywhere', () => {
        // Including via `@property`, which only exists to make that animatable.
        expect(css).not.toContain('--wf-ring-angle');
        expect(css).not.toMatch(/conic-gradient\(from/);
    });

    it('gives the turning square its own layer', () => {
        // Without the hint the browser may keep it on a shared layer and
        // repaint its neighbours with it.
        expect(css).toMatch(/\.node-run-ring-spin \{[^}]*will-change:\s*transform/);
    });

    /**
     * A square wide enough for the node's diagonal. Anything smaller leaves a
     * corner uncoloured as it turns, and a rotated rectangle sweeps its own
     * corners through the ring.
     */
    it('turns a square that covers the node’s diagonal', () => {
        const spanOf = (w: number, h: number) => {
            // band > spin: the square lives inside the masked box, not beside it.
            const spin = dataOf(ring(w, h).children[1].children[0]);
            return Number(/([\d.]+)px/.exec(spin.style['--wf-ring-span'])![1]);
        };

        expect(spanOf(140, 60)).toBeGreaterThanOrEqual(Math.hypot(140, 60));
        expect(spanOf(300, 120)).toBeGreaterThanOrEqual(Math.hypot(300, 120));
    });

    it('runs at a constant speed', () => {
        expect(css).toMatch(/animation:\s*workflow-node-ring-turn[^;]*linear/);
    });
});

describe('the band itself', () => {
    it('is cut from the padding rather than filling the box', () => {
        // Excluding the content box is what leaves a ring; without it the node
        // is covered by a solid block of gradient.
        expect(css).toMatch(/mask-composite:\s*exclude/);
        expect(css).toMatch(/padding:\s*var\(--wf-ring-width\)/);
    });

    it('keeps the webkit-prefixed mask beside the standard one', () => {
        // The webview is Chromium; the prefixed pair is what it honours.
        expect(css).toContain('-webkit-mask-composite: xor');
    });

    it('is thin, marking the node rather than framing it', () => {
        const width = /--wf-ring-width:\s*([\d.]+)px/.exec(css)?.[1];

        expect(Number(width)).toBeLessThanOrEqual(2);
    });

    /**
     * A conic gradient wraps, so its first and last stop meet. Different ones
     * leave a seam that turns with the ring.
     */
    it('closes its palette, so the ring has no seam', () => {
        const colors = (/--wf-ring-colors:\s*([^;]+);/.exec(css)?.[1] ?? '')
            .split(',').map(c => c.trim());

        expect(colors.length).toBeGreaterThan(2);
        expect(colors[0]).toBe(colors[colors.length - 1]);
    });

    it('glows in its own colours rather than one', () => {
        // A drop-shadow floods a single colour; a blurred copy keeps every hue.
        expect(css).toMatch(/\.node-run-ring-glow \.node-run-ring-spin \{[^}]*filter:\s*blur/);
    });

    /**
     * And the blur is on the square, not its container. Blurring a container
     * re-blurs it on every frame its child moves — which is the cost this
     * whole approach exists to avoid.
     */
    it('blurs the turning square rather than its container', () => {
        expect(css).not.toMatch(/\.node-run-ring-glow \{[^}]*filter:\s*blur/);
    });
});

describe('when motion is not wanted', () => {
    const reduced = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/g)]
        .map(m => m[1]).find(block => block.includes('node-run-ring')) ?? '';

    it('stops the ring turning but leaves it whole', () => {
        expect(reduced).toMatch(/animation:\s*none/);
    });
});

describe('what it replaces', () => {
    it('leaves no heartbeat running underneath', () => {
        expect(css).not.toContain('workflow-node-glow');
    });

    it('leaves none of the sliced-SVG ring behind', () => {
        // That version faked the gradient with 36 stroked rects and an SVG
        // filter; both are gone, not merely unused.
        expect(css).not.toContain('node-run-ring-slice');
        expect(css).not.toContain('wf-run-ring-bloom');
    });

    it('keeps a dim track so a running node reads as one', () => {
        expect(css).toMatch(/cal-node-active \.node-body \{[^}]*stroke-opacity/);
    });
});
