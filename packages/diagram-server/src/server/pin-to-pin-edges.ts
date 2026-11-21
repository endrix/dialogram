/**
 * An edge from one of a frame's own pins to another of them: an input wired
 * straight to an output inside it (a branch of an `if` that assigns a net as
 * it is, `count <= load`).
 *
 * ELK takes an edge whose two ends are ports of one node for a self-loop and
 * routes it around the node, outside it, even when the node holds it (and
 * its inside-self-loop options throw on a graph with external ports). Such
 * an edge is laid out as two instead, through a point inside the frame,
 * which ELK routes among the frame's members as any wire from a pin to a
 * member and on; the two routes are joined back into the one edge after.
 */
import type { ElkExtendedEdge, ElkNode, ElkPoint } from 'elkjs';

/** What the split put in a frame for one edge, to be undone after layout. */
export interface PinToPinSplit {
    frameId: string;
    edge: ElkExtendedEdge;
    via: string;
    into: string;
    outOf: string;
}

/** The point an edge is split through: as small as ELK lays out. */
const VIA_SIZE_PX = 1;

/**
 * Splits every edge across a frame, from a pin on its west side to one on its
 * east, held by that frame, into two through a point among its children.
 * Returns what it did, for {@link joinPinToPinEdges}.
 */
export function splitPinToPinEdges(graph: ElkNode): PinToPinSplit[] {
    const splits: PinToPinSplit[] = [];
    const visit = (node: ElkNode): void => {
        const side = new Map((node.ports ?? []).map(port => [port.id, port.layoutOptions?.['elk.port.side']]));
        // A frame (a node laid out with children) only: on any node, an edge from its output back to its
        // input is a feedback wire, which goes around it.
        if (node.children !== undefined && side.size > 0 && node.edges && node.edges.length > 0) {
            const kept: ElkExtendedEdge[] = [];
            for (const edge of node.edges) {
                const from = edge.sources?.[0];
                const to = edge.targets?.[0];
                // Across it, from a pin on its west side to one on its east.
                if (edge.sources?.length !== 1 || edge.targets?.length !== 1 || side.get(from) !== 'WEST' || side.get(to) !== 'EAST') {
                    kept.push(edge);
                    continue;
                }
                const via = `${edge.id}::via`;
                const into = `${edge.id}::into`;
                const outOf = `${edge.id}::outOf`;
                // In a frame laid out in partitions, the point goes with the last: it is no feeder.
                const partitioned = node.layoutOptions?.['elk.partitioning.activate'] === 'true';
                node.children = [...(node.children ?? []), {
                    id: via, width: VIA_SIZE_PX, height: VIA_SIZE_PX,
                    layoutOptions: partitioned ? { 'elk.partitioning.partition': lastPartition(node) } : {}
                }];
                kept.push({ id: into, sources: [from], targets: [via] }, { id: outOf, sources: [via], targets: [to] });
                splits.push({ frameId: node.id, edge, via, into, outOf });
            }
            node.edges = kept;
        }
        for (const child of node.children ?? []) {
            visit(child);
        }
    };
    visit(graph);
    return splits;
}

/**
 * Joins the two halves of every edge {@link splitPinToPinEdges} split, in the
 * laid-out graph, into the edge it was, under its own id, routed as the two
 * were; the point between them goes.
 */
export function joinPinToPinEdges(graph: ElkNode, splits: readonly PinToPinSplit[]): void {
    if (splits.length === 0) {
        return;
    }
    const nodes = new Map<string, ElkNode>();
    const index = (node: ElkNode): void => {
        nodes.set(node.id, node);
        (node.children ?? []).forEach(index);
    };
    index(graph);
    for (const split of splits) {
        const frame = nodes.get(split.frameId);
        if (!frame) {
            continue;
        }
        const halves = new Map((frame.edges ?? []).filter(edge => edge.id === split.into || edge.id === split.outOf).map(edge => [edge.id, edge]));
        const first = halves.get(split.into)?.sections?.[0];
        const second = halves.get(split.outOf)?.sections?.[0];
        frame.children = (frame.children ?? []).filter(child => child.id !== split.via);
        frame.edges = (frame.edges ?? []).filter(edge => !halves.has(edge.id));
        if (!first || !second) {
            frame.edges.push(split.edge);
            continue;
        }
        const points = straightened([first.startPoint, ...(first.bendPoints ?? []), first.endPoint,
            second.startPoint, ...(second.bendPoints ?? []), second.endPoint]);
        frame.edges.push({
            ...split.edge,
            sections: [{
                id: `${split.edge.id}_s0`,
                startPoint: points[0],
                endPoint: points[points.length - 1],
                ...(points.length > 2 ? { bendPoints: points.slice(1, -1) } : {}),
                incomingShape: split.edge.sources[0],
                outgoingShape: split.edge.targets[0]
            }]
        } as ElkExtendedEdge);
    }
}

/** The highest partition among a node's children, as ELK reads it. */
function lastPartition(node: ElkNode): string {
    const partitions = (node.children ?? []).map(child => Number(child.layoutOptions?.['elk.partitioning.partition'] ?? 0));
    return String(Math.max(0, ...partitions.filter(Number.isFinite)));
}

/**
 * A route without the points that turn nowhere: one the same as the point
 * before it, one on the line through its neighbours (the two halves meet
 * on a line through the point between them, across its width).
 */
function straightened(points: ElkPoint[]): ElkPoint[] {
    const out: ElkPoint[] = [];
    for (const point of points) {
        const last = out[out.length - 1];
        if (last && last.x === point.x && last.y === point.y) {
            continue;
        }
        out.push(point);
    }
    // A point between two on one line, horizontal or vertical, is no bend.
    for (let k = out.length - 2; k >= 1; k--) {
        const [a, b, c] = [out[k - 1], out[k], out[k + 1]];
        if ((a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y)) {
            out.splice(k, 1);
        }
    }
    return out;
}
