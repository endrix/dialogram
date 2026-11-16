/**
 * Which connections on a loop are drawn as feedback: those that run against
 * the flow, their target's end before their source's.
 *
 * The server marks every connection on a loop of the network (`ON_LOOP`,
 * feedback-edges.ts there) with its ends (`LOOP_ENDS`); which of a loop's
 * connections is the one going back is the drawing's. A network is laid out
 * left to right, and the edges the layout reverses to lay a loop out are the
 * ones whose target it puts in an earlier layer: left of the source. So after
 * a layout this is exactly the layout's feedback edges; after a drag it is
 * still what the reader sees, the wires that run back.
 *
 * The same reading as the selection trace's (selection-trace.ts), by the
 * same rule (`standsWhereItsNodeDoes`): a port on a node stands where its
 * node does, so that two nodes that overlap across the page (one under the
 * other, or moved by hand) are not told apart by a few pixels of port
 * offset; a port on a group's frame keeps its own place, the frame is wide.
 *
 * A piece of a connection cut at a group's frame keeps the connection's ends,
 * and is drawn by which way the whole connection runs; a piece several
 * connections share is feedback when one of them runs back.
 */
import { WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import { absolutePosition } from './toggle-anchor';

interface ElementLike {
    type?: string;
    position?: { x: number; y: number };
    size?: { width: number; height: number };
    parent?: ElementLike;
}

interface IndexLike {
    getById?(id: string): unknown;
}

/**
 * Whether a port stands where its node does when a reader tells which way a
 * wire runs: on a node, yes; on a group's frame, no.
 */
export function standsWhereItsNodeDoes(port: { type?: string }, onGroup: boolean): boolean {
    return !onGroup && port.type !== WorkflowDiagramTypes.PORT_GROUP_BOUNDARY;
}

/** Where an end stands across the page: its node's middle, or its own. */
function middleXOf(end: ElementLike): number {
    const node = end.parent;
    const onNode = typeof end.type === 'string' && end.type.startsWith('port')
        && typeof node?.type === 'string' && node.type.startsWith('node');
    const at = onNode && standsWhereItsNodeDoes(end, node!.type === WorkflowDiagramTypes.NODE_GROUP) ? node! : end;
    return absolutePosition(at).x + (at.size?.width ?? 0) / 2;
}

/**
 * Whether `edge`, on a loop, is drawn against the flow: one of the
 * connections it carries is. Their ends are looked up in `root`'s index; a
 * pair whose ends are not in the model (inside a closed node) stands for the
 * edge's own ends.
 */
export function isDrawnBackwards(root: unknown, edge: { args?: Record<string, unknown>; sourceId?: string; targetId?: string }): boolean {
    if (edge.args?.[WorkflowDiagramMetadata.ON_LOOP] !== true) {
        return false;
    }
    const index = (root as { index?: IndexLike } | undefined)?.index;
    const find = (id: unknown): ElementLike | undefined =>
        typeof id === 'string' ? index?.getById?.(id) as ElementLike | undefined : undefined;
    const pairs = edge.args[WorkflowDiagramMetadata.LOOP_ENDS];
    const ends = Array.isArray(pairs) && pairs.length > 0 ? pairs : [[edge.sourceId, edge.targetId]];
    return ends.some(pair => {
        const [sourceId, targetId] = Array.isArray(pair) ? pair : [];
        const source = find(sourceId) ?? find(edge.sourceId);
        const target = find(targetId) ?? find(edge.targetId);
        return !!source && !!target && middleXOf(target) < middleXOf(source);
    });
}
