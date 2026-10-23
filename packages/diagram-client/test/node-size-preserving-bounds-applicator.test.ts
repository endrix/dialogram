/**
 * Measured bounds move a workflow node but never resize it.
 *
 * Sprotty applies what it measured in its hidden model by writing `size`
 * directly. A node measures as its box plus what is drawn past it, so applying
 * that grew the node: clicking a member of a group did it, since GLSP measures
 * the element a resize might start on, with everything it holds.
 */
import { describe, expect, it } from 'vitest';
import { ActorNode, GroupNode } from '../src/model';
import { NodeSizePreservingBoundsApplicator } from '../src/node-size-preserving-bounds-applicator';

const applicator = new NodeSizePreservingBoundsApplicator();
const apply = (element: any, position: { x: number; y: number } | undefined, size: { width: number; height: number }) =>
    (applicator as any).applyBounds(element, position, size);

describe('applying measured bounds', () => {
    it('moves a workflow node and keeps the size the server gave it', () => {
        const node: any = new ActorNode();
        node.position = { x: 27, y: 39.5 };
        node.size = { width: 217, height: 74 };
        apply(node, { x: 30, y: 40 }, { width: 250.8, height: 72.4 });
        expect(node.size).toEqual({ width: 217, height: 74 });
        expect(node.position).toEqual({ x: 30, y: 40 });
        apply(node, undefined, { width: 300, height: 90 });
        expect(node.size).toEqual({ width: 217, height: 74 });
    });

    it('sizes a workflow node that has no size yet, and anything else, as sprotty does', () => {
        const fresh: any = new ActorNode();
        apply(fresh, { x: 0, y: 0 }, { width: 120, height: 60 });
        expect(fresh.size).toEqual({ width: 120, height: 60 });
        const label: any = { position: { x: 0, y: 0 }, size: { width: 10, height: 10 } };
        apply(label, { x: 1, y: 2 }, { width: 42, height: 12 });
        expect(label.size).toEqual({ width: 42, height: 12 });
        const group: any = new GroupNode();
        apply(group, undefined, { width: 280, height: 127 });
        expect(group.size).toEqual({ width: 280, height: 127 });
    });
});
