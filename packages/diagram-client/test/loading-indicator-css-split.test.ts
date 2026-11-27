/**
 * The loading indicator's rules live in their own stylesheet, which a product
 * with a stylesheet of its own imports alone. diagram-client.css @imports it,
 * so the stock bundle keeps every rule, and holds none of them itself: one
 * copy of each.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const read = (file: string) => readFileSync(path.join(SRC, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The selectors of each rule naming the indicator, inside an at-rule or not. */
function indicatorSelectors(css: string): string[] {
    return [...css.matchAll(/([^{}]+)\{[^{}]*\}/g)]
        .map(match => match[1].trim())
        .filter(selector => selector.includes('.workflow-loading'));
}

describe('loading-indicator.css', () => {
    it('holds the indicator: the card, the circle, the words, the pill and the announcer', () => {
        const css = read('loading-indicator.css');
        const selectors = indicatorSelectors(css).flatMap(selector => selector.split(',').map(part => part.trim()));
        for (const selector of [
            '.workflow-loading',
            '.workflow-loading[hidden]',
            '.workflow-loading-card',
            '.workflow-loading-spinner',
            '.workflow-loading-message',
            '.workflow-loading-detail',
            '.workflow-loading-elapsed',
            '.workflow-loading.workflow-loading-pill',
            '.workflow-loading-pill .workflow-loading-card',
            '.workflow-loading-announcer'
        ]) {
            expect(selectors).toContain(selector);
        }
        expect(css).toMatch(/\.workflow-loading\s*\{[^}]*position:\s*fixed/);
        expect(css).toMatch(/@keyframes workflow-loading-turn/);
        expect(css).toMatch(/prefers-reduced-motion/);
    });

    it('is @imported by diagram-client.css, which keeps no indicator rule of its own', () => {
        const stock = read('diagram-client.css');
        expect(stock).toMatch(/@import '\.\/loading-indicator\.css';/);
        expect(indicatorSelectors(stock)).toEqual([]);
    });
});
