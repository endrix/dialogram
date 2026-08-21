/**
 * The feedback-loop rule has to key on the element the class actually lands on.
 *
 * The bug this exists to prevent, which shipped once: the rule was written as
 * `.workflow-edge.workflow-edge-feedback … .edge-line` and matched NOTHING.
 * `workflow-edge` is a view class on a different element, and the line of these
 * edges is a plain `path` — so the toggle worked, the server marked the right
 * edges, and the diagram looked identical either way. A selector that matches
 * nothing fails silently; there is no error anywhere to notice.
 *
 * `cal-edge-error` is the proven convention for a class the SERVER puts on an
 * edge, so this pins the new rule to the same shape rather than to a colour or
 * a pixel: both must be reachable through `.sprotty-edge`, and both must style
 * the `path` as well as the group.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CSS = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/diagram-client.css'),
    'utf8'
);

/** The selector lists of every rule mentioning `token`, comments stripped. */
function selectorsMentioning(token: string): string[] {
    const withoutComments = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    const found: string[] = [];
    for (const block of withoutComments.split('}')) {
        const [selectorPart] = block.split('{');
        if (selectorPart && selectorPart.includes(token)) {
            found.push(selectorPart.trim());
        }
    }
    return found;
}

describe('the feedback-loop edge rule', () => {
    const rules = selectorsMentioning('workflow-edge-feedback').filter(
        selector => !selector.includes('cal-toggle-feedback-edges')
    );

    it('exists at all', () => {
        expect(rules.length).toBeGreaterThan(0);
    });

    it('keys on .sprotty-edge, where a server-supplied edge class lands', () => {
        // The failure mode: `.workflow-edge.workflow-edge-feedback` compounds
        // two classes that are never on the same element, so it matches nothing
        // and says nothing about it.
        for (const selector of rules) {
            expect(selector, selector).toContain('.sprotty-edge');
            expect(selector, selector).not.toContain('.workflow-edge.');
        }
    });

    it('styles the path, not only the group', () => {
        // The stroke lives on the `path`; a rule on the group alone leaves the
        // drawn line untouched.
        expect(rules.some(selector => /\bpath\b/.test(selector))).toBe(true);
    });

    it('follows the same shape as the errored-edge rule it sits beside', () => {
        const errored = selectorsMentioning('cal-edge-error');
        expect(errored.length).toBeGreaterThan(0);
        const keysOnSprottyEdge = (selector: string): boolean => selector.includes('.sprotty-edge');
        expect(errored.every(keysOnSprottyEdge)).toBe(true);
        expect(rules.every(keysOnSprottyEdge)).toBe(true);
    });

    it('is gated on the toggle’s body class, so the palette can switch it off', () => {
        for (const selector of rules) {
            expect(selector, selector).toContain('body.workflow-feedback-edges');
        }
    });

    it('leaves the stroke WIDTH alone — a loop is not an error', () => {
        const withoutComments = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
        for (const block of withoutComments.split('}')) {
            const [selector, body] = block.split('{');
            if (!selector?.includes('workflow-edge-feedback') || !body) {
                continue;
            }
            expect(body, selector.trim()).not.toContain('stroke-width');
        }
    });
});
