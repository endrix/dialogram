/**
 * Which connections close a feedback loop.
 *
 * A dataflow network is read as a flow, and the edges that make that reading
 * work go forward. A feedback loop is the exception — an actor feeding a stage
 * that runs before it — and it is what a reader most wants to spot, because it
 * is where the pipeline stops being a pipeline: it decides initial tokens,
 * deadlock and scheduling. Drawn like every other connection, it can only be
 * found by tracing arrows by hand.
 *
 * ## What counts
 *
 * The network is put in an order that runs as many edges forward as it can, and
 * the edges left pointing backwards in that order are the feedback. Not every
 * edge of a cycle: in a four-actor loop three edges carry the signal forward and
 * one sends it back, and highlighting all four would say the whole loop is
 * exceptional when only its closing edge is. A self-loop points at itself and so
 * counts.
 *
 * ## Why not a plain depth-first walk
 *
 * A DFS names back edges too, but WHICH ones depends entirely on where it
 * starts. Started in the middle of `pgm -> core -> icache` with a return from
 * `icache`, it names `core -> icache` — colouring the whole forward path and
 * leaving the actual return plain. That shipped, and it was reported.
 *
 * Entering sources first fixes that case and not the general one: dataflow
 * networks routinely have NO source, every actor having an input, and then
 * there is no natural entry to start from and the choice is arbitrary again.
 *
 * So the order comes from the greedy sequencing of Eades, Lin and Smyth (1993),
 * which is what layered graph drawing — ELK's cycle breaker included — uses to
 * decide the same question. Peel off sinks (they belong at the end) and sources
 * (they belong at the start); when neither exists, every remaining node is
 * inside a cycle, and the most source-like one — the largest surplus of
 * outgoing over incoming edges — is treated as the entry. The result is a small
 * feedback set and, because it is the same rule the layout engine applies, one
 * that agrees with the way the diagram is drawn.
 *
 * Deriving it from the GRAPH rather than from the finished layout is deliberate:
 * manual positions are saved, and a fact about the network must not change
 * because someone dragged a box to the left.
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

interface NodeState {
    id: string;
    /** Edges to other nodes, self-loops excluded — they constrain no order. */
    out: string[];
    in: string[];
    outDegree: number;
    inDegree: number;
    placed: boolean;
}

/**
 * The ids of the edges that close a loop.
 *
 * Empty for an acyclic network, which is the common case: the sequencing then
 * yields a topological order and nothing points backwards in it.
 */
export function findFeedbackEdges(
    edges: readonly FeedbackEdgeCandidate[],
    ownerOf: EndpointOwner
): Set<string> {
    const nodes = new Map<string, NodeState>();
    /** First-appearance order, so every tie below breaks the same way twice. */
    const order: string[] = [];

    const see = (id: string): NodeState => {
        let node = nodes.get(id);
        if (!node) {
            node = { id, out: [], in: [], outDegree: 0, inDegree: 0, placed: false };
            nodes.set(id, node);
            order.push(id);
        }
        return node;
    };

    const resolved = edges.map(edge => ({
        id: edge.id,
        source: ownerOf(edge.sourceId),
        target: ownerOf(edge.targetId)
    }));

    for (const edge of resolved) {
        const source = see(edge.source);
        const target = see(edge.target);
        if (edge.source === edge.target) {
            // A self-loop is feedback on its own and orders nothing, so it is
            // kept out of the degrees — counted, it would make a node look
            // neither source nor sink forever.
            continue;
        }
        source.out.push(edge.target);
        source.outDegree += 1;
        target.in.push(edge.source);
        target.inDegree += 1;
    }

    const sequence = greedySequence(nodes, order);
    const rank = new Map<string, number>();
    sequence.forEach((id, index) => rank.set(id, index));

    const feedback = new Set<string>();
    for (const edge of resolved) {
        const from = rank.get(edge.source) ?? 0;
        const to = rank.get(edge.target) ?? 0;
        // `<=` rather than `<`: an edge to itself points backwards too.
        if (to <= from) {
            feedback.add(edge.id);
        }
    }
    return feedback;
}

/**
 * Order the nodes so that as few edges as possible point backwards.
 *
 * Eades–Lin–Smyth: sinks go to the end, sources to the start, and when a graph
 * has neither left, the node with the greatest surplus of outgoing over
 * incoming edges is taken as the entry. Ties fall to first-appearance order,
 * which is the source document's order, so the same file always yields the same
 * sequence.
 */
function greedySequence(nodes: Map<string, NodeState>, order: readonly string[]): string[] {
    const head: string[] = [];
    const tail: string[] = [];
    let remaining = nodes.size;

    /** Drop `node` from the graph, keeping its neighbours' degrees honest. */
    const remove = (node: NodeState): void => {
        node.placed = true;
        remaining -= 1;
        for (const targetId of node.out) {
            const target = nodes.get(targetId);
            if (target && !target.placed) {
                target.inDegree -= 1;
            }
        }
        for (const sourceId of node.in) {
            const source = nodes.get(sourceId);
            if (source && !source.placed) {
                source.outDegree -= 1;
            }
        }
    };

    const liveNodes = function* (): Generator<NodeState> {
        for (const id of order) {
            const node = nodes.get(id);
            if (node && !node.placed) {
                yield node;
            }
        }
    };

    while (remaining > 0) {
        let peeled = true;
        while (peeled && remaining > 0) {
            peeled = false;
            for (const node of liveNodes()) {
                if (node.outDegree === 0) {
                    tail.unshift(node.id);
                    remove(node);
                    peeled = true;
                }
            }
            for (const node of liveNodes()) {
                if (node.inDegree === 0) {
                    head.push(node.id);
                    remove(node);
                    peeled = true;
                }
            }
        }
        if (remaining === 0) {
            break;
        }
        // Everything left is inside a cycle, so there is no entry to find —
        // take the most source-like node instead. This is the case a network
        // with no source actor at all consists entirely of.
        //
        // Ties are the interesting part, because in a simple loop every node
        // has the same surplus and the choice decides which edge ends up
        // called feedback. Broken by CONTINUING THE FLOW: prefer the node most
        // fed by what is already placed. In `pgm -> core -> icache` with a
        // return, `core` and `icache` both sit at surplus 0, and core is the
        // one the placed `pgm` feeds — so the walk carries on through it and
        // the return closes the loop, which is what a reader sees. Left to
        // first-appearance order, this named the forward edge instead.
        let best: NodeState | undefined;
        let bestScore: [number, number] = [0, 0];
        for (const node of liveNodes()) {
            const score: [number, number] = [
                node.outDegree - node.inDegree,
                node.in.filter(id => nodes.get(id)?.placed === true).length
            ];
            if (!best || score[0] > bestScore[0] || (score[0] === bestScore[0] && score[1] > bestScore[1])) {
                best = node;
                bestScore = score;
            }
        }
        if (!best) {
            break;
        }
        head.push(best.id);
        remove(best);
    }

    return [...head, ...tail];
}
