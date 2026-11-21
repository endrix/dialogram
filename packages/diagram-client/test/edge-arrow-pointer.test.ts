/**
 * An arrowhead lets the pointer through to the port under it.
 *
 * The arrow is drawn over the port it points at, its tip on the port's
 * centre. Found live in ndf-ide: a connection drawn to a port that already
 * had an arrow in it never ended, because the click hit the arrow, and the
 * edge tool, finding no connectable element under the pointer, ignored it.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CSS = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/diagram-client.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');

const rules = CSS.split('}').map(block => block.split('{')).filter(parts => parts.length >= 2)
    .map(parts => ({ selectors: parts[parts.length - 2].split(',').map(each => each.trim()), body: parts[parts.length - 1] }));

describe('an arrowhead', () => {
    it('takes no pointer events', () => {
        const arrow = rules.filter(rule => rule.selectors.includes('.workflow-edge .edge-arrow'));
        expect(arrow).toHaveLength(1);
        expect(arrow[0].body).toMatch(/pointer-events:\s*none/);
    });

    it('is given them back by no other rule', () => {
        const others = rules.filter(rule => rule.selectors.some(selector => selector.includes('edge-arrow'))
            && !rule.selectors.includes('.workflow-edge .edge-arrow'));
        for (const rule of others) {
            expect(rule.body, rule.selectors.join(', ')).not.toMatch(/pointer-events:\s*(?!none)/);
        }
    });
});
