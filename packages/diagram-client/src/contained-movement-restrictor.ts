/**
 * A member of a group stays inside its group.
 *
 * A member of a group is a child of the group in the model: its position is
 * relative to it, and dragging it moves it within it. Nothing stopped the drag
 * at the frame, so a member could be dropped anywhere, drawn outside the frame
 * it still belongs to, with the frame left where it was. Nothing in the
 * diagram can move a node to another group (`reparentable: false`), so outside
 * is never a place a member can go.
 *
 * GLSP asks the bound `IMovementRestrictor` about every position a drag
 * passes through. A position outside the parent is refused: the node is drawn
 * with `movement-not-allowed` while it is there, and a drop there is not
 * committed, so the node goes back to where it was. A node at the root is
 * never restricted; the canvas has no edge.
 *
 * "Inside" excludes the header band the group's label is drawn in, and keeps
 * a small margin from the left frame line, so a member cannot cover the label
 * or sit on the frame's entry ports. To the right and downwards a group has no
 * limit: the frame grows to fit a member dragged that way (the server does it
 * on the drop, see `growGroupsToFit`).
 *
 * Only groups. A control structure's branch (an if, a loop) holds its members
 * the same way but does not grow, and its layout leaves it only a few pixels
 * of padding around them, so holding a member inside it would leave a lone
 * one almost nowhere to go. Those keep moving freely, as they always have.
 */
import { injectable } from 'inversify';
import { GChildElement, GModelElement, GNode, isMoveable, type IMovementRestrictor, type Point } from '@eclipse-glsp/client';
import { WorkflowDiagramConstants, WorkflowDiagramTypes } from '@dialogram/shared';

type Size = { width: number; height: number };

/** How far from a group's frame a member must stay. */
export const GROUP_MEMBER_MARGIN_PX = 4;

/**
 * The area inside a container a child's top-left corner may take, for a child
 * of `childSize`. A group's area is open to the right and downwards, where the
 * group grows; any other container's is the whole plane (not restricted).
 */
export function allowedArea(
    parentType: string,
    parentSize: Size,
    childSize: Size
): { minX: number; minY: number; maxX: number; maxY: number } {
    const isGroup = parentType === WorkflowDiagramTypes.NODE_GROUP;
    if (isGroup) {
        return {
            minX: GROUP_MEMBER_MARGIN_PX,
            minY: WorkflowDiagramConstants.GROUP_HEADER_HEIGHT_PX + GROUP_MEMBER_MARGIN_PX,
            maxX: Number.POSITIVE_INFINITY,
            maxY: Number.POSITIVE_INFINITY
        };
    }
    return {
        minX: Number.NEGATIVE_INFINITY,
        minY: Number.NEGATIVE_INFINITY,
        maxX: Number.POSITIVE_INFINITY,
        maxY: Number.POSITIVE_INFINITY
    };
}

/**
 * Whether a child of `childSize` at `position` (relative to its parent) lies
 * inside a parent of `parentType` and `parentSize`. A parent without a size
 * yet cannot be judged and allows the move.
 */
export function isInsideParent(parentType: string, parentSize: Size | undefined, childSize: Size, position: Point): boolean {
    if (!parentSize || parentSize.width <= 0 || parentSize.height <= 0) {
        return true;
    }
    const area = allowedArea(parentType, parentSize, childSize);
    return position.x >= area.minX && position.y >= area.minY && position.x <= area.maxX && position.y <= area.maxY;
}

@injectable()
export class ContainedMovementRestrictor implements IMovementRestrictor {
    readonly cssClasses = ['movement-not-allowed'];

    validate(element: GModelElement, newLocation?: Point): boolean {
        if (!newLocation || !(element instanceof GChildElement) || !isMoveable(element)) {
            return false;
        }
        const parent = element.parent;
        if (!(parent instanceof GNode)) {
            return true;
        }
        const size = (element as unknown as { size?: Size }).size ?? { width: 0, height: 0 };
        return isInsideParent(parent.type, parent.size, size, newLocation);
    }
}
