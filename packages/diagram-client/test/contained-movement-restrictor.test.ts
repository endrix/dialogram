/**
 * A dragged node stays inside the node that holds it.
 *
 * The rule is a function of the parent's type and size, the child's size and
 * the position asked for, relative to the parent; the restrictor applies it to
 * every position a drag passes through and GLSP refuses the ones it rejects.
 */
import { describe, expect, it } from 'vitest';
import { GChildElement, GNode, moveFeature } from '@eclipse-glsp/client';
import { WorkflowDiagramConstants, WorkflowDiagramTypes } from '@dialogram/shared';
import {
    ContainedMovementRestrictor,
    GROUP_MEMBER_MARGIN_PX,
    allowedArea,
    isInsideParent
} from '../src/contained-movement-restrictor';

const HEADER = WorkflowDiagramConstants.GROUP_HEADER_HEIGHT_PX;
const GROUP = WorkflowDiagramTypes.NODE_GROUP;

describe('inside the parent', () => {
    const parent = { width: 300, height: 200 };
    const child = { width: 100, height: 60 };

    it('keeps a group member below the header band and off the frame line', () => {
        const area = allowedArea(GROUP, parent, child);
        expect(area).toEqual({
            minX: GROUP_MEMBER_MARGIN_PX,
            minY: HEADER + GROUP_MEMBER_MARGIN_PX,
            maxX: 300 - 100 - GROUP_MEMBER_MARGIN_PX,
            maxY: 200 - 60 - GROUP_MEMBER_MARGIN_PX
        });
        expect(isInsideParent(GROUP, parent, child, { x: 20, y: 40 })).toBe(true);
        expect(isInsideParent(GROUP, parent, child, { x: 20, y: HEADER - 1 })).toBe(false);
        expect(isInsideParent(GROUP, parent, child, { x: -10, y: 40 })).toBe(false);
        expect(isInsideParent(GROUP, parent, child, { x: 250, y: 40 })).toBe(false);
        expect(isInsideParent(GROUP, parent, child, { x: 20, y: 180 })).toBe(false);
    });

    it('keeps a node in another container within its box', () => {
        expect(isInsideParent('node:structure:if:branch', parent, child, { x: 0, y: 0 })).toBe(true);
        expect(isInsideParent('node:structure:if:branch', parent, child, { x: 200, y: 140 })).toBe(true);
        expect(isInsideParent('node:structure:if:branch', parent, child, { x: 201, y: 0 })).toBe(false);
    });

    it('allows the move when the parent has no size to judge by', () => {
        expect(isInsideParent(GROUP, undefined, child, { x: 9999, y: 9999 })).toBe(true);
        expect(isInsideParent(GROUP, { width: 0, height: 0 }, child, { x: 9999, y: 9999 })).toBe(true);
    });
});

describe('the restrictor', () => {
    const restrictor = new ContainedMovementRestrictor();
    const member = (parentType: string): GNode => {
        const parent = new GNode();
        parent.type = parentType;
        parent.size = { width: 300, height: 200 };
        const node = new GNode();
        node.size = { width: 100, height: 60 };
        node.features.add(moveFeature);
        node.parent = parent;
        return node;
    };

    it('refuses a member dragged out of its group, and allows it inside', () => {
        const node = member(GROUP);
        expect(restrictor.validate(node as any, { x: 20, y: 40 })).toBe(true);
        expect(restrictor.validate(node as any, { x: 400, y: 40 })).toBe(false);
        expect(restrictor.cssClasses).toEqual(['movement-not-allowed']);
    });

    it('never restricts a node at the root', () => {
        const node = new GNode();
        node.size = { width: 100, height: 60 };
        node.features.add(moveFeature);
        node.parent = { type: 'graph' };
        expect(restrictor.validate(node as any, { x: -5000, y: 9000 })).toBe(true);
    });

    it('refuses what cannot move at all, and a move with nowhere to go', () => {
        const fixed = member(GROUP);
        fixed.features.clear();
        expect(restrictor.validate(fixed as any, { x: 20, y: 40 })).toBe(false);
        expect(restrictor.validate(member(GROUP) as any, undefined)).toBe(false);
        expect(restrictor.validate(new GChildElement() as any, { x: 0, y: 0 })).toBe(false);
    });
});
