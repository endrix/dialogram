/**
 * Edges across group frames, split where they cross.
 *
 * A group (a producer's `group` scope) is laid out on its own: ELK places its
 * members inside it first, then places the group as one block among its
 * siblings (`SEPARATE_CHILDREN`). That is what keeps a group compact and its
 * frame tight around its members, the way a nested region reads in a
 * compiler's graph of nested operations. It also means ELK cannot route an edge from a member of one group to
 * a member of another in one piece: in a separate layout, an edge may only
 * join a node's own ports to its children, or siblings to each other.
 *
 * So an edge that leaves or enters a group is cut where it crosses the frame,
 * at a boundary port on the frame (`PORT_GROUP_BOUNDARY`), one cut at each
 * container it crosses:
 *
 *     member a (in A) ──► A's frame ──► B's frame ──► member b (in B)
 *        `source` piece      `middle`      `target` piece
 *
 * one piece per level, every piece inside the lowest group holding both its
 * ends. The middle piece keeps the edge's own id, its arguments and its
 * caption, so whatever names the edge by id still finds it, and deleting it
 * deletes the edge. Only the last piece draws an arrowhead: the others end on a
 * boundary port, which the client draws without one.
 *
 * Edges reaching the same member through the same frame share the way in, as
 * edges carrying one value share a container's port in a nested-region graph: one
 * boundary port per group, direction and inner endpoint, and one piece inside
 * the group from it to the member. Five sources implementing one clause then
 * enter its group at one point instead of five. A shared piece lists every edge
 * it stands for (`EDGES_OF`) and keeps a role only when they all have it; it
 * cannot be deleted on its own, since it is more than one edge.
 *
 * Every piece stays at the root of the model, as every edge does. ELK puts each
 * in the right group from its endpoints (see `findCommonAncestor`), and the
 * routes stay in absolute coordinates, which is what saving, restoring and
 * rerouting a route all assume. A model with no group is left untouched.
 *
 * An edge may also end at a group itself rather than at one of its members:
 * a transition into a state, where the state is a group of what can happen in
 * it. It arrives at one place on the frame (`GROUP_END`), shared by every edge
 * that ends there, and keeps its arrowhead; an edge that starts at a group
 * leaves from one place on the other side. An edge between a group and
 * something inside it goes nowhere the frame does not already hold, so it is
 * not drawn as a line: the group is marked (`GROUP_LOOP`) and the client draws
 * one loop on its frame for all of them. What those edges said (a caption, an
 * error) stays with the loop (`GROUP_LOOP_NOTES`, `GROUP_LOOP_ERROR`); the
 * edges themselves are no longer elements, so they cannot be selected.
 */
