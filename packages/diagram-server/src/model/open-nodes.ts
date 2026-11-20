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
 * meet no other node's id or saved place. One holding a graph of its own
 * opens in turn, as any node does, its frame inside its parent's: a choice
 * in a sequence, a case of the choice, as deep as the producer nests them. Each opens and closes on its own and is saved under its own key.
 *
 * Three things a producer may say of the graph it gives a node:
 *
 * - `meta.inner.open: true` draws the node open to begin with: a block of a
 *   design whose registers are what the reader came for. Closing it is then
 *   what the layout file records (`ToggleNodeOpenOperation.CLOSED`).
 * - `meta.inner.pins: true` keeps the node's own ports on its frame, as pins
 *   named as they were on the node: an edge on one of them ends there, and
 *   the wires inside run from the pin to what it feeds and to it from what
 *   drives it. A pin nothing is wired to (a clock whose net the diagram
 *   leaves out) is on the frame all the same. Without it the frame has no
 *   pins of its own and edges are carried on to the inner pins, as above.
 *   A pin is one port: a bundle of the node's ports (`group`) is its members
 *   here, each a pin, and a port's `side` is not read (inputs are on the
 *   left of a frame, outputs on its right).
 * - `meta.inner.column: true` stands what the frame holds in one column, one
 *   under another in the order the producer lists it: the steps of a
 *   sequence, the cases of a choice, in their order.
 * - `meta.inner.title` is what the frame is titled, where the node's name
 *   alone does not say what it is once its type is no longer under it
 *   (`counters: always @(posedge clk)`). Without it, the node's name.
 *
 * A node that says either of the first two is a container: its frame is the
 * node (`isContainer`), and carries what the node carries closed. Any other
 * node's frame is a group's, as it was.
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

/** Whether its producer draws a node open to begin with (`meta.inner.open`). */
export function startsOpen(node: Pick<PyGraphNode, 'meta'>): boolean {
    return (node.meta?.['inner'] as { open?: unknown } | undefined)?.open === true;
}

/** The title its producer gives an open node's frame (`meta.inner.title`). */
function givenTitle(node: Pick<PyGraphNode, 'meta'>): string | undefined {
    const title = (node.meta?.['inner'] as { title?: unknown } | undefined)?.title;
    return typeof title === 'string' && title.trim() !== '' ? title.trim() : undefined;
}

/**
 * Whether an open node's frame is that node: one its producer draws open, or
 * whose ports stay on its frame. The frame of any other node is a group's.
 */
export function isContainer(node: Pick<PyGraphNode, 'meta'>): boolean {
    return startsOpen(node) || keepsPins(node);
}

/** Whether a node's own ports stay on its frame as pins when it is open (`meta.inner.pins`). */
export function keepsPins(node: Pick<PyGraphNode, 'meta'>): boolean {
    return (node.meta?.['inner'] as { pins?: unknown } | undefined)?.pins === true;
}

/**
 * Whether the node under `key` is open: as the reader left it, and as its
 * producer draws it while the reader has not said. A node that starts open
 * is open until it is listed closed; any other is closed until listed open.
 */
