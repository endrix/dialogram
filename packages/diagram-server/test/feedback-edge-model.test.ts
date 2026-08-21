/**
 * Feedback loops, through the real model source.
 *
 * `feedback-edges.test.ts` pins the walk on a bare graph. This pins the part
 * that can only go wrong here: edges attach to PORTS, and a loop is a property
 * of the NODES behind them. Get the ownership lookup wrong and every actor in a
 * straight pipeline — one in port, one out port — looks like a cycle, which is
 * the failure mode that would make the highlight worse than useless.
 */
import { describe, expect, it } from 'vitest';
import { GraphGModelSource, type PyGraphDocument } from '../src/model/graph-gmodel-source';

/** An actor with one input and one output, wired the way the exporters emit. */
function actor(name: string): PyGraphDocument['graph']['nodes'][number] {
    return {
        id: `node:scope:root:${name}`,
        kind: 'actor',
        label: name,
        type: 'A',
        scope: 'scope:root',
        ports: [
            { id: `port:node:${name}:In`, name: 'In', direction: 'in' },
            { id: `port:node:${name}:Out`, name: 'Out', direction: 'out' }
        ]
    };
}

function connect(id: string, from: string, to: string): PyGraphDocument['graph']['edges'][number] {
    return { id, from: `port:node:${from}:Out`, to: `port:node:${to}:In`, scope: 'scope:root' };
}

function transform(
    nodes: string[],
    edges: PyGraphDocument['graph']['edges']
): Map<string, string[]> {
    const doc: PyGraphDocument = {
        version: '1',
        graph: { id: 'root', nodes: nodes.map(actor), edges }
    };
    const children = new GraphGModelSource().transform(doc).graph.children ?? [];
    const byId = new Map<string, string[]>();
    for (const child of children) {
        if (edges.some(e => e.id === child.id)) {
            byId.set(child.id, child.cssClasses ?? []);
        }
    }
    return byId;
}

const FEEDBACK = 'workflow-edge-feedback';

describe('feedback loops in a built model', () => {
    it('marks nothing in a straight pipeline', () => {
        // The regression that matters: an actor's in and out port must collapse
        // to one node. Treated separately, A->B->C reads as a chain of loops.
        const classes = transform(
            ['A', 'B', 'C'],
            [connect('e1', 'A', 'B'), connect('e2', 'B', 'C')]
        );
        expect(classes.size).toBe(2);
        for (const [id, css] of classes) {
            expect(css, id).not.toContain(FEEDBACK);
        }
    });

    it('marks the connection that closes a loop', () => {
        const classes = transform(
            ['A', 'B', 'C'],
            [connect('e1', 'A', 'B'), connect('e2', 'B', 'C'), connect('back', 'C', 'A')]
        );
        expect(classes.get('back')).toContain(FEEDBACK);
        expect(classes.get('e1')).not.toContain(FEEDBACK);
        expect(classes.get('e2')).not.toContain(FEEDBACK);
    });

    it('keeps the classes an edge already had', () => {
        // The marking is additive: an errored edge that also closes a loop must
        // still read as errored, because that is the one a reader must act on.
        const doc: PyGraphDocument = {
            version: '1',
            graph: {
                id: 'root',
                nodes: [actor('A'), actor('B')],
                edges: [
                    connect('e1', 'A', 'B'),
                    { ...connect('back', 'B', 'A'), meta: { isErrored: true, errorMessage: 'bad' } }
                ]
            }
        };
        const children = new GraphGModelSource().transform(doc).graph.children ?? [];
        const back = children.find(c => c.id === 'back');
        expect(back?.cssClasses).toContain('cal-edge-error');
        expect(back?.cssClasses).toContain(FEEDBACK);
    });

    it('says so in the args, not only in a class', () => {
        // The class draws it; the arg is what a property panel or an agent can
        // ask about without parsing a stylesheet.
        const doc: PyGraphDocument = {
            version: '1',
            graph: {
                id: 'root',
                nodes: [actor('A'), actor('B')],
                edges: [connect('e1', 'A', 'B'), connect('back', 'B', 'A')]
            }
        };
        const children = new GraphGModelSource().transform(doc).graph.children ?? [];
        expect(children.find(c => c.id === 'back')?.args?.['cal:isFeedback']).toBe(true);
        expect(children.find(c => c.id === 'e1')?.args?.['cal:isFeedback']).toBeUndefined();
    });
});
