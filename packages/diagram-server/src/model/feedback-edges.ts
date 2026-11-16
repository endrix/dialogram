/**
 * Which connections lie on a feedback loop.
 *
 * A dataflow network is read as a flow, and a feedback loop is the exception
 * — an actor feeding a stage that runs before it — and it is what a reader
 * most wants to spot, because it is where the pipeline stops being a
 * pipeline: it decides initial tokens, deadlock and scheduling.
 *
 * ## What counts
 *
 * Every connection whose two nodes lie on one loop: the strongly connected
 * parts of the network, each node in a part reaching every other. A loop on
 * one node counts.
 *
 * Which of them is DRAWN as feedback is the drawing's: the client marks a
 * connection on a loop where it runs against the flow, which after a layout
 * is exactly the edges the layout reversed to lay the loop out (see
 * `feedback-direction.ts` in the client). An order worked out here, apart
 * from the layout's own cycle breaking, named an edge drawn with the flow as
 * often as the one drawn back: in a two-actor loop it picked one of the two
 * by degree, and the layout the other. A loop on one node is feedback
 * whichever way it is drawn, and is marked here.
 *
 * ## Endpoints
 *
 * Edges connect PORTS, and a loop is a property of the NODES behind them, so the
 * caller supplies the ownership lookup rather than this module guessing it from
 * the shape of an id — two ports of one actor must collapse to one node, or
 * every actor with an input and an output would look like a cycle.
 */

export interface FeedbackEdgeCandidate {
    id: string;
    /** The endpoint the connection leaves from — a port id, usually. */
    sourceId: string;
    /** The endpoint it arrives at. */
    targetId: string;
}

/** Endpoint id → the node that owns it. Unknown endpoints keep their own id. */
export type EndpointOwner = (endpointId: string) => string;

/**
 * The ids of the edges that lie on a loop: a self-loop, or an edge whose two
 * nodes are in one strongly connected part. Empty for an acyclic network.
 */
export function findLoopEdges(
    edges: readonly FeedbackEdgeCandidate[],
    ownerOf: EndpointOwner
): Set<string> {
    const resolved = edges.map(edge => ({ id: edge.id, source: ownerOf(edge.sourceId), target: ownerOf(edge.targetId) }));
    const out = new Map<string, string[]>();
    /** First-appearance order, so the walk is the same twice. */
    const nodes: string[] = [];
    const see = (id: string): void => {
        if (!out.has(id)) {
            out.set(id, []);
            nodes.push(id);
        }
    };
    for (const edge of resolved) {
        see(edge.source);
        see(edge.target);
        if (edge.source !== edge.target) {
            out.get(edge.source)!.push(edge.target);
        }
    }
    const part = strongParts(nodes, out);
    const onLoop = new Set<string>();
    for (const edge of resolved) {
        if (edge.source === edge.target || part.get(edge.source) === part.get(edge.target)) {
            onLoop.add(edge.id);
        }
    }
    return onLoop;
}

/**
 * Each node's strongly connected part, numbered (Tarjan). Walked with a stack
 * of its own, not the call stack: a network of tens of thousands of nodes in a
 * chain is as deep.
 */
function strongParts(nodes: readonly string[], out: ReadonlyMap<string, readonly string[]>): Map<string, number> {
    const index = new Map<string, number>();
    const low = new Map<string, number>();
    const open: string[] = [];
    const isOpen = new Set<string>();
    const part = new Map<string, number>();
    let next = 0;
    let parts = 0;
    const enter = (node: string): void => {
        index.set(node, next);
        low.set(node, next);
        next += 1;
        open.push(node);
        isOpen.add(node);
    };
    for (const root of nodes) {
        if (index.has(root)) {
            continue;
        }
        enter(root);
        const walk: Array<{ node: string; edge: number }> = [{ node: root, edge: 0 }];
        while (walk.length > 0) {
            const at = walk[walk.length - 1];
            const targets = out.get(at.node) ?? [];
            if (at.edge < targets.length) {
                const target = targets[at.edge];
                at.edge += 1;
                if (!index.has(target)) {
                    enter(target);
                    walk.push({ node: target, edge: 0 });
                } else if (isOpen.has(target)) {
                    low.set(at.node, Math.min(low.get(at.node)!, index.get(target)!));
                }
                continue;
            }
            walk.pop();
            if (walk.length > 0) {
                const parent = walk[walk.length - 1].node;
                low.set(parent, Math.min(low.get(parent)!, low.get(at.node)!));
            }
            if (low.get(at.node) === index.get(at.node)) {
                let member: string;
                do {
                    member = open.pop()!;
                    isOpen.delete(member);
                    part.set(member, parts);
                } while (member !== at.node);
                parts += 1;
            }
        }
    }
    return part;
}
