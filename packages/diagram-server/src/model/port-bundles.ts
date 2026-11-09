/**
 * Port bundles drawn as buses.
 *
 * A producer may put ports in a bundle (`port.group`): a channel's payload with
 * its `valid` and `ready`, say. Drawn port by port, two nodes joined by one
 * channel are joined by four wires that run side by side the whole way and say
 * nothing the first one did not. So a bundle is drawn as ONE port, a bus, and
 * every connection between two buses as one edge. The reader opens a bundle
 * with the toggle in front of its name when they want its members.
 *
 * Opening one end is not enough to split the edge: until the other end is
 * open too, the members on the open end have nowhere separate to go. So the
 * bus edge stays, drawn from the open bundle's header row, until both ends
 * are open; then the connections are drawn member to member, as the producer
 * sent them.
 *
 * This runs on the graph document, before it becomes a model: a bus is a port
 * like any other from there on, and an edge between two of them an edge, so
 * the layout, the routers and the views need nothing of their own for it.
 */
import { normalizePortSide, type PortSide } from '@dialogram/shared';
import type { PyGraphDocument, PyGraphEdge, PyGraphNode, PyGraphPort } from './graph-gmodel-source';
import { stableNodeId, stableNodeIds, type StableNodeIds } from './stable-ids';

/** Which bundles the reader has opened, by node layout key and bundle name. */
export interface PortBusState {
    isExpanded(nodeKey: string, group: string): boolean;
}

/** Every bundle closed: how a diagram first opens. */
export const ALL_BUSES_COLLAPSED: PortBusState = { isExpanded: () => false };

/** The open bundles a layout file lists, per node layout key. */
export function portBusStateOf(expanded: ReadonlyMap<string, ReadonlySet<string>> | undefined): PortBusState {
    if (!expanded || expanded.size === 0) {
        return ALL_BUSES_COLLAPSED;
    }
    return { isExpanded: (nodeKey, group) => expanded.get(nodeKey)?.has(group) ?? false };
}

/** What the platform adds to a port it drew as a bus. */
export interface PortBus {
    /** The bundle's name, as the producer gave it. */
    group: string;
    /** Unique among the node's buses: the name, or the name and side for a bundle on both sides. */
    key: string;
    expanded: boolean;
    members: number;
}


export function portSideOf(port: PyGraphPort): PortSide {
    return normalizePortSide(port.side) ?? (port.direction === 'in' ? 'WEST' : 'EAST');
}

/** Nodes that are the diagram's own boundary: one port each, never bundled here. */
function isBoundaryNode(node: PyGraphNode): boolean {
    return node.kind === 'wf-input' || node.kind === 'wf-output';
}

interface MemberInfo {
    busId: string;
    expanded: boolean;
}

/**
 * The document with every bundle drawn as a bus: closed bundles as one port,
 * open ones as a header port with their members under it, and the edges
 * between buses merged. A document without bundles comes back unchanged.
 */
