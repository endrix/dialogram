/**
 * The rules of what Dialogram's root view draws (the level of detail, the
 * links of the selection) live in stylesheets of their own, which a product
 * with views and a stylesheet of its own imports beside that view.
 * diagram-client.css @imports them, so the stock bundle keeps every rule, and
 * holds none of them itself: one copy of each.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const read = (file: string) => readFileSync(path.join(SRC, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The selectors of each rule naming a level of detail. */
function detailSelectors(css: string): string[] {
    return [...css.matchAll(/([^{}]+)\{[^{}]*\}/g)]
        .map(match => match[1].trim())
        .filter(selector => /\.detail-(far|mid|near)\b/.test(selector));
}

describe('selection-links.css', () => {
    it('holds the rules of the links of the selection, @imported by diagram-client.css, which keeps none', () => {
        const css = read('selection-links.css');
        expect(css).toMatch(/\.selection-link \.selection-link-line\s*\{/);
        const stock = read('diagram-client.css');
        expect(stock).toMatch(/@import '\.\/selection-links\.css';/);
        expect(stock).not.toMatch(/\.selection-link/);
    });
});

describe('zoom-detail.css', () => {
    it('hides what each level leaves out, the classes a product tags its text with among them', () => {
        const css = read('zoom-detail.css');
        const selectors = detailSelectors(css).flatMap(selector => selector.split(',').map(part => part.trim()));
        for (const selector of ['.detail-far .zoom-name', '.detail-far .zoom-detail', '.detail-mid .zoom-detail', '.detail-mid text.port-label']) {
            expect(selectors).toContain(selector);
        }
        expect(css).toMatch(/display:\s*none/);
    });

    it('is @imported by diagram-client.css, which keeps no level-of-detail rule of its own', () => {
        const stock = read('diagram-client.css');
        expect(stock).toMatch(/@import '\.\/zoom-detail\.css';/);
        expect(detailSelectors(stock)).toEqual([]);
    });
});
