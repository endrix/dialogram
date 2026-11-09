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
 * - a bus node closed takes its topmost member's saved place, the row it
 *   stands in for; open, it takes the row above, its members keeping theirs;
 * - a member of an open bus with no place takes the row under the bus, in
 *   order, a row pitch apart.
 *
 * The members of a closed bus are not drawn, so their saved places are left
 * out of what is returned: the bus now sits on one of them, and a layout with
 * two nodes on one spot counts as unusable too.
 */
import { BoundaryPortGeometry, WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import { nodeLayoutKeyOf } from './layout-snapshot';

type Point = { x: number; y: number };

const BOUNDARY_TYPES = new Set<string>([WorkflowDiagramTypes.NODE_BOUNDARY_INPUT, WorkflowDiagramTypes.NODE_BOUNDARY_OUTPUT]);

/**
 * `positions` (absolute, by layout key) with the places of the boundary buses
 * in `graph` and their open members filled in where missing. Returns
 * `positions` itself when nothing is missing.
 */
export function withBoundaryBusPositions(graph: unknown, positions: Map<string, Point>): Map<string, Point> {
    const pitch = BoundaryPortGeometry.ROW_PITCH_PX;
    let filled: Map<string, Point> | undefined;
    const writable = (): Map<string, Point> => (filled ??= new Map(positions));
    const visit = (element: any): void => {
        const args = element?.args as Record<string, unknown> | undefined;
        const members = args?.['wf:busMembers'];
        const key = nodeLayoutKeyOf(element);
        if (BOUNDARY_TYPES.has(element?.type) && Array.isArray(members) && key) {
            const ids = members.map(String);
            const expanded = args?.[WorkflowDiagramMetadata.PORT_BUS_EXPANDED] === true;
            let at = (filled ?? positions).get(key);
            if (!at) {
                const saved = ids.map(id => positions.get(id)).filter((p): p is Point => p !== undefined);
                const top = saved.reduce<Point | undefined>((best, p) => (!best || p.y < best.y ? p : best), undefined);
                if (top) {
                    at = expanded ? { x: top.x, y: top.y - pitch } : { ...top };
                    writable().set(key, at);
                    if (!expanded) {
                        ids.forEach(id => writable().delete(id));
                    }
                }
            }
            if (at && expanded) {
                const origin = at;
                ids.forEach((id, k) => {
                    if (!(filled ?? positions).has(id)) {
                        writable().set(id, { x: origin.x, y: origin.y + (k + 1) * pitch });
                    }
                });
            }
        }
        for (const child of (element?.children as unknown[] | undefined) ?? []) {
            visit(child);
        }
    };
    visit(graph);
    return filled ?? positions;
}
