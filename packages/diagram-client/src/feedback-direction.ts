/**
 * Which connections on a loop are drawn as feedback: those that run against
 * the flow, their target's end left of their source's.
 *
 * The server marks every connection on a loop of the network (`ON_LOOP`,
 * feedback-edges.ts there) with its two ends (`LOOP_ENDS`); which of a loop's
 * connections is the one going back is the drawing's. A network is laid out
 * left to right, and the edges the layout reverses to lay a loop out are the
 * ones whose target it puts in an earlier layer: left of the source, whatever
 * sides their ports are on. So after a layout this is exactly the layout's
 * feedback edges; after a drag it is still what the reader sees, the wires
 * that run back.
 *
 * A piece of a connection cut at a group's frame keeps the connection's ends,
 * and is drawn by which way the whole connection runs.
 */
import { WorkflowDiagramMetadata } from '@dialogram/shared';
import { absolutePosition } from './toggle-anchor';

interface ElementLike {
    id?: string;
    position?: { x: number; y: number };
    size?: { width: number; height: number };
    parent?: unknown;
}

interface IndexLike {
    getById?(id: string): unknown;
}

/** The middle of an element, in the diagram's coordinates. */
function middleOf(element: ElementLike): { x: number; y: number } {
    const at = absolutePosition(element);
    return { x: at.x + (element.size?.width ?? 0) / 2, y: at.y + (element.size?.height ?? 0) / 2 };
}

/**
 * Whether `edge`, on a loop, is drawn against the flow. Its ends are looked up
 * in `root`'s index; an end not in the model (inside a closed node) stands for
 * the edge's own end there.
 */
export function isDrawnBackwards(root: unknown, edge: { args?: Record<string, unknown>; sourceId?: string; targetId?: string }): boolean {
    if (edge.args?.[WorkflowDiagramMetadata.ON_LOOP] !== true) {
        return false;
    }
    const index = (root as { index?: IndexLike } | undefined)?.index;
    const find = (id: unknown): ElementLike | undefined =>
        typeof id === 'string' ? index?.getById?.(id) as ElementLike | undefined : undefined;
    const ends = edge.args[WorkflowDiagramMetadata.LOOP_ENDS];
    const [sourceId, targetId] = Array.isArray(ends) ? ends : [];
    const source = find(sourceId) ?? find(edge.sourceId);
    const target = find(targetId) ?? find(edge.targetId);
    if (!source || !target) {
        return false;
    }
    return middleOf(target).x < middleOf(source).x;
}
