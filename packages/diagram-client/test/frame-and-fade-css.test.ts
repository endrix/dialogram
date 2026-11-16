/**
 * Three rules of the stylesheet that no view test sees.
 *
 *  - A frame (a group, an if, a foreach: the only nodes marked `read-only`)
 *    takes no cursor and no opacity of its own: both pass to every node it
 *    holds, and a forbidden cursor stood over members that can be selected
 *    and edited.
 *  - The fade of what a selection's links leave out comes after the trace's
 *    fade, as specific for an edge: what both fade is as faded as the links
 *    ask.
 *  - A transition's reach (the wide, unseen stroke the pointer finds) keeps
 *    its width while hovered: the base rule for a hovered edge's paths sets
 *    2px, and a reach that shrank under a pointer near the line ended the
 *    hover that shrank it, so the edge flickered at the screen's rate.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CSS = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/diagram-client.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');

/** Every rule as its selectors and its body, in the order of the file; a rule in an @media block too. */
const rules = CSS.split('}').map(block => block.split('{')).filter(parts => parts.length >= 2)
    .map(parts => ({ selectors: parts[parts.length - 2].split(',').map(each => each.trim()), body: parts[parts.length - 1] }));

describe('a frame', () => {
    it('takes no cursor and no opacity for being read-only', () => {
        const onNodes = rules.filter(rule => rule.selectors.some(selector => /\.workflow-node\S*\.read-only|\.read-only\S*\.workflow-node/.test(selector)));
        for (const rule of onNodes) {
            expect(rule.body, rule.selectors.join(', ')).not.toMatch(/cursor|opacity/);
        }
    });
});

/** A selector's specificity as [ids, classes (and pseudo-classes, a `:not`'s argument), elements]. */
function specificity(selector: string): [number, number, number] {
    const plain = selector.replace(/:not\(([^)]*)\)/g, ' $1');
    const ids = (plain.match(/#[\w-]+/g) ?? []).length;
    const classes = (plain.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+/g) ?? []).length;
    const elements = plain.split(/[\s>+~]+/).filter(part => /^[a-z]/i.test(part)).length;
    return [ids, classes, elements];
}

const outranks = (a: number[], b: number[]): boolean => a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2];

describe('a transition’s reach', () => {
    it('keeps its width while the edge is hovered', () => {
        const hovered = rules.find(rule => rule.selectors.includes('.sprotty-edge.mouseover:not(.selected) path'));
        expect(hovered?.body).toMatch(/stroke-width/);
        const reach = rules.filter(rule => rule.selectors.some(selector => selector.includes('.transition-reach')) && /stroke-width/.test(rule.body));
        expect(reach.length).toBeGreaterThan(0);
        for (const rule of reach) {
            const selector = rule.selectors.find(each => each.includes('.transition-reach'))!;
            expect(outranks(specificity(selector), specificity('.sprotty-edge.mouseover:not(.selected) path')), selector).toBe(true);
        }
    });
});

describe('the two fades', () => {
    it('put the links’ fade after the trace’s, as specific for an edge', () => {
        const at = (selector: string): number => rules.findIndex(rule => rule.selectors.includes(selector));
        for (const selector of ['.wf-trace-faded', '.sprotty-edge.wf-trace-faded', '.wf-focus-faded', '.sprotty-edge.wf-focus-faded']) {
            expect(at(selector), selector).toBeGreaterThanOrEqual(0);
        }
        expect(at('.sprotty-edge.wf-focus-faded')).toBeGreaterThan(at('.sprotty-edge.wf-trace-faded'));
        expect(at('.wf-focus-faded')).toBeGreaterThan(at('.wf-trace-faded'));
    });
});
