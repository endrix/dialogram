/**
 * What a producer can say about how its graph reads, without the platform
 * learning its vocabulary.
 *
 * The pattern is the one `external-node-by-meta.test.ts` established: the
 * producer states a fact, the platform derives a hook from it, and the naming
 * happens in the product's own stylesheet. These are the facts a dataflow
 * producer needs to state and could not before — what a node's kind is, what a
 * port is for, what a connection carries, and which connection closes a loop.
 */

import { describe, expect, it } from 'vitest';
import { WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import { GraphGModelSource, type PyGraphDocument, type PyGraphEdge, type PyGraphNode } from '../src/model/graph-gmodel-source';

function transform(nodes: PyGraphNode[], edges: PyGraphEdge[] = []): any[] {
    const doc: PyGraphDocument = { version: '1', graph: { id: 'root', nodes, edges } };
    return new GraphGModelSource().transform(doc).graph.children ?? [];
}

function nodeNamed(children: any[], id: string): any {
    return children.find(child => child.id === id);
}

function actor(overrides: Partial<PyGraphNode> = {}): PyGraphNode {
    return {
        id: 'node:a',
        kind: 'actor',
        label: 'a',
        scope: 'root',
        ports: [],
        ...overrides
    };
}

/** Two nodes wired a -> b and back, so there is a cycle to attribute. */
function loopFixture(edgeMeta?: Record<string, unknown>): any[] {
    const nodes: PyGraphNode[] = [
        {
            id: 'node:a',
            kind: 'actor',
            label: 'a',
            scope: 'root',
            ports: [
                { id: 'p:a:in', name: 'in', direction: 'in' },
                { id: 'p:a:out', name: 'out', direction: 'out' }
            ]
        },
        {
            id: 'node:b',
            kind: 'actor',
            label: 'b',
            scope: 'root',
            ports: [
                { id: 'p:b:in', name: 'in', direction: 'in' },
                { id: 'p:b:out', name: 'out', direction: 'out' }
            ]
        }
    ];
    const edges: PyGraphEdge[] = [
        { id: 'forward', from: 'p:a:out', to: 'p:b:in', scope: 'root' },
        { id: 'back', from: 'p:b:out', to: 'p:a:in', scope: 'root', ...(edgeMeta ? { meta: edgeMeta } : {}) }
    ];
    return transform(nodes, edges);
}

describe('a node kind', () => {
    it('gets a styling hook whether or not it is external', () => {
        // The hook used to be emitted only for external nodes, which made it
        // useless for any kind that is not: the node rendered and the product's
        // own stylesheet had nothing to select.
        const plain = nodeNamed(transform([actor({ kind: 'reg', label: 'acc' })]), 'acc');

        expect(plain.cssClasses).toContain('reg-node');
        expect(plain.cssClasses).toContain('workflow-node');
    });

    it('still gets it when the node is external', () => {
        const external = nodeNamed(
            transform([actor({ kind: 'blackbox', label: 'ram', meta: { external: true } })]),
            'ram'
        );

        expect(external.cssClasses).toContain('blackbox-node');
        expect(external.cssClasses).toContain('external-actor-node');
    });

    it('refuses a kind that would not be a class name', () => {
        // The kind is interpolated into a class attribute, so a value that is
        // not class-shaped is dropped rather than written through.
        const hostile = nodeNamed(transform([actor({ kind: 'a b" onload=x', label: 'x' })]), 'x');

        expect(hostile.cssClasses.some((c: string) => c.includes(' '))).toBe(false);
        expect(hostile.cssClasses.some((c: string) => c.includes('"'))).toBe(false);
    });
});

describe('a port role', () => {
    it('gets a derived hook so it can be styled and hidden', () => {
        // A role the platform has never heard of, deliberately: the mechanism
        // is worth nothing if it only works for words already in this file.
        const node = nodeNamed(
            transform([
                actor({
                    label: 'a',
                    ports: [{ id: 'p', name: 'tick', direction: 'in', role: 'telemetry' }]
                })
            ]),
            'a'
        );
        const port = node.children.find((child: any) => child.type === WorkflowDiagramTypes.PORT_INPUT);

        expect(port.cssClasses).toContain('port-role-telemetry');
        expect(port.args[WorkflowDiagramMetadata.PORT_ROLE]).toBe('telemetry');
    });

    it('keeps the established control treatment', () => {
        // `control` had a class before roles were general, and the property
        // panel and port views read it. Adding the derived hook must not take
        // the old one away.
        const node = nodeNamed(
            transform([
                actor({
                    label: 'a',
                    ports: [{ id: 'p', name: 'go', direction: 'in', role: 'control' }]
                })
            ]),
            'a'
        );
        const port = node.children.find((child: any) => child.type === WorkflowDiagramTypes.PORT_INPUT);

        expect(port.cssClasses).toContain('cal-port-control');
        expect(port.cssClasses).toContain('port-role-control');
        expect(port.args['wf:portRole']).toBe('control');
    });

    it('leaves a port with no role alone', () => {
        const node = nodeNamed(
            transform([actor({ label: 'a', ports: [{ id: 'p', name: 'in', direction: 'in' }] })]),
            'a'
        );
        const port = node.children.find((child: any) => child.type === WorkflowDiagramTypes.PORT_INPUT);

        expect(port.cssClasses.some((c: string) => c.startsWith('port-role-'))).toBe(false);
    });
});

describe('an edge role and width', () => {
    it('gets a derived hook so connection kinds can be told apart', () => {
        // A dataflow network carries several kinds of connection at once. Drawn
        // identically they can only be distinguished by tracing them.
        const edges = loopFixture({ role: 'channel', width: 32 });
        const edge = edges.find((child: any) => child.id === 'back');

        expect(edge.cssClasses).toContain('edge-role-channel');
        expect(edge.args[WorkflowDiagramMetadata.EDGE_ROLE]).toBe('channel');
        expect(edge.args[WorkflowDiagramMetadata.EDGE_WIDTH]).toBe(32);
    });

    it('carries no width when the producer states none', () => {
        const edge = loopFixture()?.find((child: any) => child.id === 'back');

        expect(edge.args[WorkflowDiagramMetadata.EDGE_WIDTH]).toBeUndefined();
    });

    it('draws an undirected connection without an arrowhead', () => {
        const edge = loopFixture({ undirected: true })?.find((child: any) => child.id === 'back');

        expect(edge.type).toBe(WorkflowDiagramTypes.EDGE_CONNECTION_NO_ARROW);
    });
});

describe('which connection closes a loop', () => {
    it('is derived when the producer says nothing', () => {
        // Unchanged behaviour, and the reason the derivation exists: with no
        // opinion available, the edge that points backwards in the layout's own
        // ordering is the honest answer.
        const edges = loopFixture();

        const marked = edges.filter((child: any) => child.args?.[WorkflowDiagramMetadata.IS_FEEDBACK] === true);
        expect(marked.map((edge: any) => edge.id)).toEqual(['back']);
    });

    it('is the producer’s answer when it gives one', () => {
        // Here the producer names the FORWARD edge — a choice the shape-based
        // derivation would never make. That is the point: it proves the
        // declaration is being honoured rather than merely agreeing.
        const nodes: PyGraphNode[] = [
            {
                id: 'node:a',
                kind: 'actor',
                label: 'a',
                scope: 'root',
                ports: [
                    { id: 'p:a:in', name: 'in', direction: 'in' },
                    { id: 'p:a:out', name: 'out', direction: 'out' }
                ]
            },
            {
                id: 'node:b',
                kind: 'actor',
                label: 'b',
                scope: 'root',
                ports: [
                    { id: 'p:b:in', name: 'in', direction: 'in' },
                    { id: 'p:b:out', name: 'out', direction: 'out' }
                ]
            }
        ];
        const edges: PyGraphEdge[] = [
            { id: 'forward', from: 'p:a:out', to: 'p:b:in', scope: 'root', meta: { feedback: true } },
            { id: 'back', from: 'p:b:out', to: 'p:a:in', scope: 'root' }
        ];

        const children = transform(nodes, edges);
        const marked = children.filter((child: any) => child.args?.[WorkflowDiagramMetadata.IS_FEEDBACK] === true);

        expect(marked.map((edge: any) => edge.id)).toEqual(['forward']);
    });

    it('does not mix a declared answer with a derived one', () => {
        // Marking both would mark one cycle twice — once where the producer
        // said, once where the heuristic guessed — and a reader cannot tell
        // which of the two marks means anything.
        const edges = loopFixture({ feedback: true });

        const marked = edges.filter((child: any) => child.args?.[WorkflowDiagramMetadata.IS_FEEDBACK] === true);
        expect(marked).toHaveLength(1);
        expect(marked[0].id).toBe('back');
    });
});