export function bundlePorts(
    doc: PyGraphDocument,
    state: PortBusState = ALL_BUSES_COLLAPSED,
    nodeIds: StableNodeIds = stableNodeIds(doc.graph.nodes)
): PyGraphDocument {
    const memberOf = new Map<string, MemberInfo>();
    let anyBus = false;

    const nodes = doc.graph.nodes.map(node => {
        if (isBoundaryNode(node) || !node.ports.some(p => p.group)) {
            return node;
        }
        // A bundle is keyed by name and side: a producer that leaves a bundle's
        // members on both sides gets a bus on each, never a wire across the node.
        const byKey = new Map<string, PyGraphPort[]>();
        for (const port of node.ports) {
            if (!port.group) {
                continue;
            }
            const key = `${port.group}\u0000${portSideOf(port)}`;
            const members = byKey.get(key) ?? [];
            members.push(port);
            byKey.set(key, members);
        }
        const groupsOnBothSides = new Set<string>();
        const sidesByGroup = new Map<string, Set<PortSide>>();
        for (const members of byKey.values()) {
            const group = members[0].group!;
            const sides = sidesByGroup.get(group) ?? new Set<PortSide>();
            sides.add(portSideOf(members[0]));
            sidesByGroup.set(group, sides);
            if (sides.size > 1) {
                groupsOnBothSides.add(group);
            }
        }

        // The key a node's open bundles are saved under: its model id.
        const nodeKey = stableNodeId(nodeIds, node);
        const ports: PyGraphPort[] = [];
        const emitted = new Set<string>();
        for (const port of node.ports) {
            const key = port.group ? `${port.group}\u0000${portSideOf(port)}` : undefined;
            const members = key ? byKey.get(key) : undefined;
            // A bundle of one is just a port.
            if (!key || !members || members.length < 2) {
                ports.push(port);
                continue;
            }
            if (emitted.has(key)) {
                continue;
            }
            emitted.add(key);
            anyBus = true;
            const group = port.group!;
            const side = portSideOf(port);
            const busKey = groupsOnBothSides.has(group) ? `${group}@${side.toLowerCase()}` : group;
            const expanded = state.isExpanded(nodeKey, group);
            // Not a port name: a member may be named exactly like its bundle
            // (a channel's payload), and the two must not share an id.
            const busId = `bus:${node.id}:${busKey}`;
            ports.push({
                id: busId,
                name: group,
                direction: side === 'EAST' ? 'out' : 'in',
                side: side.toLowerCase(),
                group,
                bus: { group, key: busKey, expanded, members: members.length }
            });
            for (const member of members) {
                memberOf.set(member.id, { busId, expanded });
                if (expanded) {
                    ports.push({ ...member, busMember: group });
                }
            }
        }
        return { ...node, ports };
    });

    const withBoundaries = bundleBoundaries(nodes, state, memberOf, nodeIds);
    if (!anyBus && withBoundaries === nodes) {
        return doc;
    }

    const edges = mergeBusEdges(doc.graph.edges, memberOf);
    return { ...doc, graph: { ...doc.graph, nodes: withBoundaries, edges } };
}

/** The margin a boundary node sits in: its producer's `meta.side`, else by its kind. */
function boundaryMargin(node: PyGraphNode): PortSide {
    return normalizePortSide(node.meta?.['side'] as string | undefined) ?? (node.kind === 'wf-input' ? 'WEST' : 'EAST');
}

/**
 * The unit's own ports, bundled: a boundary node is one port, so a bundle of
 * them (`cpx_vld`, `cpx_req`, `cpx_data`) is drawn as one boundary node, named
 * after the bundle, in their margin, in place of the first of them; open,
 * that node stays as the bundle's header and its members are drawn after it.
 * Members are grouped by bundle and margin, so a `ready` output the producer
 * placed beside its inputs is in their bus. The bus node is an input when
 * most of its members are.
 */
function bundleBoundaries(
    nodes: PyGraphNode[],
    state: PortBusState,
    memberOf: Map<string, MemberInfo>,
    nodeIds: StableNodeIds
): PyGraphNode[] {
    const byKey = new Map<string, PyGraphNode[]>();
    for (const node of nodes) {
        const group = isBoundaryNode(node) ? node.ports[0]?.group : undefined;
        if (!group) {
            continue;
        }
        const key = `${group}\u0000${boundaryMargin(node)}`;
        byKey.set(key, [...(byKey.get(key) ?? []), node]);
    }
    const buses = [...byKey.entries()].filter(([, members]) => members.length >= 2);
    if (buses.length === 0) {
        return nodes;
    }
    const busOf = new Map<string, { bus: PyGraphNode; members: PyGraphNode[]; expanded: boolean }>();
    for (const [key, members] of buses) {
        const group = members[0].ports[0].group!;
        const margin = boundaryMargin(members[0]);
        const inputs = members.filter(m => m.kind === 'wf-input').length;
        const kind = inputs * 2 >= members.length ? 'wf-input' : 'wf-output';
        const defaultMargin: PortSide = kind === 'wf-input' ? 'WEST' : 'EAST';
        const id = `bus:wf:${margin.toLowerCase()}:${group}`;
        const busId = `${id}:port`;
        // Keyed by the bus node's own id: it is no producer's node, so its
        // model id is this one.
        const expanded = state.isExpanded(id, group);
        const bus: PyGraphNode = {
            id,
            kind,
            label: group,
            scope: members[0].scope,
            ports: [{
                id: busId,
                name: group,
                direction: kind === 'wf-input' ? 'out' : 'in',
                group,
                ...(margin !== defaultMargin ? { side: margin === 'WEST' ? 'east' : 'west' } : {}),
                bus: { group, key: group, expanded, members: members.length }
            }],
            meta: {
                ...(margin !== defaultMargin ? { side: margin.toLowerCase() } : {}),
                // The members' model ids, in order: opening the bus places them
                // under it before the model is built again.
                busMembers: members.map(m => stableNodeId(nodeIds, m))
            }
        };
        for (const member of members) {
            memberOf.set(member.ports[0].id, { busId, expanded });
        }
        busOf.set(key, { bus, members, expanded });
    }
    const out: PyGraphNode[] = [];
    const placed = new Set<string>();
    for (const node of nodes) {
        const group = isBoundaryNode(node) ? node.ports[0]?.group : undefined;
        const key = group ? `${group}\u0000${boundaryMargin(node)}` : undefined;
        const entry = key ? busOf.get(key) : undefined;
        if (!entry) {
            out.push(node);
            continue;
        }
        if (placed.has(key!)) {
            continue;
        }
        placed.add(key!);
        out.push(entry.bus);
        if (entry.expanded) {
            for (const member of entry.members) {
                out.push({ ...member, ports: [{ ...member.ports[0], busMember: entry.bus.label }] });
            }
        }
    }
    return out;
}

