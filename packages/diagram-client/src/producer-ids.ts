/**
 * The diagram element a producer-side id names. A graph document's node ids
 * (`wf:graphNodeId`) are not the diagram's element ids: the diagram names a
 * node by its label, so a producer id can equal another node's diagram id. An
 * outline focus, a property-panel link or a headless render's selection may
 * carry either.
 */
import { WorkflowDiagramMetadata } from '@dialogram/shared';

type ElementLike = { id?: string; type?: string; args?: Record<string, unknown>; children?: unknown[] };

/**
 * The id of the first node, in document order, whose producer id is `id`;
 * else the id of the first node whose own id is `id`; else `undefined`.
 * The producer id wins because it is the stable identity; a direct hit must
 * be a node, so a port, label or compartment that happens to carry the id is
 * never selected in its place.
 */
export function findNodeIdByGraphId(root: unknown, id: string): string | undefined {
    const queue: ElementLike[] = [root as ElementLike];
    let byOwnId: string | undefined;
    for (let next = 0; next < queue.length; next += 1) {
        const element = queue[next];
        if (!element) {
            continue;
        }
        const isNode = typeof element.type === 'string' && element.type.startsWith('node');
        if (isNode && typeof element.id === 'string') {
            if (element.args?.[WorkflowDiagramMetadata.GRAPH_NODE_ID] === id) {
                return element.id;
            }
            if (byOwnId === undefined && element.id === id) {
                byOwnId = element.id;
            }
        }
        const children = element.children as ElementLike[] | undefined;
        if (Array.isArray(children)) {
            for (const child of children) {
                queue.push(child);
            }
        }
    }
    return byOwnId;
}
