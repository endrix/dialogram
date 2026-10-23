/**
 * A group's geometry when a saved layout is reopened.
 *
 * A saved layout restores node positions and edge routes and skips the
 * layout run. A group's size and the ports on its frame come from that run
 * alone (ELK sizes a group around its members and places its boundary ports
 * where its crossing edges leave or enter it), and neither is saved. Left as
 * they come from the model, a reopened group had no size, so the client drew
 * it at a default 200 by 80 with its members outside it, and every boundary
 * port sat in the group's corner, pulling the edges there.
 *
 * Both are recovered from what was saved:
 *
 * - a group is sized around its members, plus the padding and header the
 *   layout gives it, innermost group first so a nested group counts at its
 *   own size, and wide enough to reach where a saved route left it by a port
 *   on its right (the layout keeps a layer free between the members and those
 *   ports);
 * - a boundary port goes on its side of the frame (left for edges coming in,
 *   right for edges going out), at the height where its saved route crossed
 *   the frame: the start of the piece inside for a port edges enter by, the
 *   end of it for a port they leave by. Without a saved route it goes level
 *   with the port of the member it leads to.
 *
 * Routes are absolute, as every route in a layout file is; the snap that then
 * re-attaches each route to its ports (`applyPersistedEdgeRoutes`) finds the
 * ports where the routes expect them.
 */
import { GEdge, GModelElement, GModelRoot, GNode, GPort } from '@eclipse-glsp/server';
import { WorkflowDiagramConstants, WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';

type Point = { x: number; y: number };
type Size = { width: number; height: number };

function absolutePosition(element: GModelElement | undefined): Point {
    let x = 0;
    let y = 0;
    let current: any = element;
    while (current) {
        if (current.position) {
            x += current.position.x ?? 0;
            y += current.position.y ?? 0;
        }
        current = current.parent;
    }
    return { x, y };
}

function sizeOf(element: GModelElement): Size | undefined {
    const size = (element as any).size as Size | undefined;
    return size && size.width > 0 && size.height > 0 ? size : undefined;
}

function isGroup(element: GModelElement): element is GNode {
    return element instanceof GNode && element.type === WorkflowDiagramTypes.NODE_GROUP;
}

/** Every group under `element`, innermost first. */
function groupsInnermostFirst(element: GModelElement, out: GNode[] = []): GNode[] {
    for (const child of (element as any).children ?? []) {
        groupsInnermostFirst(child, out);
    }
    if (isGroup(element)) {
        out.push(element);
    }
    return out;
}

/**
 * The size a group takes around its members: their extent, the padding below
 * them, and on the right the same inset they have on the left.
 */
export function groupSizeAroundMembers(group: GNode): Size {
    const header: number = WorkflowDiagramConstants.GROUP_HEADER_HEIGHT_PX;
    const pad: number = WorkflowDiagramConstants.GROUP_PADDING_PX;
    let left = Number.POSITIVE_INFINITY;
    let right = 0;
    let bottom: number = header;
    for (const child of group.children) {
        if (child instanceof GPort || child instanceof GEdge || !(child instanceof GNode)) {
            continue;
        }
        const size = sizeOf(child);
        if (!size) {
            continue;
        }
        left = Math.min(left, child.position?.x ?? 0);
        right = Math.max(right, (child.position?.x ?? 0) + size.width);
        bottom = Math.max(bottom, (child.position?.y ?? 0) + size.height);
    }
    // The layout insets the members from the left by the padding, and further
    // when edges enter on that side; the right inset mirrors it.
    const inset = Number.isFinite(left) ? Math.max(pad, left) : pad;
    return { width: Math.max(right + inset, 2 * pad), height: Math.max(bottom + pad, header + 2 * pad) };
}

/**
 * Size every group around its members and put each boundary port back on its
 * frame, from the saved routes (absolute, by edge id) where there are any.
 */
export function restoreGroupGeometry(root: GModelRoot, routes?: Map<string, Point[]>): void {
    const groups = groupsInnermostFirst(root);
    if (groups.length === 0) {
        return;
    }
    const edges: GEdge[] = [];
    const collectEdges = (element: GModelElement): void => {
        if (element instanceof GEdge) {
            edges.push(element);
        }
        for (const child of (element as any).children ?? []) {
            collectEdges(child);
        }
    };
    collectEdges(root);
    const byId = new Map<string, GModelElement>();
    const index = (element: GModelElement): void => {
        byId.set(element.id, element);
        for (const child of (element as any).children ?? []) {
            index(child);
        }
    };
    index(root);

    const portSize = WorkflowDiagramConstants.GROUP_BOUNDARY_PORT_SIZE_PX;
    const header = WorkflowDiagramConstants.GROUP_HEADER_HEIGHT_PX;
    for (const group of groups) {
        const origin = absolutePosition(group);
        const crossings: Array<{ port: GPort; size: Size; entering: boolean; at?: Point; inner?: GModelElement }> = [];
        for (const port of group.children) {
            if (!(port instanceof GPort) || port.type !== WorkflowDiagramTypes.PORT_GROUP_BOUNDARY) {
                continue;
            }
            const size = sizeOf(port) ?? { width: portSize, height: portSize };
            const entering = (port as any).args?.[WorkflowDiagramMetadata.PORT_SIDE] !== 'EAST';
            // The piece inside the group: from this port (edges enter by it)
            // or to it (edges leave by it). Its saved route touches the port
            // at the port's anchor: the left edge of the port box on the left
            // side, the right edge on the right.
            const inside = edges.find(edge => (entering ? edge.sourceId : edge.targetId) === port.id);
            const route = inside ? routes?.get(inside.id) : undefined;
            const at = route && route.length > 0 ? (entering ? route[0] : route[route.length - 1]) : undefined;
            const inner = inside ? byId.get(entering ? inside.targetId : inside.sourceId) : undefined;
            crossings.push({ port, size, entering, at, inner });
        }

        // The members set the size, except that the layout leaves room between
        // them and the ports on the right (a layer of its own), which a route
        // leaving by one of those ports records exactly.
        const size = groupSizeAroundMembers(group);
        for (const crossing of crossings) {
            if (!crossing.entering && crossing.at) {
                size.width = Math.max(size.width, crossing.at.x - origin.x - crossing.size.width / 2);
            }
        }
        group.size = size;

        for (const { port, size: box, entering, at, inner } of crossings) {
            let centreY: number | undefined = at ? at.y - origin.y : undefined;
            if (centreY === undefined && inner) {
                const innerSize = sizeOf(inner) ?? { width: 0, height: 0 };
                centreY = absolutePosition(inner).y + innerSize.height / 2 - origin.y;
            }
            const minY = header + box.height / 2;
            const maxY = group.size.height - box.height / 2;
            const y = Math.min(Math.max(centreY ?? minY, minY), Math.max(minY, maxY)) - box.height / 2;
            const x = entering ? -box.width / 2 : group.size.width - box.width / 2;
            port.position = { x, y };
            port.size = box;
        }
    }
}

/**
 * Saved positions are absolute; a model position is relative to its parent.
 * The position to give an element saved at `saved` whose parent sits at the
 * absolute `parentOrigin`.
 */
export function relativeToParent(saved: Point, parentOrigin: Point): Point {
    return { x: saved.x - parentOrigin.x, y: saved.y - parentOrigin.y };
}
