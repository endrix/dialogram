/**
 * A source node carries its own icon, the way an agent or a tool does.
 *
 * The icon is chosen from a node's annotations. A source carries two: the one
 * that says what it IS, and the one that makes it openable by double-click.
 * Only the first describes the node — keying on the second would give a source
 * the icon of a viewer, which is the opposite end of a graph.
 */
import { describe, expect, it } from 'vitest';
import { __testables } from '../src/views';

const { resolveNodeIconKind, NodeIconDefs } = __testables;

const annotation = (name: string) => ({ name, arguments: [] });

describe('the icon a source node gets', () => {
    it('is its own, not a viewer’s', () => {
        // Exactly what the exporter emits for a source: both annotations.
        const kind = resolveNodeIconKind([annotation('viewer'), annotation('source')]);

        expect(kind).toBe('source');
    });

    it('is defined, so the node actually draws one', () => {
        // A kind with no definition renders nothing and reports nothing.
        expect(NodeIconDefs.source).toBeDefined();
        expect(NodeIconDefs.source.viewBox).toBeGreaterThan(0);
    });

    /**
     * The glyph is two shapes — a container, and the resource leaving it — and
     * either alone says something else: the container is a box, the arrow is a
     * direction. Losing one renders happily and means the wrong thing, so the
     * count is pinned. Redesigning the icon is meant to update this.
     */
    it('draws both halves of the glyph', () => {
        expect(NodeIconDefs.source.paths).toHaveLength(2);
        for (const path of NodeIconDefs.source.paths) {
            expect(path.length).toBeGreaterThan(20);
        }
    });

    it('does not follow from being openable alone', () => {
        // The control: a viewer carries only the openable annotation, and must
        // keep getting no icon rather than inheriting the source's.
        expect(resolveNodeIconKind([annotation('viewer')])).toBeUndefined();
    });
});

describe('the icons that were already there', () => {
    it('still gives an agent its own', () => {
        expect(resolveNodeIconKind([annotation('agent')])).toBe('agent');
    });

    it('still gives a tool its own', () => {
        expect(resolveNodeIconKind([
            { name: 'tool', arguments: [{ name: 'cmd', value: '"zip"' }] }
        ])).toBe('terminal');
    });

    it('still gives a plain node none', () => {
        expect(resolveNodeIconKind([])).toBeUndefined();
        expect(resolveNodeIconKind(undefined)).toBeUndefined();
    });
});

describe('the icon geometry', () => {
    it('stays inside its own viewBox', () => {
        // Scaled from the viewBox at render time, so anything outside it is
        // clipped — silently, and only visible on the node.
        const { viewBox, paths } = NodeIconDefs.source;
        const numbers = paths.join(' ').match(/-?\d+(?:\.\d+)?/g) ?? [];

        expect(numbers.length).toBeGreaterThan(0);
        for (const value of numbers.map(Number)) {
            expect(value).toBeGreaterThanOrEqual(0);
            expect(value).toBeLessThanOrEqual(viewBox);
        }
    });
});
