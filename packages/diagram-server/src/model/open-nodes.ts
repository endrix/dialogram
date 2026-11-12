/**
 * A node opened in place: drawn as the group frame of what it is made of.
 *
 * A producer can give a node a graph of its own (`meta.inner`: `nodes`, and
 * `edges` between their pins and the node's own ports; an HDL producer's
 * processes and the cells they synthesise to). Such a node can be opened
 * (`ToggleNodeOpenOperation`, the reader's choice, kept in the layout file
 * with the open bundles under the node's key and the name `OPEN`).
 *
 * Opened, the node is replaced by a `group` scope titled with its name and
 * holding its inner nodes, and every edge on one of its ports is carried on
 * to the inner pins that port reaches: an edge into an input goes to each
 * pin the input feeds, an edge out of an output comes from the pin that
 * drives it, and one through the node (an input wired straight to an
 * output) joins its two ends. The group machinery then splits each of those
 * edges where it crosses the frame (group-edges.ts), lays the frame out on
 * its own and keeps its geometry, as for any group.
 *
 * The inner nodes are named under their frame's id (`innerNodeId`), so they
 * meet no other node's id or saved place, and are drawn as they are: one
 * holding a graph of its own is not opened again.
 */
import { ToggleNodeOpenOperation, WorkflowDiagramConstants, WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import type { PyGraphDocument, PyGraphEdge, PyGraphNode, PyGraphScope } from './graph-gmodel-source';
import type { PortBusState } from './port-bundles';
import { stableNodeId, type StableNodeIds } from './stable-ids';
import { nodeLayoutKeyOf, isMovableNode } from '../server/layout-snapshot';

/** The graph inside a node, as a producer sends it. */
export interface InnerGraph {
    nodes: PyGraphNode[];
    edges: Array<{ from: string; to: string; width?: number }>;
}

/** The graph a node holds, when it holds one with something in it. */
export function innerGraphOf(node: Pick<PyGraphNode, 'meta'>): InnerGraph | undefined {
    const inner = node.meta?.['inner'] as Partial<InnerGraph> | undefined;
    if (!inner || !Array.isArray(inner.nodes) || inner.nodes.length === 0) {
        return undefined;
    }
    return { nodes: inner.nodes, edges: Array.isArray(inner.edges) ? inner.edges : [] };
}

/** The scope an open node becomes. */
export function openScopeId(nodeId: string): string {
    return `open:${nodeId}`;
}

/** The frame's id in the model, which is its layout key too (`createGroupNode`). */
export function openFrameId(nodeId: string): string {
    return `scope:${openScopeId(nodeId)}`;
}

/** Whether a node can open: it holds a graph, and sits where a group can (not in an `if` or a loop). */
export function canOpen(node: Pick<PyGraphNode, 'meta' | 'scope'>, scopes: readonly PyGraphScope[] | undefined): boolean {
    if (!innerGraphOf(node)) {
        return false;
    }
    const scope = scopes?.find(s => s.id === node.scope);
    return !scope?.controlNodeId;
}

/** An inner node's id in the model: under its frame's, so it meets no other node's. */
export function innerNodeId(nodeId: string, innerId: string): string {
    return `${openFrameId(nodeId)}/${innerId}`;
}

const push = <K, V>(map: Map<K, V[]>, key: K, value: V): void => {
    const list = map.get(key);
    if (list) {
        list.push(value);
    } else {
        map.set(key, [value]);
    }
};

/** `doc` with the nodes `state` says are open drawn as the groups of what they hold. */
export function openNodes(doc: PyGraphDocument, state: PortBusState | undefined, ids: StableNodeIds): PyGraphDocument {
    const opened = doc.graph.nodes.filter(node =>
        canOpen(node, doc.graph.subgraphs) && state?.isExpanded(stableNodeId(ids, node), ToggleNodeOpenOperation.OPEN));
    if (opened.length === 0) {
        return doc;
    }
    const subgraphs: PyGraphScope[] = (doc.graph.subgraphs ?? []).map(scope => ({ ...scope }));
    const openedIds = new Set(opened.map(node => node.id));
    // Each opened node's ports, and what they reach inside.
    interface Inside {
        node: PyGraphNode;
        scopeId: string;
        own: Map<string, PyGraphNode['ports'][number]>;
        nodeOfPin: Map<string, string>;
        into: Map<string, string[]>;     // own input -> inner pins it feeds
        outOf: Map<string, string[]>;    // own output -> the inner pin driving it
        reads: Map<string, string[]>;    // own output -> inner pins reading it
        through: Map<string, string[]>;  // own input -> own outputs
        edges: PyGraphEdge[];            // inside the frame
        cells: PyGraphNode[];
    }
    const insides: Inside[] = [];
    const ownerOf = new Map<string, Inside>();
    for (const node of opened) {
        const inner = innerGraphOf(node)!;
        const scopeId = openScopeId(node.id);
        const own = new Map(node.ports.map(port => [port.id, port]));
        // Inner nodes are drawn as they are, not opened again: what they hold is not drawn.
        const cells = inner.nodes.map(cell => {
            const meta = cell.meta ? { ...cell.meta } : undefined;
            if (meta) {
                delete meta['inner'];
            }
            return { ...cell, id: innerNodeId(node.id, cell.id), scope: scopeId, ...(meta ? { meta } : {}) };
        });
        const nodeOfPin = new Map<string, string>();
        for (const cell of cells) {
            for (const port of cell.ports ?? []) {
                nodeOfPin.set(port.id, cell.id);
            }
        }
        const inside: Inside = {
            node, scopeId, own, nodeOfPin, cells,
            into: new Map(), outOf: new Map(), reads: new Map(), through: new Map(), edges: []
        };
        // Edges naming a pin no inner node has are no edges: a wire to nothing.
        inner.edges.forEach((edge, k) => {
            const from = own.get(edge.from);
            const toOwn = own.has(edge.to);
            if (from && toOwn) {
                push(inside.through, edge.from, edge.to);
            } else if (from && nodeOfPin.has(edge.to)) {
                // From one of its inputs, or reading one of its own outputs.
                push(from.direction === 'out' ? inside.reads : inside.into, edge.from, edge.to);
            } else if (toOwn && nodeOfPin.has(edge.from)) {
                push(inside.outOf, edge.to, edge.from);
            } else if (nodeOfPin.has(edge.from) && nodeOfPin.has(edge.to)) {
                // Widths stay on the pins, as on every other wire.
                inside.edges.push({ id: `${node.id}/edge:${k}`, from: edge.from, to: edge.to, scope: scopeId });
            }
        });
        // An output it reads itself: from the pin driving it.
        for (const [output, readers] of inside.reads) {
            let k = 0;
            for (const driver of inside.outOf.get(output) ?? []) {
                for (const reader of readers) {
                    inside.edges.push({ id: `${node.id}/read:${output}@${k++}`, from: driver, to: reader, scope: scopeId });
                }
            }
        }
        insides.push(inside);
        for (const portId of own.keys()) {
            ownerOf.set(portId, inside);
        }
    }
    // One pass over the edges: those on an opened node's ports are carried on.
    const edges: PyGraphEdge[] = [];
    const inbound = new Map<string, PyGraphEdge[]>();
    const outbound = new Map<string, PyGraphEdge[]>();
    for (const edge of doc.graph.edges) {
        const fromIn = ownerOf.get(edge.from);
        const toIn = ownerOf.get(edge.to);
        if (!fromIn && !toIn) {
            edges.push(edge);
            continue;
        }
        if (toIn && fromIn !== toIn) {
            push(inbound, edge.to, edge);
            (toIn.into.get(edge.to) ?? []).forEach((pin, k) =>
                edges.push(withEnd(edge, `${edge.id}>${k}`, { to: pin, toNode: toIn.nodeOfPin.get(pin) })));
        }
        if (fromIn && fromIn !== toIn) {
            push(outbound, edge.from, edge);
            (fromIn.outOf.get(edge.from) ?? []).forEach((pin, k) =>
                edges.push(withEnd(edge, `${edge.id}<${k}`, { from: pin, fromNode: fromIn.nodeOfPin.get(pin) })));
        }
        if (fromIn && fromIn === toIn) {
            // From the node back into itself: inside the frame, from the pin
            // driving the output to each pin the input feeds.
            let k = 0;
            for (const driver of fromIn.outOf.get(edge.from) ?? []) {
                for (const fed of fromIn.into.get(edge.to) ?? []) {
                    fromIn.edges.push(withEnd(edge, `${edge.id}@${k++}`, {
                        from: driver, fromNode: fromIn.nodeOfPin.get(driver), to: fed, toNode: fromIn.nodeOfPin.get(fed), scope: fromIn.scopeId
                    }));
                }
            }
        }
    }
    // An edge into one opened node and out of another is carried at both ends.
    for (const inside of insides) {
        for (const [input, outputs] of inside.through) {
            for (const a of inbound.get(input) ?? []) {
                for (const output of outputs) {
                    for (const b of outbound.get(output) ?? []) {
                        // Through the node: from where `a` starts to where `b` ends.
                        edges.push(withEnd(b, `${a.id}>${b.id}`, { from: a.from, fromNode: fromNodeOf(a) }));
                    }
                }
            }
        }
        edges.push(...inside.edges);
        const node = inside.node;
        const parent = subgraphs.find(scope => scope.id === node.scope);
        if (parent) {
            parent.children = [...(parent.children ?? []), inside.scopeId];
        }
        // The node's own open bundles, which its frame keeps while they are not drawn.
        const bundles = [...new Set(node.ports.map(port => port.group).filter((g): g is string => !!g))]
            .filter(group => state?.isExpanded(stableNodeId(ids, node), group));
        subgraphs.push({
            id: inside.scopeId,
            kind: 'group',
            label: node.label,
            parent: parent ? parent.id : (node.scope ?? null),
            nodes: inside.cells.map(cell => cell.id),
            edges: inside.edges.map(edge => edge.id),
            openNodeKey: stableNodeId(ids, node),
            // Opened in a group laid out in rows, its frame keeps its row.
            ...(typeof node.meta?.['row'] === 'number' ? { row: node.meta['row'] } : {}),
            ...(bundles.length ? { openNodeBundles: bundles } : {})
        });
    }
    const nodes = [...doc.graph.nodes.filter(node => !openedIds.has(node.id)), ...insides.flatMap(inside => inside.cells)];
    return { ...doc, graph: { ...doc.graph, nodes, edges, subgraphs } };
}

function withEnd(edge: PyGraphEdge, id: string, end: Record<string, unknown>): PyGraphEdge {
    const out: Record<string, unknown> = { ...edge, id, ...end };
    for (const [key, value] of Object.entries(end)) {
        if (value === undefined) {
            delete out[key];
        }
    }
    return out as PyGraphEdge;
}

/** The node an edge starts at, when the producer says (`fromNode`; an end given or dropped with it). */
function fromNodeOf(edge: PyGraphEdge): unknown {
    return (edge as Record<string, unknown>)['fromNode'];
}

type Point = { x: number; y: number };

/** Inside an open node's frame: the margin around its members, and between them. */
export const OPEN_NODE_SPACING = { padding: 16, column: 40, row: 16 } as const;

/**
 * `positions` (absolute, by layout key) with places for what a toggle made
 * that a saved layout cannot hold: a frame just opened takes its node's
 * place and its members columns from it, by depth from the frame's inputs;
 * a node just closed takes its frame's place. What is not drawn (an open
 * node; a closed node's frame and members) has its place dropped, so it is
 * not counted as two nodes on one spot. Returns `positions` itself when
 * nothing changes.
 */
export function withOpenNodePositions(graph: unknown, positions: Map<string, Point>): Map<string, Point> {
    let filled: Map<string, Point> | undefined;
    const writable = (): Map<string, Point> => (filled ??= new Map(positions));
    const all: any[] = [];
    const walk = (element: any): void => {
        all.push(element);
        for (const child of (element?.children as unknown[] | undefined) ?? []) {
            walk(child);
        }
    };
    walk(graph);
    const edges = all.filter(element => typeof element?.sourceId === 'string' && typeof element?.targetId === 'string');
    for (const element of all) {
        const args = element?.args as Record<string, unknown> | undefined;
        if (element?.type === WorkflowDiagramTypes.NODE_GROUP && typeof args?.[WorkflowDiagramMetadata.OPEN_NODE_KEY] === 'string') {
            const frameKey = nodeLayoutKeyOf(element);
            const nodeKey = args[WorkflowDiagramMetadata.OPEN_NODE_KEY] as string;
            const members = ((element.children ?? []) as any[]).filter(isMovableNode);
            if (!frameKey) {
                continue;
            }
            const origin = positions.get(frameKey) ?? positions.get(nodeKey);
            if (!origin) {
                continue;
            }
            if (!positions.has(frameKey)) {
                writable().set(frameKey, { ...origin });
            }
            // Open, the node itself is not drawn: its place, now the frame's,
            // would count as two nodes on one spot.
            if (positions.has(nodeKey)) {
                writable().delete(nodeKey);
            }
            const unplaced = members.filter(member => {
                const key = nodeLayoutKeyOf(member);
                return key !== undefined && !positions.has(key);
            });
            if (unplaced.length > 0) {
                for (const [key, at] of columnsFor(members, edges, origin)) {
                    if (!positions.has(key)) {
                        writable().set(key, at);
                    }
                }
            }
        } else if (args?.[WorkflowDiagramMetadata.NODE_OPENABLE] === true) {
            const nodeKey = nodeLayoutKeyOf(element);
            const producerId = args[WorkflowDiagramMetadata.GRAPH_NODE_ID];
            if (!nodeKey || typeof producerId !== 'string') {
                continue;
            }
            const frameKey = openFrameId(producerId);
            const frameAt = positions.get(frameKey);
            if (frameAt && !positions.has(nodeKey)) {
                writable().set(nodeKey, { ...frameAt });
            }
            // Closed, its frame and members (named under the frame's id) are not drawn.
            const memberPrefix = `${frameKey}/`;
            for (const key of positions.keys()) {
                if (key === frameKey || key.startsWith(memberPrefix)) {
                    writable().delete(key);
                }
            }
        }
    }
    return filled ?? positions;
}

/**
 * Members laid out in columns inside a frame at `origin`: a member's column
 * is its longest path from a member nothing inside feeds, each column as wide
 * as its widest member, members stacked in it in the order they come.
 */
function columnsFor(members: any[], edges: any[], origin: Point): Map<string, Point> {
    const ids = new Set(members.map(member => String(member.id)));
    const nodeOfPort = new Map<string, string>();
    for (const member of members) {
        for (const child of member.children ?? []) {
            nodeOfPort.set(String(child.id), String(member.id));
        }
    }
    const feeds = new Map<string, Set<string>>();
    for (const edge of edges) {
        const from = nodeOfPort.get(edge.sourceId) ?? (ids.has(edge.sourceId) ? edge.sourceId : undefined);
        const to = nodeOfPort.get(edge.targetId) ?? (ids.has(edge.targetId) ? edge.targetId : undefined);
        if (from && to && from !== to) {
            feeds.set(to, (feeds.get(to) ?? new Set()).add(from));
        }
    }
    const depth = new Map<string, number>();
    const depthOf = (id: string, seen: Set<string>): number => {
        const known = depth.get(id);
        if (known !== undefined) {
            return known;
        }
        if (seen.has(id)) {
            return 0; // a loop through a register: cut it
        }
        seen.add(id);
        let d = 0;
        for (const from of feeds.get(id) ?? []) {
            d = Math.max(d, depthOf(from, seen) + 1);
        }
        seen.delete(id);
        depth.set(id, d);
        return d;
    };
    const columns: any[][] = [];
    for (const member of members) {
        const d = depthOf(String(member.id), new Set());
        (columns[d] ??= []).push(member);
    }
    const out = new Map<string, Point>();
    const { padding, column, row } = OPEN_NODE_SPACING;
    let x = origin.x + padding;
    for (const members of columns.filter(Boolean)) {
        let y = origin.y + WorkflowDiagramConstants.GROUP_HEADER_HEIGHT_PX + padding;
        let widest = 0;
        for (const member of members) {
            const key = nodeLayoutKeyOf(member);
            if (key) {
                out.set(key, { x, y });
            }
            y += (member.size?.height ?? 40) + row;
            widest = Math.max(widest, member.size?.width ?? 60);
        }
        x += widest + column;
    }
    return out;
}
