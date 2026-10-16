/**
 * The export inlines computed styles, so a property it does not ask for is a
 * silent difference between the file and the diagram. Rather than look, this
 * asks the stylesheet: every property it declares must either be carried by the
 * export or be listed below as one that deliberately is not.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SVG_STYLE_PROPS, HTML_STYLE_PROPS } from '../src/svg-export';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STYLESHEET = path.resolve(HERE, '../src/diagram-client.css');

/**
 * Properties an exported diagram is right not to carry, and why. A static
 * picture has no pointer and no time, and the panels these style are chrome
 * around the diagram rather than part of it.
 */
const NOT_EXPORTED: Record<string, string> = {
    animation: 'no time passes in a file',
    'animation-name': 'no time passes in a file',
    'animation-duration': 'no time passes in a file',
    'animation-iteration-count': 'no time passes in a file',
    'animation-timing-function': 'no time passes in a file',
    transition: 'no time passes in a file',
    'transition-property': 'no time passes in a file',
    'transition-duration': 'no time passes in a file',
    cursor: 'nothing to point with',
    'pointer-events': 'nothing to point with',
    'user-select': 'nothing to select',
    outline: 'focus ring, an interaction state',
    'outline-offset': 'focus ring, an interaction state',
    'outline-color': 'focus ring, an interaction state',
    'backdrop-filter': 'panel chrome, never inside the diagram svg',
    'list-style': 'panel chrome, never inside the diagram svg',
    content: 'panel chrome (pseudo-elements, which do not clone anyway)',
    contain: 'a rendering hint, not an appearance',
    'z-index': 'HTML panel stacking; SVG paints in document order',
    position: 'HTML panel layout; the diagram is positioned by transforms',
    top: 'HTML panel layout',
    right: 'HTML panel layout',
    bottom: 'HTML panel layout',
    left: 'HTML panel layout',
    inset: 'HTML panel layout',
    visibility: 'hidden elements are dropped from the export, not styled',
    font: 'shorthand; the computed longhands are carried instead',
    'text-decoration': 'shorthand; the computed longhands are carried instead',
    'border-top-color': 'covered by the border-top longhand',
    resize: 'panel chrome',
    'scrollbar-width': 'panel chrome',
    'will-change': 'a rendering hint, not an appearance',
    'touch-action': 'nothing to touch',
    'image-rendering': 'the diagram holds no raster images',
    '-webkit-backdrop-filter': 'panel chrome, never inside the diagram svg',
    // The palette's agent icon is a masked pseudo-element: chrome, and a
    // pseudo-element does not clone anyway.
    'mask-image': 'palette icon chrome',
    'mask-size': 'palette icon chrome',
    'mask-position': 'palette icon chrome',
    'mask-repeat': 'palette icon chrome',
    'mask-composite': 'palette icon chrome',
    '-webkit-mask': 'palette icon chrome',
    '-webkit-mask-image': 'palette icon chrome',
    '-webkit-mask-size': 'palette icon chrome',
    '-webkit-mask-position': 'palette icon chrome',
    '-webkit-mask-repeat': 'palette icon chrome',
    '-webkit-mask-composite': 'palette icon chrome',
    // `body:not(...)` is a selector the property regex reads as a declaration.
    body: 'a selector, not a property'
};

/** Every property name the stylesheet declares. */
function declaredProperties(): string[] {
    const css = fs.readFileSync(STYLESHEET, 'utf8');
    const names = new Set<string>();
    for (const match of css.matchAll(/(?:^|[;{])\s*([a-z-]+)\s*:/gm)) {
        const name = match[1];
        if (!name.startsWith('--')) {
            names.add(name);
        }
    }
    return [...names].sort();
}

describe('exported style coverage', () => {
    it('carries every property the stylesheet uses, or says why not', () => {
        const carried = new Set([...SVG_STYLE_PROPS, ...HTML_STYLE_PROPS]);
        const uncovered = declaredProperties().filter(name => !carried.has(name) && !(name in NOT_EXPORTED));
        // A new property in diagram-client.css lands here. Either add it to the
        // export lists, or add it to NOT_EXPORTED with the reason it cannot matter.
        expect(uncovered).toEqual([]);
    });

    it('does not excuse a property it actually carries', () => {
        const carried = new Set([...SVG_STYLE_PROPS, ...HTML_STYLE_PROPS]);
        expect(Object.keys(NOT_EXPORTED).filter(name => carried.has(name))).toEqual([]);
    });

    it('keeps the properties whose loss was invisible', () => {
        expect(SVG_STYLE_PROPS).toContain('vector-effect');
        expect(SVG_STYLE_PROPS).toContain('text-decoration-line');
    });
});
