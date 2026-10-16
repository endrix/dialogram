/**
 * The two translations an exported SVG needs, and the file name it gets.
 *
 * The geometry and the style walk need a real browser (getBBox, getCTM,
 * getComputedStyle); these are the pure parts, ported with the extraction from
 * the mlir-viewer, where both were found by looking at an exported file.
 */
import { describe, it, expect } from 'vitest';
import { localizeUrls, normalizeColors, svgFileName } from '../src/svg-export';

describe('exported style values', () => {
    it('turns an absolute marker reference back into a fragment', () => {
        // A computed `marker-end` comes back resolved against the webview's own
        // origin, which does not exist in a file. The defs travel with the
        // export, so the fragment is the whole reference.
        expect(localizeUrls('url("vscode-webview://abc123/index.html#arrow")')).toBe('url(#arrow)');
        expect(localizeUrls('url(#arrow)')).toBe('url(#arrow)');
        expect(localizeUrls('none')).toBe('none');
    });

    it('rewrites CSS Color 4 as rgb(), which every renderer understands', () => {
        // Chrome hands out `color(srgb …)` for a themed fill. librsvg and
        // Inkscape cannot parse it, and an unparsable `fill` falls back to the
        // SVG initial value, black.
        expect(normalizeColors('color(srgb 0.890196 0.941255 1)')).toBe('rgb(227, 240, 255)');
        expect(normalizeColors('color(srgb 0 0 0 / 0.5)')).toBe('rgba(0, 0, 0, 0.5)');
        expect(normalizeColors('color(srgb 1 1 1 / 1)')).toBe('rgb(255, 255, 255)');
        expect(normalizeColors('rgb(45, 45, 45)')).toBe('rgb(45, 45, 45)');
    });
});

describe('the suggested file name', () => {
    it('keeps a workflow name readable and a path impossible', () => {
        expect(svgFileName('speculation')).toBe('speculation');
        expect(svgFileName('compile/speculation flow')).toBe('compile_speculation_flow');
        expect(svgFileName('../../etc/passwd')).toBe('.._.._etc_passwd');
    });

    it('always yields something to save', () => {
        expect(svgFileName('///')).toBe('diagram');
        expect(svgFileName('')).toBe('diagram');
        expect(svgFileName('x'.repeat(200)).length).toBe(80);
    });
});
