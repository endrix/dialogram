/**
 * Which family a node belongs to, and who decides.
 *
 * The platform draws a node it is told about. `task` and `network` are its own
 * concepts — every dataflow graph has nodes and subgraphs — but a node that is
 * an agent, a tool or a source belongs to one product's taxonomy. Holding those
 * names here meant the platform knew one product's vocabulary and drew every
 * other product's graph plain, and nothing reported it: the colours simply
 * never matched anything.
 */
import { describe, expect, it } from 'vitest';
import { __testables } from '../src/views';
import { nodeFamilyCss } from '../src/palette-icons';

const { resolveNodeFamily } = __testables;

const annotation = (name: string, args: Record<string, string> = {}) => ({
    name,
    arguments: Object.entries(args).map(([n, value]) => ({ name: n, value }))
});

const FAMILIES = [
    { annotation: 'source', color: '#4fa97a', icon: { viewBox: 24, paths: ['M0 0H1V1Z'] } },
    { annotation: 'tool', id: 'tool-script', match: { argument: 'cmd', oneOf: ['python'] }, color: '#b26dff' },
    { annotation: 'tool', color: '#b26dff' },
    { annotation: 'viewer', color: '#49a6b8' }
];

describe('resolving a node’s family', () => {
    it('uses the family the product declared', () => {
        expect(resolveNodeFamily([annotation('tool')], FAMILIES)?.annotation).toBe('tool');
    });

    /**
     * A source carries the openable annotation too — that one says what
     * double-click does, not what the node is — so declaration order is what
     * keeps a source from being painted as its opposite.
     */
    it('takes the first declared match when a node is in two', () => {
        const family = resolveNodeFamily([annotation('viewer'), annotation('source')], FAMILIES);

        expect(family?.annotation).toBe('source');
    });

    it('finds nothing for a node in no family', () => {
        expect(resolveNodeFamily([annotation('streaming')], FAMILIES)).toBeUndefined();
        expect(resolveNodeFamily([], FAMILIES)).toBeUndefined();
        expect(resolveNodeFamily(undefined, FAMILIES)).toBeUndefined();
    });

    /** The point of the change: with no declaration the platform invents none. */
    it('finds nothing when the product declared none', () => {
        expect(resolveNodeFamily([annotation('agent')], [])).toBeUndefined();
    });
});

describe('splitting one annotation into two families', () => {
    it('takes the narrowed family when the value matches', () => {
        const family = resolveNodeFamily([annotation('tool', { cmd: '"python"' })], FAMILIES);

        expect(family?.id).toBe('tool-script');
    });

    it('falls through to the general one otherwise', () => {
        const family = resolveNodeFamily([annotation('tool', { cmd: '"zip"' })], FAMILIES);

        expect(family?.id).toBeUndefined();
        expect(family?.annotation).toBe('tool');
    });

    it('reads the value through its quoting', () => {
        // Annotation values arrive serialized, so a string carries its quotes.
        expect(resolveNodeFamily([annotation('tool', { cmd: "'PYTHON'" })], FAMILIES)?.id)
            .toBe('tool-script');
    });

    it('falls through when the argument is absent', () => {
        expect(resolveNodeFamily([annotation('tool')], FAMILIES)?.id).toBeUndefined();
    });
});

describe('the CSS a declaration generates', () => {
    it('colours the family’s header', () => {
        const css = nodeFamilyCss([{ annotation: 'source', color: '#4fa97a' }]);

        expect(css).toContain('.external-actor-node.external-actor-source');
        expect(css).toContain('#4fa97a');
    });

    it('colours an icon only for a family that has one', () => {
        const withIcon = nodeFamilyCss([FAMILIES[0]]);
        const without = nodeFamilyCss([{ annotation: 'viewer', color: '#49a6b8' }]);

        expect(withIcon).toContain('.node-icon-source');
        expect(without).not.toContain('node-icon');
    });

    it('keys on the id when one annotation splits', () => {
        const css = nodeFamilyCss([FAMILIES[1]]);

        expect(css).toContain('external-actor-tool-script');
    });

    /**
     * These values come from the host and land in a stylesheet, so anything
     * that could close the declaration it sits in is refused rather than
     * written out.
     */
    it('refuses a name that could break out of the selector', () => {
        expect(nodeFamilyCss([{ annotation: 'x, body { display: none }', color: '#fff' }])).toBe('');
    });

    it('refuses a colour that is not a colour', () => {
        expect(nodeFamilyCss([{ annotation: 'source', color: 'red; } body { display: none } .x {' }]))
            .toBe('');
    });

    it('generates nothing when a product declares nothing', () => {
        expect(nodeFamilyCss([])).toBe('');
        expect(nodeFamilyCss(undefined)).toBe('');
    });
});
