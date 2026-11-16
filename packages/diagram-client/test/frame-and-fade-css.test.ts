/**
 * Two rules of the stylesheet that no view test sees.
 *
 *  - A frame (a group, an if, a foreach: the only nodes marked `read-only`)
 *    takes no cursor and no opacity of its own: both pass to every node it
 *    holds, and a forbidden cursor stood over members that can be selected
 *    and edited.
 *  - The fade of what a selection's links leave out comes after the trace's
 *    fade, as specific for an edge: what both fade is as faded as the links
 *    ask.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CSS = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/diagram-client.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');

/** Every rule as its selectors and its body, in the order of the file. */
const rules = CSS.split('}').map(block => block.split('{')).filter(parts => parts.length === 2)
    .map(([selector, body]) => ({ selectors: selector.split(',').map(each => each.trim()), body }));

describe('a frame', () => {
    it('takes no cursor and no opacity for being read-only', () => {
        const onNodes = rules.filter(rule => rule.selectors.some(selector => /\.workflow-node\S*\.read-only|\.read-only\S*\.workflow-node/.test(selector)));
        for (const rule of onNodes) {
            expect(rule.body, rule.selectors.join(', ')).not.toMatch(/cursor|opacity/);
        }
    });
});

describe('the two fades', () => {
    it('put the links’ fade after the trace’s, as specific for an edge', () => {
        const at = (selector: string): number => rules.findIndex(rule => rule.selectors.includes(selector));
        expect(at('.sprotty-edge.wf-trace-faded')).toBeGreaterThanOrEqual(0);
        expect(at('.sprotty-edge.wf-focus-faded')).toBeGreaterThan(at('.sprotty-edge.wf-trace-faded'));
        expect(at('.wf-focus-faded')).toBeGreaterThan(at('.wf-trace-faded'));
    });
});
