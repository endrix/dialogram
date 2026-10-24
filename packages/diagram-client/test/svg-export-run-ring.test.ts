/**
 * A running node's ring in an export: a stroke in the ring's colours on the
 * node's edge, not the editor's masked HTML square, which a file cannot carry
 * (standalone renderers draw no HTML, and the box placement and mask it needs
 * are not copied).
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runRingStroke, splitColorList } from '../src/svg-export';

describe('the run ring in an export', () => {
    it('reads the ring colours, commas inside a function kept', () => {
        expect(splitColorList('#ff5f6d, #ffc371,#f9f871')).toEqual(['#ff5f6d', '#ffc371', '#f9f871']);
        expect(splitColorList('rgb(1, 2, 3), color(srgb 0.1 0.2 0.3 / 0.5), hsl(10 20% 30%)'))
            .toEqual(['rgb(1, 2, 3)', 'color(srgb 0.1 0.2 0.3 / 0.5)', 'hsl(10 20% 30%)']);
        expect(splitColorList('')).toEqual([]);
    });

    it('runs the stroke down the middle of the band, just inside the node’s edge', () => {
        // The foreignObject reaches 6 px past a 200 × 74 node on every side.
        const stroke = runRingStroke({ x: -6, y: -6, width: 212, height: 86 }, 6, 1.5, 4);
        expect(stroke).toEqual({ x: 0.75, y: 0.75, width: 198.5, height: 72.5, rx: 3.25, strokeWidth: 1.5 });
    });

    it('never draws a negative box or radius', () => {
        const stroke = runRingStroke({ x: -6, y: -6, width: 12, height: 12 }, 6, 2, 0);
        expect(stroke.width).toBe(0);
        expect(stroke.height).toBe(0);
        expect(stroke.rx).toBe(0);
    });

    it('is what the export does with a ring, before styles are copied', () => {
        const here = path.dirname(fileURLToPath(import.meta.url));
        const source = readFileSync(path.resolve(here, '../src/svg-export.ts'), 'utf8');
        const inline = source.slice(source.indexOf('function inlineStyles('));
        expect(inline).toContain("source.localName === 'foreignObject' && source.classList.contains('node-run-ring')");
        expect(inline.indexOf('exportedRunRing(source, clone)')).toBeLessThan(inline.indexOf('const props = isHtmlElement(source)'));
    });
});