import { WorkflowDiagramConstants, WorkflowDiagramCss, WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import type { GEdge, GModelElement, GNode, GPort } from './graph-gmodel-source';

type Direction = 'in' | 'out';

function isEdge(element: GModelElement): element is GEdge {
    return typeof (element as GEdge).sourceId === 'string' && typeof (element as GEdge).targetId === 'string';
}

function isNode(element: GModelElement): boolean {
    return typeof element.type === 'string' && element.type.startsWith('node');
}

function isPort(element: GModelElement): boolean {
    return typeof element.type === 'string' && element.type.startsWith('port');
}

/**
 * The id of the boundary port on `groupId`'s frame that the edges to (`in`) or
 * from (`out`) the inner endpoint `innerId` pass through: a member's port, or
 * the port of a group nested in this one.
 */
export function groupBoundaryPortId(groupId: string, direction: Direction, innerId: string): string {
    return `${groupId}::${direction}::${innerId}`;
}

/** The id of the piece inside a group between its boundary port `portId` and the inner endpoint. */
export function groupEdgePieceId(portId: string): string {
    return `${portId}::piece`;
}

/**
 * Split every root edge that crosses a group frame, in place: the edge becomes
 * its middle piece, the other pieces are appended to `children`, and each group
 * crossed gains a boundary port.
 */
export function splitEdgesAtGroups(children: GModelElement[]): void {
    /** node id -> the group it sits in, `undefined` at the root. */
    const groupOfNode = new Map<string, GNode | undefined>();
    /** group id -> the group it sits in. */
    const parentOfGroup = new Map<string, GNode | undefined>();
    /** port id -> the node that owns it. */
    const ownerOfPort = new Map<string, string>();
    /** group id -> the group. */
    const groupById = new Map<string, GNode>();
    /** A frame's own pin (an open node's port kept on its frame) -> its group. */
    const groupOfPin = new Map<string, GNode>();
    let hasGroup = false;

    // Ports belong to the nearest node above them; a node inside another node
    // (a branch of a control structure) is a node of its own, in the same group.
    const walkNodeContent = (elements: GModelElement[] | undefined, nodeId: string, group: GNode | undefined): void => {
        for (const element of elements ?? []) {
            if (element.type === WorkflowDiagramTypes.NODE_GROUP) {
                walk([element], group);
            } else if (isNode(element)) {
                groupOfNode.set(element.id, group);
                walkNodeContent(element.children, element.id, group);
            } else if (isPort(element)) {
                ownerOfPort.set(element.id, nodeId);
            } else if (!isEdge(element)) {
                walkNodeContent(element.children, nodeId, group);
            }
        }
    };
    const walk = (elements: GModelElement[] | undefined, group: GNode | undefined): void => {
        for (const element of elements ?? []) {
            if (element.type === WorkflowDiagramTypes.NODE_GROUP) {
                hasGroup = true;
                groupById.set(element.id, element as GNode);
                parentOfGroup.set(element.id, group);
                groupOfNode.set(element.id, group);
                for (const child of element.children ?? []) {
                    if (isPort(child) && child.args?.[WorkflowDiagramMetadata.FRAME_PIN] === true) {
                        groupOfPin.set(child.id, element as GNode);
                    }
                }
                walk(element.children, element as GNode);
            } else if (isNode(element)) {
                groupOfNode.set(element.id, group);
                walkNodeContent(element.children, element.id, group);
            }
        }
    };
    walk(children, undefined);
    if (!hasGroup) {
        return;
    }

    /** The groups around a node, innermost first. */
    const groupsAround = (nodeId: string): GNode[] => {
        const chain: GNode[] = [];
        const seen = new Set<string>();
        let group = groupOfNode.get(nodeId);
        while (group && !seen.has(group.id)) {
            chain.push(group);
            seen.add(group.id);
            group = parentOfGroup.get(group.id);
        }
        return chain;
    };
    const endpointNode = (id: string): string | undefined =>
        ownerOfPort.get(id) ?? groupOfPin.get(id)?.id ?? (groupOfNode.has(id) ? id : undefined);

    const ports = new Map<string, GPort>();
    const pieces = new Map<string, GEdge>();
    /** The boundary port for `innerId` on `group`'s frame, and the piece inside, made once and then shared. */
    const crossing = (group: GNode, direction: Direction, innerId: string, edge: GEdge): string => {
        const portId = groupBoundaryPortId(group.id, direction, innerId);
        if (!ports.has(portId)) {
            ports.set(portId, addBoundaryPort(group, direction, portId));
        }
        const pieceId = groupEdgePieceId(portId);
        const existing = pieces.get(pieceId);
        if (existing) {
            share(existing, edge);
        } else {
            pieces.set(pieceId, direction === 'out'
                ? piece(edge, pieceId, innerId, portId, 'source')
                : piece(edge, pieceId, portId, innerId, 'target'));
        }
        return portId;
    };

    /** The place on `group`'s frame where the edges that end at the group itself arrive (`in`) or leave (`out`). */
    const frameEnd = (group: GNode, direction: Direction): string => {
        const portId = groupBoundaryPortId(group.id, direction, group.id);
        if (!ports.has(portId)) {
            ports.set(portId, addBoundaryPort(group, direction, portId, true));
        }
        return portId;
    };

    const looped = new Set<GEdge>();
    for (const edge of children.filter(isEdge)) {
        const sourceNode = endpointNode(edge.sourceId);
        const targetNode = endpointNode(edge.targetId);
        if (!sourceNode || !targetNode) {
            continue;
        }
        // An end that is a group itself, not a port of one of its members.
        const sourceGroup = groupById.get(edge.sourceId);
        const targetGroup = groupById.get(edge.targetId);
        // A pin of a frame is on the frame: outside it for an edge from
        // elsewhere, which ends there without crossing; inside it for an
        // edge to one of its members (or to another of its pins), which is
        // one piece laid out inside.
        const sourcePin = groupOfPin.get(edge.sourceId);
        const targetPin = groupOfPin.get(edge.targetId);
        const sourceOutside = groupsAround(sourceNode);
        const targetOutside = groupsAround(targetNode);
        const sourceGroups = sourcePin && (targetOutside.includes(sourcePin) || targetPin === sourcePin)
            ? [sourcePin, ...sourceOutside] : sourceOutside;
        const targetGroups = targetPin && (sourceOutside.includes(targetPin) || sourcePin === targetPin)
            ? [targetPin, ...targetOutside] : targetOutside;
        // Between a group and something inside it (or itself): the group's loop.
        const holds = (group: GNode | undefined, otherNode: string, others: GNode[]): boolean =>
            group !== undefined && (otherNode === group.id || others.includes(group));
        const loopOn = holds(targetGroup, sourceNode, sourceGroups)
            ? targetGroup
            : holds(sourceGroup, targetNode, targetGroups) ? sourceGroup : undefined;
        if (loopOn) {
            const notes = [edge.args?.[WorkflowDiagramMetadata.EDGE_LABEL], edge.args?.['wf:errorMessage']]
                .filter((note): note is string => typeof note === 'string' && note.trim() !== '');
            const before = loopOn.args?.[WorkflowDiagramMetadata.GROUP_LOOP_NOTES];
            loopOn.args = {
                ...(loopOn.args ?? {}),
                [WorkflowDiagramMetadata.GROUP_LOOP]: true,
                [WorkflowDiagramMetadata.GROUP_LOOP_NOTES]: [...new Set([...(Array.isArray(before) ? before : []), ...notes])]
            };
            if (edge.cssClasses?.includes(WorkflowDiagramCss.EDGE_ERROR) && !loopOn.cssClasses?.includes(WorkflowDiagramCss.GROUP_LOOP_ERROR)) {
                loopOn.cssClasses = [...(loopOn.cssClasses ?? []), WorkflowDiagramCss.GROUP_LOOP_ERROR];
            }
            looped.add(edge);
            continue;
        }
        if (sourceGroups.length === 0 && targetGroups.length === 0 && !sourceGroup && !targetGroup) {
            continue;
        }
        const targetIds = new Set(targetGroups.map(group => group.id));
        const common = sourceGroups.find(group => targetIds.has(group.id));
        const sourceSide = common ? sourceGroups.slice(0, sourceGroups.indexOf(common)) : sourceGroups;
        const targetSide = common ? targetGroups.slice(0, targetGroups.indexOf(common)) : targetGroups;
        if (sourceSide.length === 0 && targetSide.length === 0 && !sourceGroup && !targetGroup) {
            // Both ends in the same group: one piece, laid out inside it.
            continue;
        }

        let from = sourceGroup ? frameEnd(sourceGroup, 'out') : edge.sourceId;
        for (const group of sourceSide) {
            from = crossing(group, 'out', from, edge);
        }
        let to = targetGroup ? frameEnd(targetGroup, 'in') : edge.targetId;
        for (const group of targetSide) {
            to = crossing(group, 'in', to, edge);
        }
        const args: Record<string, unknown> = {
            ...(edge.args ?? {}),
            [WorkflowDiagramMetadata.EDGE_OF]: edge.id,
            [WorkflowDiagramMetadata.EDGES_OF]: [edge.id],
            [WorkflowDiagramMetadata.EDGE_SEGMENT]: 'middle'
        };
        keepEndIndices(args, from === edge.sourceId, to === edge.targetId);
        edge.sourceId = from;
        edge.targetId = to;
        edge.args = args;
    }
    if (looped.size > 0) {
        const kept = children.filter(child => !looped.has(child as GEdge));
        children.length = 0;
        children.push(...kept);
    }
    children.push(...pieces.values());
}

/** A piece of `edge` inside a group: its arguments and classes, without its caption. */
function piece(edge: GEdge, id: string, sourceId: string, targetId: string, segment: 'source' | 'target'): GEdge {
    const args: Record<string, unknown> = { ...(edge.args ?? {}) };
    // The caption is drawn once, on the middle piece.
    delete args[WorkflowDiagramMetadata.EDGE_LABEL];
    delete args[WorkflowDiagramMetadata.EDGE_WIDTH];
    // An end's index (the bits of a port the wire is) is drawn on the piece
    // that ends at that port, not at a frame.
    keepEndIndices(args, sourceId === edge.sourceId, targetId === edge.targetId);
    args[WorkflowDiagramMetadata.AST_PATH] = id;
    args[WorkflowDiagramMetadata.EDGE_OF] = edge.id;
    args[WorkflowDiagramMetadata.EDGES_OF] = [edge.id];
    args[WorkflowDiagramMetadata.EDGE_SEGMENT] = segment;
    return {
        id,
        type: edge.type,
        sourceId,
        targetId,
        ...(edge.cssClasses ? { cssClasses: [...edge.cssClasses] } : {}),
        args
    };
}

/** Keep an end's index only on a piece that ends at that end's real port. */
function keepEndIndices(args: Record<string, unknown>, atSource: boolean, atTarget: boolean): void {
    if (!atSource) {
        delete args[WorkflowDiagramMetadata.EDGE_FROM_INDEX];
        delete args[WorkflowDiagramMetadata.EDGE_FROM_INDEX_LABEL];
    }
    if (!atTarget) {
        delete args[WorkflowDiagramMetadata.EDGE_TO_INDEX];
        delete args[WorkflowDiagramMetadata.EDGE_TO_INDEX_LABEL];
    }
    if (args[WorkflowDiagramMetadata.EDGE_FROM_INDEX] === undefined && args[WorkflowDiagramMetadata.EDGE_TO_INDEX] === undefined) {
        delete args[WorkflowDiagramMetadata.EDGE_SLICE];
    }
}

/** Edge-specific arguments a shared piece cannot carry: they would name only one of its edges. */
const ONE_EDGE_ARGS = [
    'wf:from', 'wf:to', 'wf:outPort', 'wf:inPort',
    // One edge's bits, not the shared wire's.
    WorkflowDiagramMetadata.EDGE_FROM_INDEX, WorkflowDiagramMetadata.EDGE_TO_INDEX, WorkflowDiagramMetadata.EDGE_SLICE,
    WorkflowDiagramMetadata.EDGE_FROM_INDEX_LABEL, WorkflowDiagramMetadata.EDGE_TO_INDEX_LABEL,
    WorkflowDiagramMetadata.SOURCE_PORT_NAME, WorkflowDiagramMetadata.TARGET_PORT_NAME,
    WorkflowDiagramMetadata.SOURCE_RANGE, WorkflowDiagramMetadata.REFERENCED_SOURCE_RANGE,
    WorkflowDiagramMetadata.REFERENCED_URI, WorkflowDiagramMetadata.REFERENCED_IS_DEFINITION
];

/**
 * `edge` shares `existing`: it is listed, and what the edges do not all have
 * goes. A role kept only when every edge has it, a direction drawn when any
 * edge has one.
 */
function share(existing: GEdge, edge: GEdge): void {
    const args = existing.args ?? {};
    const edges = Array.isArray(args[WorkflowDiagramMetadata.EDGES_OF]) ? args[WorkflowDiagramMetadata.EDGES_OF] as string[] : [];
    args[WorkflowDiagramMetadata.EDGES_OF] = [...edges, edge.id];
    for (const key of ONE_EDGE_ARGS) {
        delete args[key];
    }
    if (args[WorkflowDiagramMetadata.EDGE_ROLE] !== edge.args?.[WorkflowDiagramMetadata.EDGE_ROLE]) {
        delete args[WorkflowDiagramMetadata.EDGE_ROLE];
        existing.cssClasses = (existing.cssClasses ?? []).filter(cls => !cls.startsWith('edge-role-'));
    }
    // A tone says something of one connection: a piece several carry keeps
    // it only when every one of them says it, whichever came first.
    const toneOf = (cssClasses: string[] | undefined): string | undefined => cssClasses?.find(cls => cls.startsWith('edge-tone-'));
    if (toneOf(existing.cssClasses) !== toneOf(edge.cssClasses)) {
        existing.cssClasses = (existing.cssClasses ?? []).filter(cls => !cls.startsWith('edge-tone-'));
    }
    if (existing.type !== edge.type && edge.type === WorkflowDiagramTypes.EDGE_CONNECTION) {
        existing.type = edge.type;
    }
    // Feedback when any of its edges is: the loops of every edge it carries,
    // whose ends the client tells the way the piece runs by.
    if (edge.args?.[WorkflowDiagramMetadata.IS_FEEDBACK] === true) {
        args[WorkflowDiagramMetadata.IS_FEEDBACK] = true;
        if (!existing.cssClasses?.includes(WorkflowDiagramCss.EDGE_FEEDBACK)) {
            existing.cssClasses = [...(existing.cssClasses ?? []), WorkflowDiagramCss.EDGE_FEEDBACK];
        }
    }
    if (edge.args?.[WorkflowDiagramMetadata.ON_LOOP] === true) {
        const ends = Array.isArray(args[WorkflowDiagramMetadata.LOOP_ENDS]) ? args[WorkflowDiagramMetadata.LOOP_ENDS] as unknown[] : [];
        const more = Array.isArray(edge.args[WorkflowDiagramMetadata.LOOP_ENDS]) ? edge.args[WorkflowDiagramMetadata.LOOP_ENDS] as unknown[] : [];
        args[WorkflowDiagramMetadata.ON_LOOP] = true;
        args[WorkflowDiagramMetadata.LOOP_ENDS] = [...ends, ...more];
    }
    existing.args = args;
}

/**
 * The port `portId` on `group`'s frame: on the left for edges coming in, on the
 * right for edges going out, centred on the frame line. ELK chooses where along
 * the side, below the header band. `end` marks the place where edges end at
 * the group itself (or start from it) instead of crossing its frame. Where
 * they arrive the arrowhead meets the frame and there is no dot; where they
 * start the dot stays, as the start of the line.
 */
function addBoundaryPort(group: GNode, direction: Direction, portId: string, end = false): GPort {
    const size = WorkflowDiagramConstants.GROUP_BOUNDARY_PORT_SIZE_PX;
    const side = direction === 'in' ? 'WEST' : 'EAST';
    const port: GPort = {
        id: portId,
        type: WorkflowDiagramTypes.PORT_GROUP_BOUNDARY,
        cssClasses: [WorkflowDiagramCss.GROUP_BOUNDARY_PORT, ...(end && direction === 'in' ? [WorkflowDiagramCss.GROUP_END_PORT] : [])],
        position: { x: 0, y: 0 },
        size: { width: size, height: size },
        layoutOptions: {
            'elk.port.side': side,
            'elk.port.borderOffset': String(-size / 2)
        },
        args: {
            [WorkflowDiagramMetadata.PORT_DIRECTION]: direction === 'in' ? 'input' : 'output',
            [WorkflowDiagramMetadata.PORT_SIDE]: side,
            ...(end ? { [WorkflowDiagramMetadata.GROUP_END]: true } : {})
        }
    };
    group.children = [...(group.children ?? []), port];
    return port;
}

/** The width a frame pin's name takes inside the frame: its text, and the gap to the dot and to the members. */
export function framePinLabelWidth(name: string): number {
    return FRAME_PIN_LABEL_GAP_PX + Math.ceil(name.length * FRAME_PIN_FONT_PX * 0.6) + FRAME_PIN_LABEL_GAP_PX;
}

const FRAME_PIN_FONT_PX = 11;
const FRAME_PIN_LABEL_GAP_PX = 6;

/**
 * One of an open node's own ports, on its frame: a boundary port like those
 * an edge is cut at, on the left for an input and on the right for an output,
 * that says what the port said on the node (its name, type and role; the
 * client draws the name inside the frame, above the wire, and a clock's wedge
 * at the frame for the role `clock`). It is there whether or not an edge ends
 * on it.
 */
export function framePin(portId: string, pin: { name: string; direction?: string; type?: string; role?: string }): GPort {
    const size = WorkflowDiagramConstants.GROUP_BOUNDARY_PORT_SIZE_PX;
    const output = pin.direction === 'out';
    const side = output ? 'EAST' : 'WEST';
    // Its role, as a port of a node closed says it (`port-role-<role>`), for the
    // producer's stylesheet; a word that is no class name is none.
    const role = typeof pin.role === 'string' && /^[a-z][a-z0-9-]*$/.test(pin.role) ? [`port-role-${pin.role}`] : [];
    return {
        id: portId,
        type: WorkflowDiagramTypes.PORT_GROUP_BOUNDARY,
        cssClasses: [WorkflowDiagramCss.GROUP_BOUNDARY_PORT, WorkflowDiagramCss.GROUP_FRAME_PIN, ...role],
        position: { x: 0, y: 0 },
        size: { width: size, height: size },
        layoutOptions: {
            'elk.port.side': side,
            'elk.port.borderOffset': String(-size / 2)
        },
        args: {
            // As a port of the node says them: the panel lists the frame's
            // pins as it lists the node's ports, and an edge names its end.
            [WorkflowDiagramMetadata.PORT_NAME]: pin.name,
            [WorkflowDiagramMetadata.PORT_DIRECTION]: output ? 'output' : 'input',
            [WorkflowDiagramMetadata.IS_INPUT_PORT]: !output,
            ...(pin.type ? { [WorkflowDiagramMetadata.PORT_TYPE]: pin.type } : {}),
            [WorkflowDiagramMetadata.PORT_SIDE]: side,
            [WorkflowDiagramMetadata.FRAME_PIN]: true,
            ...(pin.role ? { [WorkflowDiagramMetadata.PORT_ROLE]: pin.role, 'wf:portRole': pin.role } : {})
        }
    };
}

/** The room an open node's frame keeps beyond a group's padding (`FRAME_ROOM`). */
export interface FrameRoom {
    /** Beside its members, for the names of its pins. */
    left: number;
    right: number;
    /** Under its members, for the pins no edge ends on. */
    bottom: number;
    /** The least width its title needs. */
    width: number;
}

/** The room a frame keeps (`FRAME_ROOM`), none for a group that says none. */
export function frameRoomOf(group: { args?: unknown }): FrameRoom {
    const room = (group.args as Record<string, unknown> | undefined)?.[WorkflowDiagramMetadata.FRAME_ROOM] as Partial<FrameRoom> | undefined;
    const of = (value: unknown): number => typeof value === 'number' && value > 0 ? value : 0;
    return { left: of(room?.left), right: of(room?.right), bottom: of(room?.bottom), width: of(room?.width) };
}

/** The width a frame's title takes, after its toggle: as the client draws it (11px, semibold). */
function frameTitleWidth(title: string): number {
    return 40 + Math.ceil(title.length * 6.9) + 12;
}

/**
 * Once every edge is where it ends: each open node's frame that has pins, or
 * a title of its producer's, says the room it keeps (`FRAME_ROOM`) and lays
 * out with it, whichever way it lays out (in rows too). A pin no edge ends
 * on is marked (`FRAME_PIN_UNWIRED`): the layout does not place it, the frame
 * does, in the room under its members.
 */
export function settleFrames(children: GModelElement[]): void {
    const ends = new Set<string>();
    const frames: GNode[] = [];
    const visit = (element: GModelElement): void => {
        if (isEdge(element)) {
            ends.add(element.sourceId);
            ends.add(element.targetId);
        } else if (element.type === WorkflowDiagramTypes.NODE_GROUP
            && typeof (element.args as Record<string, unknown> | undefined)?.[WorkflowDiagramMetadata.OPEN_NODE_KEY] === 'string') {
            frames.push(element as GNode);
        }
        for (const child of element.children ?? []) {
            visit(child);
        }
    };
    children.forEach(visit);
    const header = WorkflowDiagramConstants.GROUP_HEADER_HEIGHT_PX;
    const pad = WorkflowDiagramConstants.GROUP_PADDING_PX;
    for (const frame of frames) {
        const room: FrameRoom = { left: 0, right: 0, bottom: 0, width: 0 };
        const unwired = { WEST: 0, EAST: 0 };
        for (const pin of frame.children ?? []) {
            const args = pin.args as Record<string, unknown> | undefined;
            if (args?.[WorkflowDiagramMetadata.FRAME_PIN] !== true) {
                continue;
            }
            const side = args[WorkflowDiagramMetadata.PORT_SIDE] === 'EAST' ? 'EAST' : 'WEST';
            const width = framePinLabelWidth(String(args[WorkflowDiagramMetadata.PORT_NAME] ?? ''));
            if (side === 'EAST') {
                room.right = Math.max(room.right, width);
            } else {
                room.left = Math.max(room.left, width);
            }
            if (!ends.has(pin.id)) {
                args[WorkflowDiagramMetadata.FRAME_PIN_UNWIRED] = true;
                unwired[side]++;
            }
        }
        room.bottom = Math.max(unwired.WEST, unwired.EAST) * WorkflowDiagramConstants.FRAME_PIN_PITCH_PX;
        if (frame.cssClasses?.includes(WorkflowDiagramCss.GROUP_TITLED)) {
            room.width = frameTitleWidth(String((frame.args as Record<string, unknown>)[WorkflowDiagramMetadata.GROUP_LABEL] ?? ''));
        }
        if (room.left + room.right + room.bottom + room.width === 0) {
            continue;
        }
        frame.args = { ...(frame.args ?? {}), [WorkflowDiagramMetadata.FRAME_ROOM]: room as any };
        frame.layoutOptions = {
            ...(frame.layoutOptions ?? groupLayoutOptions()),
            'elk.nodeSize.minimum': `(${Math.max(WorkflowDiagramConstants.GROUP_MIN_WIDTH_PX, room.width)},${WorkflowDiagramConstants.GROUP_MIN_HEIGHT_PX + room.bottom})`,
            'elk.padding': `[top=${header + pad},left=${pad + room.left},bottom=${pad + room.bottom},right=${pad + room.right}]`,
            // The pins an edge ends on stay above the room of those none does.
            'elk.spacing.portsSurrounding': `[top=${header + pad / 2},left=0,bottom=${pad / 2 + room.bottom},right=0]`
        };
    }
}

/**
 * How a group lays out: on its own (`SEPARATE_CHILDREN`), members first, then
 * the group as one block among its siblings, left to right, the way a nested
 * region is laid out. The top padding leaves room for the header band the client draws,
 * and the edges that cross the frame enter and leave through boundary ports on
 * its sides (`group-edges.ts`), kept below the header.
 */
export function groupLayoutOptions(rows = false): Record<string, string> {
    const header = WorkflowDiagramConstants.GROUP_HEADER_HEIGHT_PX;
    const pad = WorkflowDiagramConstants.GROUP_PADDING_PX;
    return {
        'elk.algorithm': 'layered',
        'elk.direction': 'RIGHT',
        'elk.hierarchyHandling': 'SEPARATE_CHILDREN',
        'elk.nodeSize.constraints': 'MINIMUM_SIZE',
        // A group that holds nothing is still a frame with a title, and
        // edges may end at it.
        'elk.nodeSize.minimum': `(${WorkflowDiagramConstants.GROUP_MIN_WIDTH_PX},${WorkflowDiagramConstants.GROUP_MIN_HEIGHT_PX})`,
        'elk.padding': `[top=${header + pad},left=${pad},bottom=${pad},right=${pad}]`,
        'elk.portConstraints': 'FIXED_SIDE',
        'elk.spacing.portsSurrounding': `[top=${header + pad / 2},left=0,bottom=${pad / 2},right=0]`,
        'elk.spacing.nodeNode': '30',
        'elk.spacing.edgeNode': '20',
        'elk.spacing.portPort': '8',
        'elk.layered.spacing.nodeNodeBetweenLayers': '40',
        ...(rows ? GROUP_ROWS_LAYOUT : {})
    };
}

/**
 * A group whose members carry a row (`GROUP_ROW`): the members of a row side
 * by side in the order the producer gave them, the rows one under another.
 * The layers of a layout that runs downward are rows, and a member's row is
 * its partition, which the layering keeps in order.
 */
const GROUP_ROWS_LAYOUT: Record<string, string> = {
    'elk.direction': 'DOWN',
    'elk.partitioning.activate': 'true',
    // Members with nothing between them are still one layout: on their own
    // each would be a component, packed wherever it fits.
    'elk.separateConnectedComponents': 'false',
    'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    'elk.layered.crossingMinimization.forceNodeModelOrder': 'true',
    'elk.spacing.nodeNode': '16',
    'elk.layered.spacing.nodeNodeBetweenLayers': '16'
};

/**
 * A column (`GROUP_COLUMN`): the members one under another in the order
 * given, their left edges on one line. It is laid out to the right, every
 * member in the one layer between the group's inputs and its outputs (no edge
 * runs between them; `FIRST` on each member, which the boundary pass leaves
 * alone), in that order. The model order sets it; the greedy switch, which
 * swaps two neighbours of a layer where that saves a crossing after the
 * order is set, is off: with it, a member no edge comes into moved below the
 * next one. The layout places a member by its margin, which its ports make:
 * `alignColumn` puts their left edges on one line after it. Laid out downward
 * in rows instead, the layout moved members sideways to shorten the wires
 * from the side, and put some pins of a member that is a frame on the side
 * they are not on: an output on the left, an input on the right.
 */
const GROUP_COLUMN_LAYOUT: Record<string, string> = {
    'elk.separateConnectedComponents': 'false',
    'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    'elk.layered.crossingMinimization.forceNodeModelOrder': 'true',
    'elk.layered.crossingMinimization.greedySwitch.type': 'OFF',
    'elk.spacing.nodeNode': '16'
};

/**
 * A list (`GROUP_LIST`): its members are rows of the same width, one under
 * another with nothing between them, so that their outlines draw the lines
 * of a table; the frame holds them close.
 */
const GROUP_LIST_LAYOUT: Record<string, string> = {
    'elk.spacing.nodeNode': '0',
    'elk.layered.spacing.nodeNodeBetweenLayers': '0',
    'elk.padding': `[top=${WorkflowDiagramConstants.GROUP_HEADER_HEIGHT_PX + WorkflowDiagramConstants.LIST_FRAME_PADDING_PX},`
        + `left=${WorkflowDiagramConstants.LIST_FRAME_PADDING_PX},bottom=${WorkflowDiagramConstants.LIST_FRAME_PADDING_PX},`
        + `right=${WorkflowDiagramConstants.LIST_FRAME_PADDING_PX}]`
};

/**
 * Lay out the root in ranks when the producer ranks any of its members
 * (`RANK`, a node's `meta.rank` or a group scope's `rank`): each rank a
 * partition of the root's layout, in order along the flow (left to right in
 * a flow that runs right). A ladder of refinement layers, one frame each, is
 * the case it was made for: the layout alone puts a frame wherever its edges
 * pull it.
 *
 * Unlike a group's rows, edges between members are welcome: between ranks is
 * where a ladder's edges run. One that runs against the ranks (from a later
 * rank to an earlier one) is routed back by the layout, which is the
 * producer's to avoid by drawing it the other way. What starts the flow
 * stands before the first rank: a unit's inputs, a group pinned on the left
 * that an edge keeps in the flow, an unranked member edges only leave.
 * Everything else unranked, a unit's outputs among it, stands after the last.
 *
 * Sets each member's partition and returns the graph options that turn the
 * ranks on, or `undefined` when nothing is ranked. Run once the groups are
 * nested, so that the root's members are what it holds.
 */
export function rootRankOptions(children: GModelElement[]): Record<string, string> | undefined {
    const members = children.filter(isNode) as GNode[];
    const rankOf = (member: GNode): number | undefined => {
        const rank = member.args?.[WorkflowDiagramMetadata.RANK];
        return isGroupRow(rank) ? rank : undefined;
    };
    const ranks = members.map(rankOf).filter((rank): rank is number => rank !== undefined);
    if (ranks.length === 0) {
        return undefined;
    }
    // Which member each end of a root edge is in, to tell a source.
    const memberOf = new Map<string, GNode>();
    const claim = (element: GModelElement, member: GNode): void => {
        memberOf.set(element.id, member);
        for (const child of element.children ?? []) {
            claim(child, member);
        }
    };
    members.forEach(member => claim(member, member));
    const leaving = new Set<GNode>();
    const entering = new Set<GNode>();
    for (const edge of children.filter(isEdge)) {
        const [from, to] = [memberOf.get(edge.sourceId), memberOf.get(edge.targetId)];
        if (from && to && from !== to) {
            leaving.add(from);
            entering.add(to);
        }
    }
    const startsTheFlow = (member: GNode): boolean =>
        member.type === WorkflowDiagramTypes.NODE_BOUNDARY_INPUT
        || member.args?.[WorkflowDiagramMetadata.GROUP_PIN] === 'left'
        || (leaving.has(member) && !entering.has(member));
    const after = Math.max(...ranks) + 2;
    for (const member of members) {
        const rank = rankOf(member);
        const partition = rank !== undefined ? rank + 1
            : startsTheFlow(member) ? 0
                : after;
        member.layoutOptions = { ...(member.layoutOptions ?? {}), 'elk.partitioning.partition': String(partition) };
    }
    return {
        'elk.partitioning.activate': 'true',
        // Members with nothing between them are still one layout: on their
        // own each would be a component, packed wherever it fits.
        'elk.separateConnectedComponents': 'false'
    };
}

/** Whether a group's layout options are the rows' (`groupLayoutOptions(true)`). */
export function isRowsLayout(options: Record<string, unknown> | undefined): boolean {
    return options?.['elk.partitioning.activate'] === 'true';
}

/** The most rows a group is laid out in: a partition is a 32-bit number to the layout. */
const MAX_GROUP_ROW = 100000;

/** Whether `value` is a row a producer may give: a whole number from zero, not absurdly large. */
export function isGroupRow(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_GROUP_ROW;
}

/**
 * Lay out in rows every group whose members carry a row (`GROUP_ROW`, on a
 * node or on a group nested in it): each row a partition of the group's
 * layout, a member with no row after the last one. Run once the groups are
 * nested and the edges cut, since both decide it:
 *
 * - a nested group is a member, and has a row as a node has;
 * - a column (`GROUP_COLUMN`) is laid out as one (`GROUP_COLUMN_LAYOUT`), in
 *   the order of the members' rows where they have them, else as given;
 * - a group with an edge between two of its own members keeps the plain
 *   layout, a column as well. Rows are for members that relate only to what
 *   is outside the group (the actions of a state, each leading to another
 *   state). With an edge between two of them the layering puts the edge's
 *   ends in different layers, which splits a row, and keeping the producer's
 *   order within a row sends the edge through the members between its ends.
 *   A column cannot hold them in one layer: the layout refuses an edge into
 *   a member held first. Its members stand as what flows between them puts
 *   them, the edge's end to the right of its start.
 */
export function arrangeGroupRows(children: GModelElement[]): void {
    const edges = children.filter(isEdge);
    const visit = (group: GNode): void => {
        const members = (group.children ?? []).filter(isNode) as GNode[];
        for (const member of members) {
            if (member.type === WorkflowDiagramTypes.NODE_GROUP) {
                visit(member);
            }
        }
        // A list's members are a row each, in the order the producer gave them.
        const list = group.args?.[WorkflowDiagramMetadata.GROUP_LIST] === true;
        const rowOf = (member: GNode): number | undefined => {
            const row = list ? members.indexOf(member) : member.args?.[WorkflowDiagramMetadata.GROUP_ROW];
            return isGroupRow(row) ? row : undefined;
        };
        const rows = members.map(rowOf).filter((row): row is number => row !== undefined);
        const column = group.args?.[WorkflowDiagramMetadata.GROUP_COLUMN] === true;
        if (rows.length === 0 && !column) {
            return;
        }
        // Everything a member holds (its ports, what is nested in it) -> the member.
        const memberOf = new Map<string, string>();
        const claim = (element: GModelElement, member: string): void => {
            memberOf.set(element.id, member);
            for (const child of element.children ?? []) {
                claim(child, member);
            }
        };
        members.forEach(member => claim(member, member.id));
        const betweenMembers = edges.some(edge => {
            const [from, to] = [memberOf.get(edge.sourceId), memberOf.get(edge.targetId)];
            return from !== undefined && to !== undefined && from !== to;
        });
        if (betweenMembers) {
            return;
        }
        if (column) {
            group.layoutOptions = { ...groupLayoutOptions(), ...GROUP_COLUMN_LAYOUT };
            group.args = { ...(group.args ?? {}), [WorkflowDiagramMetadata.GROUP_ROWS]: true };
            // The order the layout keeps is the members' order in the group: by row where they have one.
            const byRow = members.map((member, k) => ({ member, k, row: rowOf(member) ?? Number.MAX_SAFE_INTEGER }))
                .sort((a, b) => a.row - b.row || a.k - b.k)
                .map(({ member }) => member);
            let next = 0;
            group.children = (group.children ?? []).map(child => (members.includes(child as GNode) ? byRow[next++] : child));
            // One layer, its members in the order just set.
            for (const member of byRow) {
                member.layoutOptions = {
                    ...(member.layoutOptions ?? {}),
                    'elk.alignment': 'LEFT',
                    'elk.layered.layering.layerConstraint': 'FIRST'
                };
            }
            return;
        }
        const last = Math.max(...rows) + 1;
        group.layoutOptions = { ...groupLayoutOptions(true), ...(list ? GROUP_LIST_LAYOUT : {}) };
        group.args = { ...(group.args ?? {}), [WorkflowDiagramMetadata.GROUP_ROWS]: true };
        for (const member of members) {
            member.layoutOptions = {
                ...(member.layoutOptions ?? {}),
                'elk.partitioning.partition': String(rowOf(member) ?? last),
                // The members of a row stand on one line along their tops,
                // whatever their heights (a node with lines of text beside
                // one without): the layout would centre them on each other.
                'elk.alignment': 'TOP'
            };
        }
    };
    for (const child of children) {
        if (child.type === WorkflowDiagramTypes.NODE_GROUP) {
            visit(child as GNode);
        }
    }
}
