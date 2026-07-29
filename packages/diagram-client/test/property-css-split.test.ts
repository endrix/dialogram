/**
 * D3 oracle — property CSS split preserves every property selector exactly once.
 *
 * The property-panel + field-toolkit rules were carved out of diagram-client.css
 * into property-panel.css (imported at the top). This test parses BOTH current
 * stylesheets, collects every `.property-*`/`.pp-*` selector occurrence, and
 * asserts the multiset is byte-for-byte the pre-split baseline snapshot — so no
 * property selector was lost, duplicated, or renamed by the move. It also asserts
 * property-panel.css is @imported (self-contained section) and that the moved
 * rules now live in property-panel.css, not diagram-client.css.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import baseline from './fixtures/property-selectors-baseline.json';

const dir = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(dir, '../src');
const read = (f: string) => readFileSync(path.join(SRC, f), 'utf8');

const PROP = /\.(property[\w-]*|pp-[\w-]*)/;

/** Extract each property-selector occurrence from a flat CSS file (top-level rules). */
function propSelectors(css: string): string[] {
    css = css.replace(/\/\*[\s\S]*?\*\//g, ''); // strip comments
    const out: string[] = [];
    let depth = 0;
    let i = 0;
    let start = 0;
    const preludes: string[] = [];
    let sel = '';
    while (i < css.length) {
        const c = css[i];
        if (c === '"' || c === "'") {
            const q = c;
            i++;
            while (i < css.length && css[i] !== q) i += css[i] === '\\' ? 2 : 1;
            i++;
            continue;
        }
        if (c === ';' && depth === 0) {
            preludes.length = 0;
            i++;
            start = i;
            continue;
        }
        if (c === '{') {
            if (depth === 0) sel = preludes.join('').trim();
            depth++;
            i++;
            continue;
        }
        if (c === '}') {
            depth--;
            i++;
            if (depth === 0) {
                if (sel && !sel.startsWith('@')) {
                    for (const s of sel.split(',')) {
                        const t = s.trim();
                        if (PROP.test(t)) out.push(t);
                    }
                }
                preludes.length = 0;
                start = i;
            }
            continue;
        }
        if (depth === 0) preludes.push(c);
        i++;
    }
    return out;
}

function multiset(arr: string[]): Record<string, number> {
    const m: Record<string, number> = {};
    for (const s of arr) m[s] = (m[s] ?? 0) + 1;
    return m;
}

describe('property CSS split — selector preservation', () => {
    const panel = read('property-panel.css');
    const client = read('diagram-client.css');
    const combined = multiset([...propSelectors(panel), ...propSelectors(client)]);

    it('preserves the exact pre-split property-selector multiset across both files', () => {
        expect(combined).toEqual(baseline as Record<string, number>);
    });

    it('every baseline property selector still exists (at least once) after the split', () => {
        for (const sel of Object.keys(baseline)) {
            expect(combined[sel], `selector missing after split: ${sel}`).toBeGreaterThanOrEqual(1);
        }
    });

    it('@imports property-panel.css at the top so esbuild bundles it as a section', () => {
        expect(client).toContain("@import './property-panel.css';");
        // Must precede the first non-import rule (:root) — esbuild rejects mid-file @import.
        const imp = client.indexOf("@import './property-panel.css';");
        const firstRoot = client.indexOf(':root');
        expect(imp).toBeGreaterThan(-1);
        expect(imp).toBeLessThan(firstRoot);
    });

    it('moves the panel shell/rows/field-toolkit rules into property-panel.css', () => {
        const moved = propSelectors(panel);
        expect(moved).toContain('.property-panel');
        expect(moved).toContain('.property-row');
        expect(moved).toContain('.property-panel-header');
        expect(moved).toContain('.pp-num-field');
        // A generic-key workflow-content override stays in diagram-client.css.
        expect(propSelectors(client)).toContain('.property-panel .mini-btn');
    });
});
