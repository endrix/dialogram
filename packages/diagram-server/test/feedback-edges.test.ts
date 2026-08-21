/**
 * Which connections close a feedback loop.
 *
 * A feedback loop is what a reader most wants to spot in a dataflow network —
 * it is where the pipeline stops being a pipeline, and it decides initial
 * tokens, deadlock and scheduling — and drawn like every other connection it
 * can only be found by tracing arrows by hand.
 *
 * The claim under test is narrower than "finds cycles": it is that ONE edge per
 * loop is named, the one that sends the signal back, and that a plain pipeline
 * yields none.
 */
import { describe, expect, it } from 'vitest';
import { FeedbackEdgeCandidate, findFeedbackEdges } from '../src/model/feedback-edges';

/** `a -> b` as an edge whose endpoints are already node ids. */
function edge(id: string, sourceId: string, targetId: string): FeedbackEdgeCandidate {
    return { id, sourceId, targetId };
}

/** Endpoints ARE nodes, for the cases that are not about port ownership. */
const identity = (endpointId: string): string => endpointId;

const found = (edges: FeedbackEdgeCandidate[], owner = identity): string[] =>
    [...findFeedbackEdges(edges, owner)].sort();

/**
 * Does removing `remove` leave a network with no cycle left?
 *
 * The property that actually matters: the named edges are a feedback arc set.
 * Counting them instead asks the wrong question — ONE edge can break two
 * overlapping loops, and naming a second would be highlighting an edge that
 * carries the signal forward.
 */
function isAcyclicWithout(edges: FeedbackEdgeCandidate[], remove: string[]): boolean {
    const kept = edges.filter(e => !remove.includes(e.id));
    const out = new Map<string, string[]>();
    for (const e of kept) {
        out.set(e.sourceId, [...(out.get(e.sourceId) ?? []), e.targetId]);
    }
    const state = new Map<string, 'open' | 'done'>();
    const visit = (node: string): boolean => {
        const seen = state.get(node);
        if (seen === 'open') return false;
        if (seen === 'done') return true;
        state.set(node, 'open');
        for (const next of out.get(node) ?? []) {
            if (!visit(next)) return false;
        }
        state.set(node, 'done');
        return true;
    };
    return [...new Set(edges.flatMap(e => [e.sourceId, e.targetId]))].every(visit);
}


describe('a network with no loop', () => {
    it('names nothing in a straight pipeline', () => {
        expect(found([edge('e1', 'a', 'b'), edge('e2', 'b', 'c')])).toEqual([]);
    });

    it('names nothing when two paths rejoin', () => {
        // A diamond is not a loop, and this is the case a naive "have I seen
        // this node" check gets wrong: `d` is reached twice, forward both times.
        expect(
            found([
                edge('e1', 'a', 'b'),
                edge('e2', 'a', 'c'),
                edge('e3', 'b', 'd'),
                edge('e4', 'c', 'd')
            ])
        ).toEqual([]);
    });

    it('names nothing for two actors wired both ways through DIFFERENT nodes', () => {
        expect(found([edge('e1', 'a', 'b'), edge('e2', 'a', 'c')])).toEqual([]);
    });
});

describe('a network with a loop', () => {
    it('always names a set whose removal leaves no loop', () => {
        // The purpose, stated once over several shapes: what is named must be a
        // feedback arc set. Everything else here is about WHICH edge; this is
        // about the set being the right kind of thing at all.
        const shapes: FeedbackEdgeCandidate[][] = [
            [edge('self', 'a', 'a')],
            [edge('e1', 'a', 'b'), edge('back', 'b', 'a')],
            [edge('e1', 'a', 'b'), edge('e2', 'b', 'c'), edge('back', 'c', 'a')],
            [edge('e1', 'a', 'b'), edge('back1', 'b', 'a'), edge('e2', 'c', 'd'), edge('back2', 'd', 'c')],
            [edge('feed', 'pgm', 'core'), edge('fwd', 'core', 'ic'), edge('back', 'ic', 'core')]
        ];
        for (const shape of shapes) {
            const named = found(shape);
            expect(isAcyclicWithout(shape, named), JSON.stringify(shape.map(e => e.id))).toBe(true);
        }
    });

    it('names the edge that closes it, and only that one', () => {
        // Three edges carry the signal forward, one sends it back. Highlighting
        // all four would say the whole loop is exceptional when its closing
        // edge is the exception.
        expect(
            found([
                edge('e1', 'a', 'b'),
                edge('e2', 'b', 'c'),
                edge('e3', 'c', 'd'),
                edge('back', 'd', 'a')
            ])
        ).toEqual(['back']);
    });

    it('names a self-loop', () => {
        expect(found([edge('self', 'a', 'a')])).toEqual(['self']);
    });

    it('names one edge per loop when a network has several', () => {
        expect(
            found([
                edge('e1', 'a', 'b'),
                edge('back1', 'b', 'a'),
                edge('e2', 'c', 'd'),
                edge('back2', 'd', 'c')
            ])
        ).toEqual(['back1', 'back2']);
    });

    it('names both when two loops share a node', () => {
        expect(
            found([
                edge('e1', 'a', 'b'),
                edge('back1', 'b', 'a'),
                edge('e2', 'a', 'c'),
                edge('back2', 'c', 'a')
            ])
        ).toEqual(['back1', 'back2']);
    });

    it('picks the same edge every time for the same input', () => {
        // Which edge of a cycle is "the" back edge depends on where the walk
        // starts, so the walk is deterministic rather than left to hash order —
        // otherwise the highlight would move between opens of the same file.
        const loop = [edge('e1', 'a', 'b'), edge('e2', 'b', 'c'), edge('back', 'c', 'a')];
        const first = found(loop);
        for (let i = 0; i < 5; i++) {
            expect(found(loop)).toEqual(first);
        }
    });
});

