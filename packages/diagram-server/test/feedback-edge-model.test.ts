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

    it('marks every connection of a loop with its ends, for the drawing to say which runs back', () => {
        const doc: PyGraphDocument = {
            version: '1',
            graph: { id: 'root', nodes: ['A', 'B', 'C'].map(actor), edges: [connect('e1', 'A', 'B'), connect('e2', 'B', 'C'), connect('back', 'C', 'A')] }
        };
        const children = new GraphGModelSource().transform(doc).graph.children ?? [];
        for (const id of ['e1', 'e2', 'back']) {
            const edge = children.find(c => c.id === id) as any;
            expect(edge.args?.['wf:onLoop'], id).toBe(true);
            expect(edge.args?.['wf:loopEnds'], id).toEqual([[edge.sourceId, edge.targetId]]);
            // Not the server's to say which one is drawn back.
            expect(edge.cssClasses ?? [], id).not.toContain(FEEDBACK);
        }
    });

    it('marks a loop on one actor as feedback, whichever way it is drawn', () => {
        const doc: PyGraphDocument = {
            version: '1',
            graph: {
                id: 'root',
                nodes: [actor('A'), { ...actor('B'), ports: [...actor('B').ports!, { id: 'port:node:B:Fb', name: 'Fb', direction: 'in' }] }],
                edges: [connect('e1', 'A', 'B'), { id: 'self', from: 'port:node:B:Out', to: 'port:node:B:Fb', scope: 'scope:root' }]
            }
        };
        const children = new GraphGModelSource().transform(doc).graph.children ?? [];
        const self = children.find(c => c.id === 'self') as any;
        expect(self.cssClasses).toContain(FEEDBACK);
        expect(self.args?.['cal:isFeedback']).toBe(true);
        expect((children.find(c => c.id === 'e1') as any).args?.['wf:onLoop']).toBeUndefined();
    });

    it('marks the actors of a processor\u2019s core on their loops, and not the wires of its boundary', () => {
        // Top / Core of a CPU: mem_Resp and irq come in, mem_Req and cpu_Com go
        // out; mif, dec, cpu, mul and div are one loop.
        const unit = (name: string, ins: string[], outs: string[]): PyGraphDocument['graph']['nodes'][number] => ({
            id: `node:${name}`, kind: 'actor', label: name, type: name, scope: 'scope:root',
            ports: [...ins.map(p => ({ id: `p:${name}:${p}`, name: p, direction: 'in' as const })), ...outs.map(p => ({ id: `p:${name}:${p}`, name: p, direction: 'out' as const }))]
        });
        const wire = (id: string, from: string, to: string) => ({ id, from, to, scope: 'scope:root' });
        const doc: PyGraphDocument = {
            version: '1',
            graph: {
                id: 'root',
                nodes: [
                    unit('mif', ['Resp', 'Cmd'], ['Req', 'Dec', 'Data']),
                    unit('dec', ['In'], ['Dec']),
                    unit('cpu', ['Dec', 'Irq', 'MulAnswer', 'DivAnswer', 'Data'], ['MulOffer', 'DivOffer', 'Cmd', 'Com']),
                    unit('mul', ['Offer'], ['Answer']),
                    unit('div', ['Offer'], ['Answer']),
                    { id: 'in:mem_Resp', kind: 'input', label: 'mem_Resp', scope: 'scope:root', ports: [{ id: 'p:mem_Resp', name: 'mem_Resp', direction: 'out' }] },
                    { id: 'in:irq', kind: 'input', label: 'irq', scope: 'scope:root', ports: [{ id: 'p:irq', name: 'irq', direction: 'out' }] },
                    { id: 'out:mem_Req', kind: 'output', label: 'mem_Req', scope: 'scope:root', ports: [{ id: 'p:mem_Req', name: 'mem_Req', direction: 'in' }] },
                    { id: 'out:cpu_Com', kind: 'output', label: 'cpu_Com', scope: 'scope:root', ports: [{ id: 'p:cpu_Com', name: 'cpu_Com', direction: 'in' }] }
                ] as any,
                edges: [
                    wire('resp', 'p:mem_Resp', 'p:mif:Resp'), wire('irq', 'p:irq', 'p:cpu:Irq'),
                    wire('req', 'p:mif:Req', 'p:mem_Req'), wire('com', 'p:cpu:Com', 'p:cpu_Com'),
                    wire('cmd', 'p:cpu:Cmd', 'p:mif:Cmd'), wire('data', 'p:mif:Data', 'p:cpu:Data'),
                    wire('fetch', 'p:mif:Dec', 'p:dec:In'), wire('decoded', 'p:dec:Dec', 'p:cpu:Dec'),
                    wire('mulOffer', 'p:cpu:MulOffer', 'p:mul:Offer'), wire('mulAnswer', 'p:mul:Answer', 'p:cpu:MulAnswer'),
                    wire('divOffer', 'p:cpu:DivOffer', 'p:div:Offer'), wire('divAnswer', 'p:div:Answer', 'p:cpu:DivAnswer')
                ]
            }
        };
        const children = new GraphGModelSource().transform(doc).graph.children ?? [];
        const onLoop = children.filter((c: any) => c.args?.['wf:onLoop'] === true).map(c => c.id).sort();
        expect(onLoop).toEqual(['cmd', 'data', 'decoded', 'divAnswer', 'divOffer', 'fetch', 'mulAnswer', 'mulOffer']);
        expect(children.filter((c: any) => (c.cssClasses ?? []).includes(FEEDBACK))).toEqual([]);
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
                    { ...connect('back', 'B', 'A'), meta: { isErrored: true, errorMessage: 'bad', feedback: true } }
                ]
            }
        };
        const children = new GraphGModelSource().transform(doc).graph.children ?? [];
        const back = children.find(c => c.id === 'back');
        expect(back?.cssClasses).toContain('cal-edge-error');
        expect(back?.cssClasses).toContain(FEEDBACK);
    });

    it('takes no handshake\u2019s ready for a loop, as the layout lays it back', () => {
        // Each channel is `valid` east to west and `ready` back west to east:
        // with the ready wires, A -> B -> C would be two loops and every ready
        // drawn as feedback.
        const stage = (name: string, extra: PyGraphDocument['graph']['nodes'][number]['ports'] = []): PyGraphDocument['graph']['nodes'][number] => ({
            id: `node:${name}`, kind: 'actor', label: name, type: 'Stage', scope: 'scope:root',
            ports: [
                { id: `p:${name}:in_valid`, name: 'in_valid', direction: 'in' },
                { id: `p:${name}:in_ready`, name: 'in_ready', direction: 'out', side: 'WEST' },
                { id: `p:${name}:out_valid`, name: 'out_valid', direction: 'out' },
                { id: `p:${name}:out_ready`, name: 'out_ready', direction: 'in', side: 'EAST' },
                ...extra
            ]
        });
        const channel = (from: string, to: string) => [
            { id: `${from}${to}:valid`, from: `p:${from}:out_valid`, to: `p:${to}:in_valid`, scope: 'scope:root' },
            { id: `${from}${to}:ready`, from: `p:${to}:in_ready`, to: `p:${from}:out_ready`, scope: 'scope:root' }
        ];
        const onLoop = (doc: PyGraphDocument): string[] => (new GraphGModelSource().transform(doc).graph.children ?? [])
            .filter((c: any) => c.args?.['wf:onLoop'] === true).map(c => c.id).sort();
        const pipeline: PyGraphDocument = {
            version: '1',
            graph: { id: 'root', nodes: [stage('A'), stage('B'), stage('C')], edges: [...channel('A', 'B'), ...channel('B', 'C')] }
        };
        expect(onLoop(pipeline)).toEqual([]);
        // C fed back to A is a loop: its valid wires are on it, no ready is.
        const ring: PyGraphDocument = {
            version: '1',
            graph: {
                id: 'root',
                nodes: [stage('A', [{ id: 'p:A:fb', name: 'fb', direction: 'in' }]), stage('B'), stage('C')],
                edges: [...channel('A', 'B'), ...channel('B', 'C'), { id: 'CA:valid', from: 'p:C:out_valid', to: 'p:A:fb', scope: 'scope:root' }]
            }
        };
        expect(onLoop(ring)).toEqual(['AB:valid', 'BC:valid', 'CA:valid']);
    });

    it('says so in the args, not only in a class', () => {
        // The class draws it; the arg is what a property panel or an agent can
        // ask about without parsing a stylesheet.
        const doc: PyGraphDocument = {
            version: '1',
            graph: {
                id: 'root',
                nodes: [actor('A'), actor('B')],
                edges: [connect('e1', 'A', 'B'), { ...connect('back', 'B', 'A'), meta: { feedback: true } }]
            }
        };
        const children = new GraphGModelSource().transform(doc).graph.children ?? [];
        expect(children.find(c => c.id === 'back')?.args?.['cal:isFeedback']).toBe(true);
        expect(children.find(c => c.id === 'e1')?.args?.['cal:isFeedback']).toBeUndefined();
    });
});
