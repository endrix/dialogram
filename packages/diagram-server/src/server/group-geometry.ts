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
 *   with the port of the member it leads to, and under a port already there.
 * - a pin of an open node's frame no edge ends on has no route to say where
 *   it was: the layout never places it, the frame does (`placeUnwiredPins`),
 *   here as after a layout, in the room it keeps under its members.
 *
 * Routes are absolute, as every route in a layout file is; the snap that then
 * re-attaches each route to its ports (`applyPersistedEdgeRoutes`) finds the
 * ports where the routes expect them.
 */
import { GEdge, GModelElement, GModelRoot, GNode, GPort } from '@eclipse-glsp/server';
import { WorkflowDiagramConstants, WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import { frameRoomOf } from '../model/group-edges';
import { buildEdgeSignatureCounts, edgeRouteKeyFor } from '../routing/persisted-edge-routes';

type Point = { x: number; y: number };
type Size = { width: number; height: number };

/** Where an element is drawn, from the root's corner: its own position and every parent's. What a layout file saves. */
export function absolutePosition(element: GModelElement | undefined): Point {
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

/** The padding inside a group, round its members: a list's is its own, closer, as its layout has it. */
export function groupPadding(group: GModelElement): number {
    return (group as any).args?.[WorkflowDiagramMetadata.GROUP_LIST] === true
        ? WorkflowDiagramConstants.LIST_FRAME_PADDING_PX
        : WorkflowDiagramConstants.GROUP_PADDING_PX;
}

/** Whether a port is a pin of an open node's frame no edge ends on, which the frame places. */
export function isUnwiredPin(element: unknown): boolean {
    return (element as { args?: Record<string, unknown> } | undefined)?.args?.[WorkflowDiagramMetadata.FRAME_PIN_UNWIRED] === true;
}

/**
 * Put the pins of an open node's frame no edge ends on where the frame keeps
 * room for them: under its members, one under another on their side, the
 * last a padding above the frame's bottom. From the frame's size alone, so
 * they are in the same place after a layout and in a saved layout opened
 * again.
 */
export function placeUnwiredPins(group: GModelElement): void {
    const size = sizeOf(group);
    if (!size) {
        return;
    }
    const pad = groupPadding(group);
    const pitch = WorkflowDiagramConstants.FRAME_PIN_PITCH_PX;
    const portSize = WorkflowDiagramConstants.GROUP_BOUNDARY_PORT_SIZE_PX;
    for (const east of [false, true]) {
        const pins = (group.children as GModelElement[]).filter(child => isUnwiredPin(child)
            && ((child as any).args?.[WorkflowDiagramMetadata.PORT_SIDE] === 'EAST') === east);
        pins.forEach((pin, k) => {
            const box = sizeOf(pin) ?? { width: portSize, height: portSize };
            // Its name is above its line: the line is at the foot of its row.
            const centre = size.height - pad - (pins.length - 1 - k) * pitch - box.height / 2 - 1;
            (pin as any).position = { x: east ? size.width - box.width / 2 : -box.width / 2, y: centre - box.height / 2 };
            (pin as any).size = box;
        });
    }
}

/**
 * The size a group takes around its members: their extent, the padding below
 * them, and on the right the same inset they have on the left. A list's
 * padding is its own, closer, as its layout has it. An open node's frame
 * keeps its room besides (`FRAME_ROOM`): on the right what its own pins'
 * names take, under its members its pins no edge ends on, and never less
 * than its title.
 */
export function groupSizeAroundMembers(group: GNode): Size {
    const header: number = WorkflowDiagramConstants.GROUP_HEADER_HEIGHT_PX;
    const pad = groupPadding(group);
    const room = frameRoomOf(group);
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
    // Its own pins' names on the right take what they take, not what those on the left do.
    const onRight = room.left > 0 || room.right > 0 ? pad + room.right : inset;
    return {
        width: Math.max(right + onRight, 2 * pad, WorkflowDiagramConstants.GROUP_MIN_WIDTH_PX, room.width),
        height: Math.max(bottom + pad, header + 2 * pad, WorkflowDiagramConstants.GROUP_MIN_HEIGHT_PX) + room.bottom
    };
}

/**
 * Size every group around its members and put each boundary port back on its
 * frame, from the saved routes (absolute, under the key a layout file keeps
 * an edge's route by) where there are any.
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

    // A route is kept under its edge's ends where the edge names them (a wire
    // on a frame's pin does), else under its id.
    const signatures = routes ? buildEdgeSignatureCounts(root) : new Map<string, number>();
    const routeOf = (edge: GEdge): Point[] | undefined => {
        const key = edgeRouteKeyFor(edge.args as Record<string, unknown> | undefined, signatures);
        return (key !== undefined ? routes?.get(key) : undefined) ?? routes?.get(edge.id);
    };
    const portSize = WorkflowDiagramConstants.GROUP_BOUNDARY_PORT_SIZE_PX;
    const header = WorkflowDiagramConstants.GROUP_HEADER_HEIGHT_PX;
    for (const group of groups) {
        const pad = groupPadding(group);
        const room = frameRoomOf(group);
        // Under a port that is the lowest thing on the frame: the padding a
        // member has under it. An open node's frame that keeps room lays out
        // with what `settleFrames` gives it, and the layout then leaves under
        // such a port the clearance its ports keep from the bottom
        // (`portsSurrounding`) and the padding, each with the room for the
        // pins no edge ends on.
        const framed = (group.args as Record<string, unknown> | undefined)?.[WorkflowDiagramMetadata.FRAME_ROOM] !== undefined;
        const below = framed ? pad / 2 + room.bottom + pad + room.bottom : pad;
        const origin = absolutePosition(group);
        const crossings: Array<{ port: GPort; size: Size; entering: boolean; at?: Point; inner?: GModelElement }> = [];
        for (const port of group.children) {
            if (!(port instanceof GPort) || port.type !== WorkflowDiagramTypes.PORT_GROUP_BOUNDARY || isUnwiredPin(port)) {
                continue;
            }
            const size = sizeOf(port) ?? { width: portSize, height: portSize };
            const entering = (port as any).args?.[WorkflowDiagramMetadata.PORT_SIDE] !== 'EAST';
            // The piece inside the group: from this port (edges enter by it)
            // or to it (edges leave by it). Its saved route touches the port
            // at the port's anchor: the left edge of the port box on the left
            // side, the right edge on the right.
            const inside = edges.find(edge => (entering ? edge.sourceId : edge.targetId) === port.id);
            const route = inside ? routeOf(inside) : undefined;
            let at = route && route.length > 0 ? (entering ? route[0] : route[route.length - 1]) : undefined;
            if (!inside) {
                // Where edges end at the group itself there is no piece inside:
                // the port is where an edge outside the group reaches it.
                for (const edge of edges) {
                    const outside = (entering ? edge.targetId : edge.sourceId) === port.id ? routeOf(edge) : undefined;
                    if (outside && outside.length > 0) {
                        at = entering ? outside[outside.length - 1] : outside[0];
                        break;
                    }
                }
            }
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
            // A port the layout put below the members (one where edges end at
            // the group has no member to be level with) is part of the frame:
            // the frame reaches down past it, with the padding it has below a
            // member, so the port stays where its route meets it.
            if (crossing.at) {
                size.height = Math.max(size.height, crossing.at.y - origin.y + crossing.size.height / 2 + below);
            }
        }
        group.size = size;

        // Each port's height on its side: where its route crossed the frame,
        // else level with what it leads to inside.
        const placed: Array<{ port: GPort; box: Size; entering: boolean; centre: number; exact: boolean }> = [];
        for (const { port, size: box, entering, at, inner } of crossings) {
            let centreY: number | undefined = at ? at.y - origin.y : undefined;
            if (centreY === undefined && inner) {
                const innerSize = sizeOf(inner) ?? { width: 0, height: 0 };
                centreY = absolutePosition(inner).y + innerSize.height / 2 - origin.y;
            }
            placed.push({ port, box, entering, centre: centreY ?? header + box.height / 2, exact: at !== undefined });
        }
        // Two ports with no route to say where they were may lead to one
        // place: the second goes under the first, not on it.
        const gap = 2 * portSize;
        for (const entering of [true, false]) {
            const side = placed.filter(p => p.entering === entering).sort((a, b) => a.centre - b.centre);
            for (let k = 1; k < side.length; k++) {
                if (!side[k].exact && side[k].centre < side[k - 1].centre + gap) {
                    side[k].centre = side[k - 1].centre + gap;
                }
            }
        }
        const reach = Math.max(group.size.height, ...placed.map(({ box, centre }) => centre + box.height / 2 + below));
        if (reach > group.size.height) {
            group.size = { width: group.size.width, height: reach };
        }
        for (const { port, box, entering, centre } of placed) {
            const minY = header + box.height / 2;
            const maxY = group.size.height - box.height / 2;
            const y = Math.min(Math.max(centre, minY), Math.max(minY, maxY)) - box.height / 2;
            const x = entering ? -box.width / 2 : group.size.width - box.width / 2;
            port.position = { x, y };
            port.size = box;
        }
        placeUnwiredPins(group);
    }
}

/**
 * Put the members of a container that have no place yet under the ones that
 * have, in rows, and let the frames around them grow to hold them
 * (`growGroupsToFit`). A member's position is its own, from the container's
 * corner, as every model position is: a member given the root's coordinates
 * is drawn outside its frame by the frame's own offset. In a group the first
 * row starts below the header, inside the padding. Returns the groups that
 * grew, whose edges need routing again.
 */
export function placeMembersUnder(
    container: GModelElement,
    fresh: readonly GModelElement[],
    options: { gapX?: number; gapY?: number; perRow?: number } = {}
): GNode[] {
    const gapX = options.gapX ?? 70;
    const gapY = options.gapY ?? 18;
    const perRow = options.perRow ?? 6;
    const pad = groupPadding(container);
    const top = (isGroup(container) ? WorkflowDiagramConstants.GROUP_HEADER_HEIGHT_PX : 0) + pad;
    const unplaced = new Set<GModelElement>(fresh);
    let left = Number.POSITIVE_INFINITY;
    let foot = Number.NEGATIVE_INFINITY;
    for (const child of ((container as any).children ?? []) as GModelElement[]) {
        if (unplaced.has(child) || child instanceof GPort || child instanceof GEdge || !(child instanceof GNode)) {
            continue;
        }
        const size = sizeOf(child) ?? { width: 0, height: 0 };
        left = Math.min(left, child.position?.x ?? 0);
        foot = Math.max(foot, (child.position?.y ?? 0) + size.height);
    }
    const startX = Number.isFinite(left) ? Math.max(left, 0) : pad;
    let x = startX;
    let y = Number.isFinite(foot) ? foot + 3 * gapY : top;
    let rowHeight = 0;
    let inRow = 0;
    const grown: GNode[] = [];
    for (const member of fresh) {
        const size = sizeOf(member) ?? { width: 0, height: 0 };
        (member as any).position = { x, y };
        rowHeight = Math.max(rowHeight, size.height);
        x += size.width + gapX;
        if (++inRow >= perRow) {
            x = startX;
            y += rowHeight + gapY;
            rowHeight = 0;
            inRow = 0;
        }
        if (member instanceof GNode) {
            for (const group of growGroupsToFit(member)) {
                if (!grown.includes(group)) {
                    grown.push(group);
                }
            }
        }
    }
    return grown;
}

/**
 * Saved positions are absolute; a model position is relative to its parent.
 * The position to give an element saved at `saved` whose parent sits at the
 * absolute `parentOrigin`.
 */
export function relativeToParent(saved: Point, parentOrigin: Point): Point {
    return { x: saved.x - parentOrigin.x, y: saved.y - parentOrigin.y };
}

/**
 * Grow the groups around `node` so it fits inside them, after it moved: each
 * group, innermost first, becomes wide and tall enough for its child plus the
 * padding, and the ports on its right-hand side follow its right edge. A group
 * never shrinks here, and never grows to the left or upwards: a member cannot
 * be dragged past a group's left edge or under its header. Returns the groups
 * that grew, whose edges need routing again.
 */
export function growGroupsToFit(node: GNode): GNode[] {
    const grown: GNode[] = [];
    let child: GNode = node;
    let parent: GModelElement | undefined = (child as any).parent;
    while (parent && isGroup(parent)) {
        const pad = groupPadding(parent);
        const size = sizeOf(child) ?? { width: 0, height: 0 };
        const neededWidth = (child.position?.x ?? 0) + size.width + pad;
        const neededHeight = (child.position?.y ?? 0) + size.height + pad;
        const current = sizeOf(parent) ?? { width: 0, height: 0 };
        if (neededWidth <= current.width && neededHeight <= current.height) {
            break;
        }
        parent.size = { width: Math.max(current.width, neededWidth), height: Math.max(current.height, neededHeight) };
        for (const port of parent.children) {
            if (port instanceof GPort && port.type === WorkflowDiagramTypes.PORT_GROUP_BOUNDARY
                && (port as any).args?.[WorkflowDiagramMetadata.PORT_SIDE] === 'EAST') {
                const portWidth = sizeOf(port)?.width ?? WorkflowDiagramConstants.GROUP_BOUNDARY_PORT_SIZE_PX;
                port.position = { x: parent.size.width - portWidth / 2, y: port.position?.y ?? 0 };
            }
        }
        grown.push(parent);
        child = parent;
        parent = (child as any).parent;
    }
    return grown;
}