export function isOpenIn(state: PortBusState | undefined, key: string, node: Pick<PyGraphNode, 'meta'>): boolean {
    return startsOpen(node)
        ? !(state?.isExpanded(key, ToggleNodeOpenOperation.CLOSED) ?? false)
        : (state?.isExpanded(key, ToggleNodeOpenOperation.OPEN) ?? false);
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

/**
 * What the nodes held in an inner node are named by under its frame: their
 * own ids, less the inner node's where every one of them starts with it
 * (`b/x`, `b/y` held in `b`: `x`, `y`). A producer names what it nests by
 * a path, which the frame's id has already said: kept, the ids would grow
 * with the square of the depth. Where one of them does not start so, all
 * keep their ids: `b/x` and `x` would be one.
 */
export function nestedIds(holderId: string, innerIds: readonly string[]): string[] {
    const prefix = `${holderId}/`;
    return innerIds.every(id => id.startsWith(prefix) && id.length > prefix.length)
        ? innerIds.map(id => id.slice(prefix.length))
        : [...innerIds];
}

/** The most levels of open nodes drawn one inside another: a producer's graph that holds itself ends there. */
export const MAX_OPEN_DEPTH = 64;

const push = <K, V>(map: Map<K, V[]>, key: K, value: V): void => {
    const list = map.get(key);
    if (list) {
        list.push(value);
    } else {
        map.set(key, [value]);
    }
};

/**
 * `doc` with the nodes `state` says are open drawn as the groups of what they
 * hold, and, inside those, the nodes that are open in turn.
 */
export function openNodes(doc: PyGraphDocument, state: PortBusState | undefined, ids: StableNodeIds): PyGraphDocument {
    // One level a pass: the nodes a pass draws in a frame are the next one's
    // to open, until a pass opens nothing (or the depth is absurd: a graph
    // in memory may hold itself).
    const producerIds = new Map<string, string>();
    for (let depth = 0; depth < MAX_OPEN_DEPTH; depth++) {
        const next = openOnce(doc, state, ids, producerIds);
        if (next === doc) {
            return doc;
        }
        doc = next;
    }
    return doc;
}

/** `doc` with the nodes of its graph that are open drawn as the groups of what they hold, once. */
function openOnce(doc: PyGraphDocument, state: PortBusState | undefined, ids: StableNodeIds,
    producerIds: Map<string, string>): PyGraphDocument {
    const opened = doc.graph.nodes.filter(node =>
        canOpen(node, doc.graph.subgraphs) && isOpenIn(state, stableNodeId(ids, node), node));
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
        pinned: boolean;                 // its own ports stay on the frame
    }
    const insides: Inside[] = [];
    const ownerOf = new Map<string, Inside>();
    for (const node of opened) {
        const inner = innerGraphOf(node)!;
        const scopeId = openScopeId(node.id);
        const own = new Map(node.ports.map(port => [port.id, port]));
        // An inner node keeps what it holds: the next pass opens it, where it is open. Held in a node
        // that is itself inner, it is named by what its id adds to that node's (the ids of a node of the
        // document's own graph, and of what it holds, are as they always were: layouts are saved by them).
        const holder = producerIds.get(node.id);
        const named = holder === undefined ? inner.nodes.map(cell => cell.id) : nestedIds(holder, inner.nodes.map(cell => cell.id));
        const cells = inner.nodes.map((cell, k) => {
            const id = innerNodeId(node.id, named[k]);
            producerIds.set(id, cell.id);
            return { ...cell, id, scope: scopeId };
        });
        const nodeOfPin = new Map<string, string>();
        for (const cell of cells) {
            for (const port of cell.ports ?? []) {
                nodeOfPin.set(port.id, cell.id);
            }
        }
        const inside: Inside = {
            node, scopeId, own, nodeOfPin, cells, pinned: keepsPins(node),
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
        if (inside.pinned) {
            // Its ports are pins of the frame: the wires inside start and end on them.
            let k = 0;
            for (const [input, pins] of inside.into) {
                for (const pin of pins) {
                    inside.edges.push({ id: `${node.id}/in:${k++}`, from: input, to: pin, scope: scopeId });
                }
            }
            for (const [output, pins] of inside.outOf) {
                for (const pin of pins) {
                    inside.edges.push({ id: `${node.id}/out:${k++}`, from: pin, to: output, scope: scopeId });
                }
            }
            // An input wired straight to an output: across the frame, from pin to pin.
            for (const [input, outputs] of inside.through) {
                for (const output of outputs) {
                    inside.edges.push({ id: `${node.id}/through:${k++}`, from: input, to: output, scope: scopeId });
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
        if (fromIn !== toIn && (fromIn?.pinned || toIn?.pinned)) {
            // An end on a frame's pin stays there; an end on a node opened
            // without pins is carried on to the inner pins, as below.
            const froms: Array<string | undefined> = fromIn && !fromIn.pinned ? (fromIn.outOf.get(edge.from) ?? []) : [undefined];
            const tos: Array<string | undefined> = toIn && !toIn.pinned ? (toIn.into.get(edge.to) ?? []) : [undefined];
            // One edge stays the edge it was, under its own id: only one
            // carried on to several inner pins is several.
            const one = froms.length * tos.length === 1;
            let k = 0;
            for (const from of froms) {
                for (const to of tos) {
                    edges.push(withEnd(edge, one ? edge.id : `${edge.id}@${k++}`, {
                        ...(fromIn ? { from: from ?? edge.from, fromNode: from ? fromIn.nodeOfPin.get(from) : undefined } : {}),
                        ...(toIn ? { to: to ?? edge.to, toNode: to ? toIn.nodeOfPin.get(to) : undefined } : {})
                    }));
                }
            }
            // The end on a node opened without pins may go through it (an
            // input wired straight to an output): joined below, as any other.
            if (toIn && !toIn.pinned) {
                push(inbound, edge.to, edge);
            }
            if (fromIn && !fromIn.pinned) {
                push(outbound, edge.from, edge);
            }
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
        const title = givenTitle(node);
        subgraphs.push({
            id: inside.scopeId,
            kind: 'group',
            label: title ?? node.label,
            parent: parent ? parent.id : (node.scope ?? null),
            nodes: inside.cells.map(cell => cell.id),
            edges: inside.edges.map(edge => edge.id),
            openNodeKey: stableNodeId(ids, node),
            // A container's frame is the node, drawn open: it keeps what the
            // node says of itself, and its ports where the producer asks for them.
            ...(isContainer(node) ? { openNode: node } : {}),
            ...(title !== undefined ? { titled: true } : {}),
            ...(inside.pinned ? { pins: node.ports } : {}),
            ...((node.meta?.['inner'] as { column?: unknown } | undefined)?.column === true ? { column: true } : {}),
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
 *
 * `asSaved`: the positions are a layout file's, not the diagram's as it is
 * drawn now. A node its producer draws open, whose frame the file has no
 * place for, was saved closed (before its producer said so): its frame is
 * left without a place, so the view is laid out again rather than opened
 * with every such frame over its neighbours, in the room of a closed node.
 */
export function withOpenNodePositions(graph: unknown, positions: Map<string, Point>, asSaved = false): Map<string, Point> {
    let filled: Map<string, Point> | undefined;
    const writable = (): Map<string, Point> => (filled ??= new Map(positions));
    const current = (): Map<string, Point> => filled ?? positions;
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
            // (A frame in a frame just opened has its place from its parent's, above.)
            const origin = current().get(frameKey) ?? current().get(nodeKey);
            if (!origin) {
                continue;
            }
            if (asSaved && !positions.has(frameKey) && args[WorkflowDiagramMetadata.NODE_STARTS_OPEN] === true) {
                continue;
            }
            if (!current().has(frameKey)) {
                writable().set(frameKey, { ...origin });
            }
            // Open, the node itself is not drawn: its place, now the frame's,
            // would count as two nodes on one spot.
            if (positions.has(nodeKey)) {
                writable().delete(nodeKey);
            }
            const unplaced = members.filter(member => {
                const key = nodeLayoutKeyOf(member);
                return key !== undefined && !current().has(key);
            });
            // A member that is a frame is left without a place where it has no size yet (it was never laid
            // out: the columns would stack the rest over it), and where its producer draws it open and the
            // file has no place for it, as such a frame of the diagram's own is (above). Unplaced, the view
            // is laid out again.
            const unsaved = new Set(members.filter(member => member.type === WorkflowDiagramTypes.NODE_GROUP && (
                !(member.size?.width > 0 && member.size?.height > 0)
                || (asSaved && member.args?.[WorkflowDiagramMetadata.NODE_STARTS_OPEN] === true && !positions.has(nodeLayoutKeyOf(member) ?? ''))))
                .map(member => nodeLayoutKeyOf(member)));
            if (unplaced.length > 0) {
                for (const [key, at] of columnsFor(members, edges, origin)) {
                    if (!current().has(key) && !unsaved.has(key)) {
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
            // Closed, its frame and members (named under the frame's id) are not drawn, nor the frames in
            // it and theirs (`scope:open:scope:open:<id>/...`, the frame's id inside theirs).
            const memberPrefix = `${frameKey}/`;
            for (const key of [...current().keys()]) {
                if (key === frameKey || key.startsWith(memberPrefix) || key.includes(`:${memberPrefix}`)) {
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