/**
 * The edges with each end moved to its bus where the bus is drawn, and the
 * edges that then join the same two ports merged into one.
 *
 * An end stays on its member only when its bundle is open and the other end
 * is either open too or no bundle at all: the half-open case draws the bus
 * edge from the open header.
 */
function mergeBusEdges(edges: readonly PyGraphEdge[], memberOf: ReadonlyMap<string, MemberInfo>): PyGraphEdge[] {
    const endOf = (own: MemberInfo | undefined, other: MemberInfo | undefined, portId: string): string => {
        if (!own) {
            return portId;
        }
        const stays = own.expanded && (!other || other.expanded);
        return stays ? portId : own.busId;
    };

    const out: Array<PyGraphEdge | { merged: string }> = [];
    const merged = new Map<string, PyGraphEdge[]>();
    for (const edge of edges) {
        const fromInfo = memberOf.get(edge.from);
        const toInfo = memberOf.get(edge.to);
        const from = endOf(fromInfo, toInfo, edge.from);
        const to = endOf(toInfo, fromInfo, edge.to);
        if (from === edge.from && to === edge.to) {
            out.push(edge);
            continue;
        }
        // Keyed on the pair, either way round: a handshake's `ready` runs
        // against its `valid` and belongs to the same bus edge.
        const pair = from < to ? `${from}\u0000${to}` : `${to}\u0000${from}`;
        const moved: PyGraphEdge = { ...edge, from, to };
        const members = merged.get(pair);
        if (members) {
            members.push(moved);
        } else {
            merged.set(pair, [moved]);
            out.push({ merged: pair });
        }
    }

    return out.map(entry => {
        if (!('merged' in entry)) {
            return entry;
        }
        return busEdge(merged.get(entry.merged)!);
    });
}

/**
 * One edge for connections that now join the same two ports. It runs the way
 * most of them run (data and `valid` outvote `ready`), the first one breaking
 * a tie, and keeps the facts its members agree on.
 */
function busEdge(members: readonly PyGraphEdge[]): PyGraphEdge {
    const first = members[0];
    if (members.length === 1) {
        return first;
    }
    const forward = members.filter(e => e.from === first.from).length;
    const reversed = members.length - forward;
    const [from, to] = reversed > forward ? [first.to, first.from] : [first.from, first.to];
    return {
        id: `bus:${from}->${to}`,
        from,
        to,
        scope: first.scope,
        source: first.source ?? null,
        meta: agreedMeta(members),
        bus: { members: members.map(e => e.id) }
    };
}

/**
 * The meta every member carries with the same value, and an error if any
 * member has one. A fact only some members state (a signal's name, its
 * width) is not a fact about the bus.
 */
function agreedMeta(members: readonly PyGraphEdge[]): Record<string, unknown> | undefined {
    const metas = members.map(e => e.meta ?? {});
    const agreed: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(metas[0])) {
        if (metas.every(m => key in m && JSON.stringify(m[key]) === JSON.stringify(value))) {
            agreed[key] = value;
        }
    }
    const errored = metas.find(m => m['isErrored'] === true);
    if (errored) {
        agreed['isErrored'] = true;
        if (typeof errored['errorMessage'] === 'string') {
            agreed['errorMessage'] = errored['errorMessage'];
        }
    }
    return Object.keys(agreed).length > 0 ? agreed : undefined;
}
