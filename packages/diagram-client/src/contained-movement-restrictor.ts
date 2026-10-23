/**
 * A node stays inside the node that holds it.
 *
 * A member of a group, or a node inside a control structure's branch, is a
 * child of that container in the model: its position is relative to it, and
 * dragging it moves it within it. Nothing stopped the drag at the frame, so a
 * member could be dropped anywhere, drawn outside the frame it still belongs
 * to, with the frame left where it was. Nothing in the diagram can move a node
 * to another container (`reparentable: false`), so outside is never a place a
 * node can go.
 *
 * GLSP asks the bound `IMovementRestrictor` about every position a drag
 * passes through. A position outside the parent is refused: the node is drawn
 * with `movement-not-allowed` while it is there, and a drop there is not
 * committed, so the node goes back to where it was. A node at the root is
 * never restricted; the canvas has no edge.
 *
 * Inside a group, "inside" excludes the header band the group's label is
 * drawn in, and keeps a small margin from the frame line, so a member cannot
 * cover the label or sit on the frame's boundary ports.
 */
import { injectable } from 'inversify';
import { GChildElement, GModelElement, GNode, isMoveable, type IMovementRestrictor, type Point } from '@eclipse-glsp/client';
import { WorkflowDiagramConstants, WorkflowDiagramTypes } from '@dialogram/shared';

type Size = { width: number; height: number };

/** How far from a group's frame a member must stay. */
export const GROUP_MEMBER_MARGIN_PX = 4;

/** The area inside a container a child's top-left corner may take, for a child of `childSize`. */
export function allowedArea(
    parentType: string,
    parentSize: Size,
    childSize: Size
): { minX: number; minY: number; maxX: number; maxY: number } {
    const isGroup = parentType === WorkflowDiagramTypes.NODE_GROUP;
    const margin = isGroup ? GROUP_MEMBER_MARGIN_PX : 0;
    const top = isGroup ? WorkflowDiagramConstants.GROUP_HEADER_HEIGHT_PX + margin : 0;
    return {
        minX: margin,
        minY: top,
        maxX: parentSize.width - childSize.width - margin,
        maxY: parentSize.height - childSize.height - margin
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
