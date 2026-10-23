/**
 * Edges across group frames, split where they cross.
 *
 * A group (a producer's `group` scope) is laid out on its own: ELK places its
 * members inside it first, then places the group as one block among its
 * siblings (`SEPARATE_CHILDREN`). That is what keeps a group compact and its
 * frame tight around its members, the way a nested region reads in an MLIR
 * graph. It also means ELK cannot route an edge from a member of one group to
 * a member of another in one piece: in a separate layout, an edge may only
 * join a node's own ports to its children, or siblings to each other.
 *
 * So an edge that leaves or enters a group is cut where it crosses the frame,
 * at a boundary port on the frame (`PORT_GROUP_BOUNDARY`), as mlir-viewer cuts
 * an edge at each container it crosses:
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
 * mlir-viewer's edges carrying one value share a container's port: one
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
                parentOfGroup.set(element.id, group);
                groupOfNode.set(element.id, group);
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
        ownerOfPort.get(id) ?? (groupOfNode.has(id) ? id : undefined);

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

    for (const edge of children.filter(isEdge)) {
        const sourceNode = endpointNode(edge.sourceId);
        const targetNode = endpointNode(edge.targetId);
        if (!sourceNode || !targetNode) {
            continue;
        }
        const sourceGroups = groupsAround(sourceNode);
        const targetGroups = groupsAround(targetNode);
        if (sourceGroups.length === 0 && targetGroups.length === 0) {
            continue;
        }
        const targetIds = new Set(targetGroups.map(group => group.id));
        const common = sourceGroups.find(group => targetIds.has(group.id));
        const sourceSide = common ? sourceGroups.slice(0, sourceGroups.indexOf(common)) : sourceGroups;
        const targetSide = common ? targetGroups.slice(0, targetGroups.indexOf(common)) : targetGroups;
        if (sourceSide.length === 0 && targetSide.length === 0) {
            // Both ends in the same group: one piece, laid out inside it.
            continue;
        }

        let from = edge.sourceId;
        for (const group of sourceSide) {
            from = crossing(group, 'out', from, edge);
        }
        let to = edge.targetId;
        for (const group of targetSide) {
            to = crossing(group, 'in', to, edge);
        }
        edge.sourceId = from;
        edge.targetId = to;
        edge.args = {
            ...(edge.args ?? {}),
            [WorkflowDiagramMetadata.EDGE_OF]: edge.id,
            [WorkflowDiagramMetadata.EDGES_OF]: [edge.id],
            [WorkflowDiagramMetadata.EDGE_SEGMENT]: 'middle'
        };
    }
    children.push(...pieces.values());
}

/** A piece of `edge` inside a group: its arguments and classes, without its caption. */
function piece(edge: GEdge, id: string, sourceId: string, targetId: string, segment: 'source' | 'target'): GEdge {
    const args: Record<string, unknown> = { ...(edge.args ?? {}) };
    // The caption is drawn once, on the middle piece.
    delete args[WorkflowDiagramMetadata.EDGE_LABEL];
    delete args[WorkflowDiagramMetadata.EDGE_WIDTH];
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

/** Edge-specific arguments a shared piece cannot carry: they would name only one of its edges. */
const ONE_EDGE_ARGS = [
    'wf:from', 'wf:to', 'wf:outPort', 'wf:inPort',
    WorkflowDiagramMetadata.SOURCE_PORT_NAME, WorkflowDiagramMetadata.TARGET_PORT_NAME,
    WorkflowDiagramMetadata.SOURCE_RANGE, WorkflowDiagramMetadata.REFERENCED_SOURCE_RANGE,
    WorkflowDiagramMetadata.REFERENCED_URI
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
    if (existing.type !== edge.type && edge.type === WorkflowDiagramTypes.EDGE_CONNECTION) {
        existing.type = edge.type;
    }
    existing.args = args;
}

/**
 * The port `portId` on `group`'s frame: on the left for edges coming in, on the
 * right for edges going out, centred on the frame line. ELK chooses where along
 * the side, below the header band.
 */
function addBoundaryPort(group: GNode, direction: Direction, portId: string): GPort {
    const size = WorkflowDiagramConstants.GROUP_BOUNDARY_PORT_SIZE_PX;
    const side = direction === 'in' ? 'WEST' : 'EAST';
    const port: GPort = {
        id: portId,
        type: WorkflowDiagramTypes.PORT_GROUP_BOUNDARY,
        cssClasses: [WorkflowDiagramCss.GROUP_BOUNDARY_PORT],
        position: { x: 0, y: 0 },
        size: { width: size, height: size },
        layoutOptions: {
            'elk.port.side': side,
            'elk.port.borderOffset': String(-size / 2)
        },
        args: {
            [WorkflowDiagramMetadata.PORT_DIRECTION]: direction === 'in' ? 'input' : 'output',
            [WorkflowDiagramMetadata.PORT_SIDE]: side
        }
    };
    group.children = [...(group.children ?? []), port];
    return port;
}

/**
 * How a group lays out: on its own (`SEPARATE_CHILDREN`), members first, then
 * the group as one block among its siblings, the way mlir-viewer lays out a
 * region. The top padding leaves room for the header band the client draws,
 * and the edges that cross the frame enter and leave through boundary ports on
 * its sides (`group-edges.ts`), kept below the header.
 */
export function groupLayoutOptions(): Record<string, string> {
    const header = WorkflowDiagramConstants.GROUP_HEADER_HEIGHT_PX;
    const pad = WorkflowDiagramConstants.GROUP_PADDING_PX;
    return {
        'elk.algorithm': 'layered',
        'elk.direction': 'RIGHT',
        'elk.hierarchyHandling': 'SEPARATE_CHILDREN',
        'elk.nodeSize.constraints': 'MINIMUM_SIZE',
        'elk.padding': `[top=${header + pad},left=${pad},bottom=${pad},right=${pad}]`,
        'elk.portConstraints': 'FIXED_SIDE',
        'elk.spacing.portsSurrounding': `[top=${header + pad / 2},left=0,bottom=${pad / 2},right=0]`,
        'elk.spacing.nodeNode': '30',
        'elk.spacing.edgeNode': '20',
        'elk.spacing.portPort': '8',
        'elk.layered.spacing.nodeNodeBetweenLayers': '40'
    };
}
