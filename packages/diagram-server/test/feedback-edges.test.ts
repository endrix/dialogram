/**
 * Which connections lie on a feedback loop.
 *
 * A feedback loop is what a reader most wants to spot in a dataflow network —
 * it is where the pipeline stops being a pipeline, and it decides initial
 * tokens, deadlock and scheduling — and drawn like every other connection it
 * can only be found by tracing arrows by hand.
 *
 * The claim under test: every connection whose two nodes lie on one loop is
 * named, and nothing else; a plain pipeline yields none. Which of a loop's
 * connections is drawn as the one going back is the drawing's (the client's
 * feedback-direction.ts).
 */
import { describe, expect, it } from 'vitest';
import { FeedbackEdgeCandidate, findLoopEdges } from '../src/model/feedback-edges';

/** `a -> b` as an edge whose endpoints are already node ids. */
function edge(id: string, sourceId: string, targetId: string): FeedbackEdgeCandidate {
    return { id, sourceId, targetId };
}

/** Endpoints ARE nodes, for the cases that are not about port ownership. */
const identity = (endpointId: string): string => endpointId;

const found = (edges: FeedbackEdgeCandidate[], owner = identity): string[] =>
    [...findLoopEdges(edges, owner)].sort();

describe('a network with no loop', () => {
    it('names nothing in a straight pipeline', () => {
        expect(found([edge('ab', 'a', 'b'), edge('bc', 'b', 'c')])).toEqual([]);
    });

    it('names nothing when two paths rejoin', () => {
        expect(found([edge('ab', 'a', 'b'), edge('ac', 'a', 'c'), edge('bd', 'b', 'd'), edge('cd', 'c', 'd')])).toEqual([]);
    });

    it('names nothing for two actors wired both ways through DIFFERENT nodes', () => {
        expect(found([edge('ab', 'a', 'b'), edge('cd', 'c', 'd')])).toEqual([]);
    });
});

describe('a network with a loop', () => {
    it('names every connection of a ring, not one', () => {
        expect(found([edge('ab', 'a', 'b'), edge('bc', 'b', 'c'), edge('cd', 'c', 'd'), edge('da', 'd', 'a')]))
            .toEqual(['ab', 'bc', 'cd', 'da']);
    });

    it('names both connections of two actors wired both ways', () => {
        expect(found([edge('ab', 'a', 'b'), edge('ba', 'b', 'a')])).toEqual(['ab', 'ba']);
    });

    it('names a self-loop', () => {
        expect(found([edge('ab', 'a', 'b'), edge('bb', 'b', 'b')])).toEqual(['bb']);
    });

    it('names the connections into and out of a loop no more than a pipeline’s', () => {
        // `in` feeds the loop a <-> b, which feeds `out`.
        expect(found([edge('in', 'src', 'a'), edge('ab', 'a', 'b'), edge('ba', 'b', 'a'), edge('out', 'b', 'sink')]))
            .toEqual(['ab', 'ba']);
    });

    it('leaves plain a connection from one loop to another', () => {
        // a <-> b, then b -> c, then c <-> d: nothing goes back from the second to the first.
        expect(found([edge('ab', 'a', 'b'), edge('ba', 'b', 'a'), edge('bc', 'b', 'c'), edge('cd', 'c', 'd'), edge('dc', 'd', 'c')]))
            .toEqual(['ab', 'ba', 'cd', 'dc']);
    });

    it('names all of two loops that share a node', () => {
        expect(found([edge('ab', 'a', 'b'), edge('ba', 'b', 'a'), edge('bc', 'b', 'c'), edge('cb', 'c', 'b')]))
            .toEqual(['ab', 'ba', 'bc', 'cb']);
    });

    it('is unmoved by the order the edges arrive in', () => {
        const edges = [edge('ab', 'a', 'b'), edge('bc', 'b', 'c'), edge('ca', 'c', 'a'), edge('cd', 'c', 'd')];
        expect(found([...edges].reverse())).toEqual(found(edges));
    });
});

describe('edges connect ports, loops belong to nodes', () => {
    const ports = (endpointId: string): string => endpointId.split(':')[0];

    it('collapses an actor’s ports onto the actor', () => {
        // a:out -> b:in -> (b) -> b:out -> c:in: a pipeline, though every port is its own id.
        expect(found([edge('ab', 'a:out', 'b:in'), edge('bc', 'b:out', 'c:in')], ports)).toEqual([]);
    });

    it('sees a loop that only exists once ports are resolved', () => {
        expect(found([edge('ab', 'a:out', 'b:in'), edge('ba', 'b:back', 'a:fb')], ports)).toEqual(['ab', 'ba']);
    });

    it('takes two ports of one actor wired together for a loop on it', () => {
        expect(found([edge('aa', 'a:out', 'a:fb')], ports)).toEqual(['aa']);
    });
});

describe('scale', () => {
    it('walks a chain far deeper than the call stack, without overflowing', () => {
        const edges: FeedbackEdgeCandidate[] = [];
        for (let k = 0; k < 50_000; k++) {
            edges.push(edge(`e${k}`, `n${k}`, `n${k + 1}`));
        }
        expect(found(edges)).toEqual([]);
        // Closed into one ring, every edge of it.
        edges.push(edge('back', 'n50000', 'n0'));
        expect(findLoopEdges(edges, identity).size).toBe(50_001);
    });
});