describe('edges connect ports, loops belong to nodes', () => {
    it('collapses an actor’s ports onto the actor', () => {
        // The case that makes the ownership lookup necessary: every actor has
        // an in port and an out port, and treating those as separate nodes
        // would make a plain pipeline look like a chain of loops.
        const ports = (endpointId: string): string => endpointId.split(':')[0];
        expect(
            found(
                [edge('e1', 'A:out', 'B:in'), edge('e2', 'B:out', 'C:in')],
                ports
            )
        ).toEqual([]);
    });

    it('sees a loop that only exists once ports are resolved', () => {
        const ports = (endpointId: string): string => endpointId.split(':')[0];
        expect(
            found(
                [edge('e1', 'A:out', 'B:in'), edge('back', 'B:out', 'A:in')],
                ports
            )
        ).toEqual(['back']);
    });
});

describe('scale', () => {
    it('walks a chain far deeper than the call stack, without overflowing', () => {
        // An explicit stack, not recursion: a diagram that crashes the server
        // is worse than one drawn plainly.
        const long: FeedbackEdgeCandidate[] = [];
        for (let i = 0; i < 50_000; i++) {
            long.push(edge(`e${i}`, `n${i}`, `n${i + 1}`));
        }
        long.push(edge('back', 'n50000', 'n0'));
        expect(found(long)).toEqual(['back']);
    });
});

describe('a network with no source actor at all', () => {
    // Reported: "sometimes it happens that there is no source actor without
    // input ports". Then there is no natural entry, so entering sources first
    // decides nothing and the answer must come from the shape of the network.

    it('names one edge in a ring, not the whole ring', () => {
        const ring = [
            edge('a2b', 'a', 'b'),
            edge('b2c', 'b', 'c'),
            edge('c2d', 'c', 'd'),
            edge('d2a', 'd', 'a')
        ];
        const named = found(ring);
        expect(named).toHaveLength(1);
        expect(isAcyclicWithout(ring, named)).toBe(true);
    });

    it('breaks the ring however it is emitted, with a single edge', () => {
        // A symmetric ring has no distinguished edge — every one of them is an
        // equally true answer, so demanding the SAME edge under rotation would
        // be demanding an arbitrary convention. What must hold for any emission
        // order is that exactly one edge is named and that it breaks the loop.
        const ring = [edge('a2b', 'a', 'b'), edge('b2c', 'b', 'c'), edge('c2a', 'c', 'a')];
        for (const order of [ring, [ring[1], ring[2], ring[0]], [...ring].reverse()]) {
            const named = found(order);
            expect(named, JSON.stringify(order.map(e => e.id))).toHaveLength(1);
            expect(isAcyclicWithout(order, named)).toBe(true);
        }
    });

    it('breaks a two-actor loop with a busy actor at its own single edge', () => {
        // `a` feeds three sinks as well as `b`; `b` feeds only `a`. The order
        // that runs the most edges forward starts at `a`, which leaves b -> a
        // as the one pointing back.
        expect(
            found([
                edge('a2b', 'a', 'b'),
                edge('b2a', 'b', 'a'),
                edge('a2x', 'a', 'x'),
                edge('a2y', 'a', 'y'),
                edge('a2z', 'a', 'z')
            ])
        ).toEqual(['b2a']);
    });

    it('breaks two overlapping loops without naming an edge it need not', () => {
        // `a->b->c->a` and `a->b->a` share the `a -> b` edge, so removing that
        // ONE edge leaves both acyclic. Naming a second would highlight an edge
        // that carries the signal forward — the opposite of the point.
        const overlapping = [
            edge('a2b', 'a', 'b'),
            edge('b2c', 'b', 'c'),
            edge('c2a', 'c', 'a'),
            edge('b2a2', 'b', 'a')
        ];
        const named = found(overlapping);
        expect(isAcyclicWithout(overlapping, named)).toBe(true);
        expect(named).toHaveLength(1);
    });
});

describe('the walk starts where the data enters', () => {
    it('names the RETURN edge, not the forward path', () => {
        // Reported from a real network: `pgm -> core -> icache` with icache
        // feeding core again. Both directions of that cycle are valid back
        // edges — which one gets named depends on where the walk starts — and
        // a walk beginning at `icache` names `core -> icache`, colouring the
        // whole forward path and leaving the actual return black.
        //
        // The edge list deliberately puts the return FIRST, which is what made
        // `icache` the first-seen node and produced exactly that.
        const network = [
            edge('back', 'icache', 'core'),
            edge('feed', 'pgm', 'core'),
            edge('fwd', 'core', 'icache')
        ];
        expect(found(network)).toEqual(['back']);
    });

    it('still names something when a cycle has no entry at all', () => {
        // Two actors feeding only each other: no source to start from, so the
        // walk falls back to first-appearance order and must still terminate
        // with one edge named rather than none.
        expect(found([edge('a2b', 'a', 'b'), edge('b2a', 'b', 'a')])).toEqual(['b2a']);
    });

    it('is unmoved by the order the edges arrive in', () => {
        // The property the fix buys: the answer is a fact about the network,
        // not about the order the exporter happened to emit.
        const shuffled = [
            [edge('fwd', 'core', 'icache'), edge('feed', 'pgm', 'core'), edge('back', 'icache', 'core')],
            [edge('feed', 'pgm', 'core'), edge('back', 'icache', 'core'), edge('fwd', 'core', 'icache')],
            [edge('back', 'icache', 'core'), edge('fwd', 'core', 'icache'), edge('feed', 'pgm', 'core')]
        ];
        for (const network of shuffled) {
            expect(found(network)).toEqual(['back']);
        }
    });
});
