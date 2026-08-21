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
