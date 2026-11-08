/**
 * The diagram element a producer-side id names. A graph document's node ids
 * (`wf:graphNodeId`) are not the diagram's element ids; an outline focus, a
 * property-panel link or a headless render's selection may carry either.
 */
import { WorkflowDiagramMetadata } from '@dialogram/shared';

type ElementLike = { id?: string; args?: Record<string, unknown>; children?: unknown[] };

/**
 * The id of the element whose own id is `id`, else of the first element whose
 * producer id is `id`; `undefined` when neither exists under `root`.
 */
export function findNodeIdByGraphId(root: unknown, id: string): string | undefined {
    const stack: ElementLike[] = [root as ElementLike];
    let byProducer: string | undefined;
    while (stack.length > 0) {
        const element = stack.pop();
        if (!element) {
            continue;
        }
        if (element.id === id) {
            return id;
        }
        if (byProducer === undefined && element.args?.[WorkflowDiagramMetadata.GRAPH_NODE_ID] === id && typeof element.id === 'string') {
            byProducer = element.id;
        }
        stack.push(...((element.children ?? []) as ElementLike[]));
    }
    return byProducer;
}
