/**
 * A handshake answers backwards: `ready` leaves an instance on the west, beside
 * the `valid` it answers, and enters the queue on the east. ELK sees a cycle
 * for every channel and has to lay one of its wires against the flow. Its
 * greedy cycle breaker counts wires: a queue drives five (data, valid, size,
 * ready, space) and takes three, so every queue became a source, every actor
 * a sink, and a pipeline came out as a column of queues beside a column of
 * actors. The engine now tells ELK which wires go with the flow: a wire that
 * leaves a west port or enters an east port is the return wire and is the one
 * to lay backwards. This pins that a chain producer → queue → consumer comes
 * out in that order, on the layout the server really runs.
 */
import { describe, expect, it } from 'vitest';
import ELK from 'elkjs/lib/elk.bundled.js';
import { GGraph, GNode } from '@eclipse-glsp/server';
import { DefaultElementFilter } from '@eclipse-glsp/layout-elk';
import { WorkflowElkLayoutEngine } from '../src/server/elk-layout-engine';
import { WorkflowLayoutConfigurator } from '../src/server/layout-configurator';
import { GraphGModelSource, type PyGraphDocument, type PyGraphPort } from '../src/model/graph-gmodel-source';
import { convertToGModelRoot } from '../src/server/gmodel-convert';

function find(element: any, id: string): any {
    if (!element) {
        return undefined;
    }
    if (element.id === id) {
        return element;
    }
    for (const child of element.children ?? []) {
        const hit = find(child, id);
        if (hit) {
            return hit;
        }
    }
    return undefined;
}

/** A handshake channel's ports on one node: the return wires sit beside the data. */
function channel(node: string, name: string, dir: 'in' | 'out', extra: string[]): PyGraphPort[] {
    const fwd = dir === 'out' ? 'out' : 'in';
    const back = dir === 'out' ? 'in' : 'out';
    const backSide = dir === 'out' ? 'east' : 'west';
    const port = (suffix: string, direction: 'in' | 'out', side?: string): PyGraphPort =>
        ({ id: `p:${node}:${name}${suffix}`, name: `${name}${suffix}`, direction, type: 'logic', group: name, ...(side ? { side } : {}) });
    return [
        port('', fwd),
        port('_valid', fwd),
        ...extra.filter(s => s === '_size').map(s => port(s, fwd)),
        port('_ready', back, backSide),
        ...extra.filter(s => s === '_space').map(s => port(s, back, backSide))
    ];
}

function wire(from: string, to: string): { id: string; from: string; to: string; scope: string } {
    return { id: `${from}->${to}`, from, to, scope: 'scope:root' };
}

/** A channel between two nodes: data, valid and size one way, ready and space back. */
function link(src: string, srcPort: string, dst: string, dstPort: string, extra: string[]) {
    const data = ['', '_valid', ...extra.filter(s => s === '_size')];
    const back = ['_ready', ...extra.filter(s => s === '_space')];
    return [
        ...data.map(s => wire(`p:${src}:${srcPort}${s}`, `p:${dst}:${dstPort}${s}`)),
        ...back.map(s => wire(`p:${dst}:${dstPort}${s}`, `p:${src}:${srcPort}${s}`))
    ];
}

/**
 * producer → queue → consumer, each link a full handshake. The queue drives
 * five wires and takes three, the shape that made it a source.
 */
const DOC: PyGraphDocument = {
    version: '1.1',
    graph: {
        id: 'wf:core',
        nodes: [
            { id: 'node:producer', kind: 'instance', label: 'producer', type: 'stage', scope: 'scope:root',
              ports: channel('producer', 'out0', 'out', ['_size', '_space']) },
            { id: 'node:queue', kind: 'instance', label: 'queue', type: 'handshake_queue', scope: 'scope:root',
              ports: [...channel('queue', 'ins', 'in', ['_space']), ...channel('queue', 'outs', 'out', ['_size'])] },
            { id: 'node:consumer', kind: 'instance', label: 'consumer', type: 'stage', scope: 'scope:root',
              ports: channel('consumer', 'in0', 'in', ['_size']) }
        ],
        edges: [
            ...link('producer', 'out0', 'queue', 'ins', ['_space']),
            ...link('queue', 'outs', 'consumer', 'in0', ['_size'])
        ]
    }
};

async function layout(doc: PyGraphDocument): Promise<GGraph> {
    const root = convertToGModelRoot(new GraphGModelSource({} as any).transform(doc) as any) as unknown as GGraph;
    const modelState: any = {
        root,
        index: { get: (id: string) => find(root, id), findByClass: (id: string) => find(root, id) }
    };
    const engine = new WorkflowElkLayoutEngine(
        () => new (ELK as any)({ algorithms: ['layered'] }),
        new DefaultElementFilter(),
        new WorkflowLayoutConfigurator(),
        modelState
    );
    await engine.layout();
    return root;
}

function x(root: GGraph, id: string): number {
    return (find(root, id) as GNode).position!.x;
}

describe('WorkflowElkLayoutEngine lays return wires backwards', () => {
    it('keeps a handshake pipeline in dataflow order, the queue between producer and consumer', async () => {
        const root = await layout(DOC);
        expect(x(root, 'producer')).toBeLessThan(x(root, 'queue'));
        expect(x(root, 'queue')).toBeLessThan(x(root, 'consumer'));
    });

    it('leaves a graph without return wires exactly as before: no priority on any wire', async () => {
        const plain: PyGraphDocument = {
            version: '1.1',
            graph: {
                id: 'wf:plain',
                nodes: [
                    { id: 'node:a', kind: 'instance', label: 'a', type: 't', scope: 'scope:root',
                      ports: [{ id: 'p:a:d', name: 'd', direction: 'in', type: 'logic' }, { id: 'p:a:q', name: 'q', direction: 'out', type: 'logic' }] },
                    { id: 'node:b', kind: 'instance', label: 'b', type: 't', scope: 'scope:root',
                      ports: [{ id: 'p:b:d', name: 'd', direction: 'in', type: 'logic' }, { id: 'p:b:q', name: 'q', direction: 'out', type: 'logic' }] }
                ],
                edges: [wire('p:a:q', 'p:b:d'), wire('p:b:q', 'p:a:d')]
            }
        };
        const root = convertToGModelRoot(new GraphGModelSource({} as any).transform(plain) as any) as unknown as GGraph;
        const modelState: any = { root, index: { get: (id: string) => find(root, id), findByClass: (id: string) => find(root, id) } };
        const seen: Array<Record<string, string> | undefined> = [];
        const engine = new WorkflowElkLayoutEngine(
            () => ({ layout: async (g: any) => { for (const e of g.edges ?? []) { seen.push(e.layoutOptions); } return g; } }) as any,
            new DefaultElementFilter(),
            new WorkflowLayoutConfigurator(),
            modelState
        );
        await engine.layout();
        expect(seen.length).toBe(2);
        for (const options of seen) {
            expect(options?.['elk.layered.priority.direction']).toBeUndefined();
        }
    });
});
