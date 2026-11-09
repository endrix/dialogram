/**
 * Places a bundle of the unit's ports from the layout around it.
 *
 * A bundle of boundary nodes drawn as one (port-bundles.ts) adds nodes a
 * saved layout may not hold: the bus node itself, in a layout saved before
 * the bundle was drawn as one, and its members, the first time it is opened.
 * A node without a saved position has the whole diagram laid out again
 * (`savedLayoutIsUsable`), losing what the reader arranged. Both have a place
 * that follows from the layout, so they take it instead:
 *
 * - a closed bus with no place takes its topmost member's saved place, the
 *   row it stands in for;
 * - the members of an open bus, when none of them has a place (it was just
 *   opened), take the rows under it, in order, a row pitch apart.
 *
 * Anything else missing is left missing, and handled as any new node is: an
 * open bus with no place of its own, or a member added to a bundle laid out
 * open, has no row that is sure to be free.
 *
 * The members of a closed bus are not drawn, so their saved places are left
 * out of what is returned: the bus may sit on one of them, and a layout with
 * two nodes on one spot counts as unusable too.
 */
import { BoundaryPortGeometry, WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import { nodeLayoutKeyOf } from './layout-snapshot';

type Point = { x: number; y: number };

/** The members' node ids of a boundary node standing for a bundle of the unit's ports. */
export function boundaryBusMembersOf(element: unknown): string[] | undefined {
    const type = (element as { type?: unknown })?.type;
    if (type !== WorkflowDiagramTypes.NODE_BOUNDARY_INPUT && type !== WorkflowDiagramTypes.NODE_BOUNDARY_OUTPUT) {
        return undefined;
    }
    const members = (element as { args?: Record<string, unknown> }).args?.[WorkflowDiagramMetadata.BOUNDARY_BUS_MEMBERS];
    return Array.isArray(members) ? members.map(String) : undefined;
}

/**
 * `positions` (absolute, by layout key) with the places of the boundary buses
 * in `graph` and their open members filled in where missing, and the places
 * of closed buses' members left out. Returns `positions` itself, unchanged,
 * when there is nothing to do.
 */
export function withBoundaryBusPositions(graph: unknown, positions: Map<string, Point>): Map<string, Point> {
    const pitch = BoundaryPortGeometry.ROW_PITCH_PX;
    let filled: Map<string, Point> | undefined;
    const writable = (): Map<string, Point> => (filled ??= new Map(positions));
    const visit = (element: any): void => {
        const members = boundaryBusMembersOf(element);
        const key = nodeLayoutKeyOf(element);
        if (members && key) {
            const expanded = element.args?.[WorkflowDiagramMetadata.PORT_BUS_EXPANDED] === true;
            let at = positions.get(key);
            if (!expanded) {
                if (!at) {
                    const saved = members.map(id => positions.get(id)).filter((p): p is Point => p !== undefined);
                    const top = saved.reduce<Point | undefined>((best, p) => (!best || p.y < best.y ? p : best), undefined);
                    if (top) {
                        at = { ...top };
                        writable().set(key, at);
                    }
                }
                for (const id of members) {
                    if (positions.has(id)) {
                        writable().delete(id);
                    }
                }
            } else if (at && !members.some(id => positions.has(id))) {
                const origin = at;
                members.forEach((id, k) => writable().set(id, { x: origin.x, y: origin.y + (k + 1) * pitch }));
            }
        }
        for (const child of (element?.children as unknown[] | undefined) ?? []) {
            visit(child);
        }
    };
    visit(graph);
    return filled ?? positions;
}
