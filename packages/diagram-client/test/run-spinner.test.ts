/**
 * The light that travels around a node while it is running.
 *
 * This is SVG, which has no conic gradient, so the border cannot be painted the
 * way a chat box paints one. A single dash moving along the perimeter is the
 * same effect by the means the medium has — and it brings one constraint the
 * gradient version does not: the dash pattern and the distance it travels have
 * to agree, or the head jumps once per revolution.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { __testables } from '../src/views';

const { renderRunSpinner } = __testables;
const css = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/diagram-client.css'),
    'utf8'
);

describe('the spinner element', () => {
    it('carries the node’s own perimeter', () => {
        // Both the dash pattern and the travel distance are derived from this
        // one number, so they cannot disagree.
        const vnode: any = renderRunSpinner(140, 60);

        expect(vnode.props.style['--wf-spin-length']).toBe(String(2 * (140 + 60)));
    });

    it('scales with the node, so every size takes one revolution', () => {
        const small: any = renderRunSpinner(100, 40);
        const large: any = renderRunSpinner(300, 120);

        expect(small.props.style['--wf-spin-length']).toBe('280');
        expect(large.props.style['--wf-spin-length']).toBe('840');
    });

    it('traces the node’s own outline', () => {
        const vnode: any = renderRunSpinner(140, 60);

        expect(vnode.props.attrs).toMatchObject({ width: 140, height: 60, rx: 4, ry: 4 });
        expect(vnode.props.class['node-run-spinner']).toBe(true);
    });
});

describe('the direction it travels', () => {
    const keyframes = /@keyframes workflow-node-spin\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';

    it('has somewhere to read the direction from', () => {
        // Guards the regex: an empty match would make the checks below vacuous.
        expect(keyframes).toContain('stroke-dashoffset');
    });

    /**
     * `stroke-dashoffset` counts BACKWARDS along the path, and a rect's path
     * runs clockwise from its top-left. So counting DOWN to zero moves the
     * light forwards — clockwise. Animating the other way is equally valid CSS
     * and sends it anticlockwise, which is why this is pinned rather than left
     * to be read off the numbers.
     */
    it('counts down, which is what makes it clockwise', () => {
        const from = /from\s*\{[^}]*stroke-dashoffset:\s*([^;]+);/.exec(keyframes)?.[1]?.trim();
        const to = /to\s*\{[^}]*stroke-dashoffset:\s*([^;]+);/.exec(keyframes)?.[1]?.trim();

        expect(from).toBe('var(--wf-spin-length)');
        expect(to).toBe('0');
    });

    it('runs at a constant speed', () => {
        // Eased, the light would hesitate at one corner every lap.
        expect(css).toMatch(/animation:\s*workflow-node-spin[^;]*linear/);
    });
});

describe('when motion is not wanted', () => {
    // The block that styles the spinner, not the first reduced-motion block in
    // the file — there is more than one.
    const reduced = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/g)]
        .map(m => m[1]).find(block => block.includes('node-run-spinner')) ?? '';

    it('stops the animation', () => {
        expect(reduced).toContain('.node-run-spinner');
        expect(reduced).toMatch(/animation:\s*none/);
    });

    /**
     * And drops the dash with it. Stopping the animation alone would freeze one
     * bright fifth of the border and leave a running node looking broken rather
     * than busy.
     */
    it('lights the whole border instead of freezing a fragment', () => {
        expect(reduced).toMatch(/stroke-dasharray:\s*none/);
    });
});

describe('the heartbeat it replaces', () => {
    it('is gone, rather than running underneath', () => {
        // Both at once reads as two different signals for one state.
        expect(css).not.toContain('workflow-node-glow');
    });

    it('leaves the border visible while the light is elsewhere', () => {
        // The track: without it a node is unmarked for most of each lap.
        expect(css).toMatch(/cal-node-active \.node-body \{[^}]*stroke-opacity/);
    });
});
