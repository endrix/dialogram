/**
 * The context menu's rules live in their own stylesheet, which a product with a
 * stylesheet of its own imports alone (mlir-viewer does). diagram-client.css
 * @imports it, so the stock bundle keeps every rule, and holds none of them
 * itself: one copy of each.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const read = (file: string) => readFileSync(path.join(SRC, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The selectors of each top-level rule naming the menu. */
function menuSelectors(css: string): string[] {
    return [...css.matchAll(/([^{}]+)\{[^{}]*\}/g)]
        .map(match => match[1].trim())
        .filter(selector => selector.includes('.workflow-context-menu'));
}

describe('context-menu.css', () => {
    it('holds the menu, its items, submenus and separators', () => {
        const selectors = menuSelectors(read('context-menu.css')).flatMap(selector => selector.split(',').map(part => part.trim()));
        const moved = [
            '.workflow-context-menu',
            '.workflow-context-menu-item',
            '.workflow-context-menu-item:hover',
            '.workflow-context-menu-item:focus-visible',
            '.workflow-context-menu-item.open',
            '.workflow-context-menu-item.has-children',
            '.workflow-context-menu-label',
            '.workflow-context-menu-chevron',
            '.workflow-context-menu-separator'
        ];
        expect([...selectors].sort()).toEqual([...moved].sort());
        for (const selector of moved) {
            expect(selectors).toContain(selector);
        }
        expect(read('context-menu.css')).toMatch(/\.workflow-context-menu\s*\{[^}]*position:\s*fixed/);
    });

    it('is @imported by diagram-client.css, which keeps no menu rule of its own', () => {
        const stock = read('diagram-client.css');
        expect(stock).toMatch(/@import '\.\/context-menu\.css';/);
        expect(menuSelectors(stock)).toEqual([]);
    });
});
