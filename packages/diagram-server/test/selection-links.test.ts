/**
 * Edges a producer marks `meta.onSelection`: links the client draws only
 * while one of their ends is selected.
 *
 * Such an edge is no edge of the model. It takes no part in the layout and
 * crosses no group frame; the transform hands it over on the root, its ends
 * resolved to the model's nodes.
 */
import { describe, expect, it } from 'vitest';
import { WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import { GraphGModelSource, type PyGraphDocument } from '../src/model/graph-gmodel-source';
import { openFrameId } from '../src/model/open-nodes';
import { portBusStateOf } from '../src/model/port-bundles';
import { ToggleNodeOpenOperation } from '@dialogram/shared';

function node(name: string, scope = 'scope:root', meta?: Record<string, unknown>) {
    return {
        id: `node:${name}`,
        kind: 'actor',
        label: name,
        scope,
        ports: [
            { id: `port:node:${name}:in`, name: 'in', direction: 'in' as const },
            { id: `port:node:${name}:out`, name: 'out', direction: 'out' as const }
        ],
        ...(meta ? { meta } : {})
    };
}

const onSelection = (id: string, from: string, to: string, meta: Record<string, unknown> = {}) =>
    ({ id, from, to, scope: 'scope:root', meta: { onSelection: true, ...meta } });

function document(edges: unknown[]): PyGraphDocument {
    return {
        version: '1',
        graph: {
            id: 'root',
            nodes: [node('act', 'scope:S', { sameAs: 'the-action' }), node('var', 'scope:V'), node('x')] as any,
            edges: [{ id: 'e:act->x', from: 'port:node:act:out', to: 'port:node:x:in', scope: 'scope:root' }, ...edges] as any,
            subgraphs: [
                { id: 'scope:S', kind: 'group', label: 'S' },
                { id: 'scope:V', kind: 'group', label: 'V', pin: 'top' }
            ]
        }
    };
}

type Element = { id: string; type: string; args?: Record<string, any>; children?: Element[] };
const all = (elements: Element[] | undefined, out: Element[] = []): Element[] => {
    for (const element of elements ?? []) {
        out.push(element);
        all(element.children, out);
    }
    return out;
};

describe('an edge drawn only on selection', () => {
    const transformed = new GraphGModelSource().transform(document([
        onSelection('l:read', 'node:var', 'node:act', { role: 'read', label: ' reads ' }),
        onSelection('l:both', 'port:node:act:out', 'node:var', { role: 'write', bidirectional: true }),
        onSelection('l:group', 'node:x', 'scope:S'),
        onSelection('l:odd-role', 'node:x', 'node:var', { role: 'Not A Class' }),
        onSelection('l:nowhere', 'node:x', 'node:gone'),
        onSelection('l:self', 'node:x', 'port:node:x:in')
    ]));
    const elements = all(transformed.graph.children as unknown as Element[]);
    const links = (transformed.graph as any).args[WorkflowDiagramMetadata.SELECTION_LINKS] as any[];

    it('is no edge of the model', () => {
        const edges = elements.filter(element => element.type.startsWith('edge'));
        expect(edges.some(edge => edge.id.startsWith('l:'))).toBe(false);
        // The diagram's own edge is still there (in its pieces: it crosses S's frame).
        expect(edges.some(edge => edge.id === 'e:act->x')).toBe(true);
    });

    it('is handed over on the root, its ends the model’s nodes: a node by its id, a port by its node, a group by its scope', () => {
        expect(links.map(l => l.id)).toEqual(['l:read', 'l:both', 'l:group', 'l:odd-role']);
        expect(links[0]).toEqual({ id: 'l:read', from: 'var', to: 'act', role: 'read', label: 'reads' });
        expect(links[1]).toEqual({ id: 'l:both', from: 'act', to: 'var', role: 'write', bidirectional: true });
        expect(links[2]).toEqual({ id: 'l:group', from: 'x', to: 'scope:scope:S' });
        // A role that is no class name is dropped; the link stays.
        expect(links[3]).toEqual({ id: 'l:odd-role', from: 'x', to: 'var' });
        // An end that is not in the document, and a link from a node to itself, are not links.
        for (const id of links.map(l => l.from).concat(links.map(l => l.to))) {
            expect(elements.some(element => element.id === id), id).toBe(true);
        }
    });

    it('crosses no frame: no port is made for it, and a pinned group it touches stays out of the flow', () => {
        const ports = elements.filter(element => element.type === WorkflowDiagramTypes.PORT_GROUP_BOUNDARY);
        // Only the diagram's own edge crosses a frame: out of S.
        expect(ports.map(port => port.id)).toEqual(['scope:scope:S::out::act_port_out']);
        const pinned = elements.find(element => element.id === 'scope:scope:V')!;
        expect(pinned.args?.[WorkflowDiagramMetadata.GROUP_PIN]).toBe('top');
        expect((pinned.children ?? []).some(child => child.type === WorkflowDiagramTypes.PORT_GROUP_BOUNDARY)).toBe(false);
    });

    it('leaves a root with no such edge without the argument', () => {
        const plain = new GraphGModelSource().transform(document([]));
        expect((plain.graph as any).args?.[WorkflowDiagramMetadata.SELECTION_LINKS]).toBeUndefined();
    });
});

describe('a link whose end the platform draws as something else', () => {
    const linksOf = (graph: any): any[] => graph.args?.[WorkflowDiagramMetadata.SELECTION_LINKS] ?? [];
    const idsOf = (graph: any): string[] => all(graph.children as Element[]).map(element => element.id);

    it('ends at the bus a port of the unit is folded into, named by its node or by its port', () => {
        const boundary = (name: string) => ({
            id: `wf:${name}`, kind: 'wf-input', label: name, scope: 'scope:root',
            ports: [{ id: `wf:${name}:p`, name, direction: 'out' as const, group: 'cpx' }],
            meta: { networkBoundary: true }
        });
        const doc: PyGraphDocument = {
            version: '1',
            graph: {
                id: 'root',
                nodes: [boundary('vld'), boundary('data'), node('act')] as any,
                edges: [onSelection('l:node', 'wf:vld', 'node:act'), onSelection('l:port', 'wf:data:p', 'node:act')] as any,
                subgraphs: []
            }
        };
        const graph: any = new GraphGModelSource().transform(doc).graph;
        const links = linksOf(graph);
        // Closed, the two ports are one bus node: both links end there.
        expect(links.map(link => link.id)).toEqual(['l:node', 'l:port']);
        expect(links[0].from).toBe(links[1].from);
        expect(idsOf(graph)).toContain(links[0].from);
        expect(links[0].from).not.toBe('act');
        expect(links.every(link => link.to === 'act')).toBe(true);
    });

    it('ends at the frame of a node opened in place, and at the node while it is closed', () => {
        const big = {
            ...node('big'),
            meta: {
                inner: {
                    nodes: [{ id: 'cell', kind: 'actor', label: 'cell', ports: [{ id: 'cell:a', name: 'a', direction: 'in' }] }],
                    edges: [{ from: 'port:node:big:in', to: 'cell:a' }]
                }
            }
        };
        const doc: PyGraphDocument = {
            version: '1',
            graph: {
                id: 'root',
                nodes: [big, node('act')] as any,
                edges: [onSelection('l:node', 'node:act', 'node:big'), onSelection('l:port', 'node:act', 'port:node:big:in')] as any,
                subgraphs: []
            }
        };
        const closed: any = new GraphGModelSource().transform(doc).graph;
        expect(linksOf(closed).map(link => link.to)).toEqual(['big', 'big']);

        const open = portBusStateOf(new Map([['big', new Set([ToggleNodeOpenOperation.OPEN])]]));
        const opened: any = new GraphGModelSource().transform(doc, { portBuses: open }).graph;
        const frame = openFrameId('node:big');
        expect(idsOf(opened)).toContain(frame);
        expect(idsOf(opened)).not.toContain('big');
        expect(linksOf(opened).map(link => [link.id, link.from, link.to])).toEqual([['l:node', 'act', frame], ['l:port', 'act', frame]]);
    });

    it('is not taken for a wire of a bus: the bus edge counts its own wires only', () => {
        const side = (name: string, direction: 'in' | 'out') => ({
            id: `node:${name}`, kind: 'actor', label: name, scope: 'scope:root',
            ports: [1, 2].map(k => ({ id: `${name}:p${k}`, name: `p${k}`, direction, group: 'bus' }))
        });
        const doc = (edges: unknown[]): PyGraphDocument => ({
            version: '1',
            graph: { id: 'root', nodes: [side('a', 'out'), side('b', 'in')] as any, edges: edges as any, subgraphs: [] }
        });
        const wire = { id: 'e1', from: 'a:p1', to: 'b:p1', scope: 'scope:root' };
        const edgesOf = (graph: any): Element[] => all(graph.children as Element[]).filter(element => element.type.startsWith('edge'));
        const strip = (edges: Element[]) => JSON.stringify(edges.map(edge => ({ id: edge.id, args: edge.args })));

        const alone: any = new GraphGModelSource().transform(doc([wire])).graph;
        const withLink: any = new GraphGModelSource().transform(doc([wire, onSelection('l:ports', 'a:p2', 'b:p2')])).graph;
        // The diagram's edges are what they are without the link.
        expect(strip(edgesOf(withLink))).toBe(strip(edgesOf(alone)));
        expect(linksOf(withLink)).toEqual([{ id: 'l:ports', from: 'a', to: 'b' }]);
    });

    it('is no link between a frame and what is in it, however deep', () => {
        const doc: PyGraphDocument = {
            version: '1',
            graph: {
                id: 'root',
                nodes: [node('act', 'scope:inner'), node('x')] as any,
                edges: [
                    onSelection('l:own', 'node:act', 'scope:inner'),
                    onSelection('l:outer', 'scope:outer', 'node:act'),
                    onSelection('l:nested', 'scope:inner', 'scope:outer'),
                    onSelection('l:other', 'node:x', 'scope:inner')
                ] as any,
                subgraphs: [
                    { id: 'scope:outer', kind: 'group', label: 'outer' },
                    { id: 'scope:inner', kind: 'group', label: 'inner', parent: 'scope:outer' }
                ]
            }
        };
        const graph: any = new GraphGModelSource().transform(doc).graph;
        expect(linksOf(graph)).toEqual([{ id: 'l:other', from: 'x', to: 'scope:scope:inner' }]);
    });
});

describe('a node that is one drawing of something', () => {
    it('says what it draws, for the client to mark the others', () => {
        const elements = all(new GraphGModelSource().transform(document([])).graph.children as unknown as Element[]);
        expect(elements.find(element => element.id === 'act')?.args?.[WorkflowDiagramMetadata.SAME_AS]).toBe('the-action');
        expect(elements.find(element => element.id === 'x')?.args?.[WorkflowDiagramMetadata.SAME_AS]).toBeUndefined();
    });
});
