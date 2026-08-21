/**
 * Which connections close a feedback loop.
 *
 * A dataflow network is read top-to-bottom, and the edges that make that
 * reading work are the ones going forward. A feedback loop is the exception —
 * an actor feeding a stage that runs before it — and it is the thing a reader
 * most wants to spot, because it is where the pipeline stops being a pipeline:
 * it decides initial tokens, deadlock and scheduling. Drawn like every other
 * connection, it can only be found by tracing arrows by hand.
 *
 * ## What counts
 *
 * The BACK EDGES of a depth-first walk: an edge whose target is still open on
 * the current DFS stack, i.e. the edge that closes the cycle. Not every edge of
 * a cycle — in a four-actor loop, three edges carry the signal forward and one
 * sends it back, and highlighting all four would say the whole loop is
 * exceptional when only its closing edge is. A self-loop is its own back edge.
 *
 * Which edge of a cycle gets to be "the" back edge depends on where the walk
 * starts, so the walk is made deterministic rather than left to hash order:
 * nodes are entered in the order they first appear as an edge endpoint, and
 * each node's outgoing edges are followed in the order they were given. The
 * caller's order is the source document's order, so the same file always
 * highlights the same edge.
 *
 * ## Endpoints
 *
 * Edges connect PORTS, and a loop is a property of the NODES behind them, so
 * the caller supplies the ownership lookup rather than this module guessing it
 * from the shape of an id — two ports of one actor must collapse to one node,
 * or every actor with an input and an output would look like a cycle.
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
 * The ids of the edges that close a loop.
 *
 * Empty for an acyclic graph, which is the common case and costs one pass.
 */
export function findFeedbackEdges(
    edges: readonly FeedbackEdgeCandidate[],
    ownerOf: EndpointOwner
): Set<string> {
    /** node → its outgoing edges, in input order. */
    const outgoing = new Map<string, { edgeId: string; target: string }[]>();
    /** Entry order, so the walk does not depend on Map iteration of a hash. */
    const order: string[] = [];

    const see = (node: string): void => {
        if (!outgoing.has(node)) {
            outgoing.set(node, []);
            order.push(node);
        }
    };

    /** Nodes something feeds — i.e. everything that is not a source. */
    const hasIncoming = new Set<string>();

    for (const edge of edges) {
        const source = ownerOf(edge.sourceId);
        const target = ownerOf(edge.targetId);
        see(source);
        see(target);
        outgoing.get(source)!.push({ edgeId: edge.id, target });
        if (target !== source) {
            hasIncoming.add(target);
        }
    }

    const feedback = new Set<string>();
    /** Nodes fully explored — reaching one again can never close a cycle. */
    const done = new Set<string>();
    /** Nodes on the current path. An edge INTO one of these is a back edge. */
    const open = new Set<string>();

    // WHERE THE DATA ENTERS, first.
    //
    // Both directions of a cycle are valid back edges — which one the walk
    // names depends entirely on where it starts, and starting in the middle
    // names the wrong one. A reader looking at `pgm -> core -> icache` and a
    // return from `icache` calls the RETURN the feedback; a walk that happened
    // to begin at `icache` calls `core -> icache` the feedback instead, and
    // colours the whole forward path.
    //
    // Sources — nodes nothing feeds — are where the reader's "forward" starts,
    // so they are entered first. Anything left after that is inside a cycle
    // with no entry of its own, and keeps first-appearance order so the result
    // stays deterministic.
    const roots = [
        ...order.filter(node => !hasIncoming.has(node)),
        ...order.filter(node => hasIncoming.has(node))
    ];

    for (const root of roots) {
        if (done.has(root)) {
            continue;
        }
        // Explicit stack: a network can be deeper than the call stack is tall,
        // and a diagram that crashes the server is worse than one drawn plainly.
        const stack: { node: string; next: number }[] = [{ node: root, next: 0 }];
        open.add(root);

        while (stack.length > 0) {
            const frame = stack[stack.length - 1];
            const edgesOut = outgoing.get(frame.node) ?? [];
            if (frame.next >= edgesOut.length) {
                open.delete(frame.node);
                done.add(frame.node);
                stack.pop();
                continue;
            }
            const { edgeId, target } = edgesOut[frame.next++];
            if (open.has(target)) {
                // Still on the path above us: this edge goes back up it.
                feedback.add(edgeId);
                continue;
            }
            if (done.has(target)) {
                // Explored and left behind — a cross edge, not a loop.
                continue;
            }
            open.add(target);
            stack.push({ node: target, next: 0 });
        }
    }

    return feedback;
}
