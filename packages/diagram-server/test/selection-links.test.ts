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

describe('a node that is one drawing of something', () => {
    it('says what it draws, for the client to mark the others', () => {
        const elements = all(new GraphGModelSource().transform(document([])).graph.children as unknown as Element[]);
        expect(elements.find(element => element.id === 'act')?.args?.[WorkflowDiagramMetadata.SAME_AS]).toBe('the-action');
        expect(elements.find(element => element.id === 'x')?.args?.[WorkflowDiagramMetadata.SAME_AS]).toBeUndefined();
    });
});
