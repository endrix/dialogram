/**
 * A producer's groups, drawn as containers.
 *
 * A scope of kind `group` gathers the nodes that declare it (or that it
 * lists) into a labelled frame, nested under its parent group when it has
 * one. Nothing else about the model changes: the members keep their ids and
 * ports, the edges keep their endpoints, and a scope of any other kind that
 * is not a control branch still creates nothing — the root scope every
 * producer emits must not become a frame around the whole graph.
 */
import { describe, expect, it } from 'vitest';
import { WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import { GraphGModelSource, type PyGraphDocument, type PyGraphScope } from '../src/model/graph-gmodel-source';

type Element = { id: string; type: string; args?: Record<string, unknown>; children?: Element[]; sourceId?: string; targetId?: string };

function node(name: string, scope = 'scope:root') {
    return {
        id: `node:${name}`,
        kind: 'actor',
        label: name,
        scope,
        ports: [
            { id: `port:node:${name}:in`, name: 'in', direction: 'in' as const },
            { id: `port:node:${name}:out`, name: 'out', direction: 'out' as const }
        ]
    };
}

function docWith(subgraphs: PyGraphScope[], scopes: Record<string, string> = {}): PyGraphDocument {
    return {
        version: '1',
        graph: {
            id: 'root',
            nodes: ['a', 'b', 'c'].map(name => node(name, scopes[name])),
            edges: [{ id: 'e', from: 'port:node:a:out', to: 'port:node:c:in', scope: 'scope:root' }],
            subgraphs
        }
    };
}

const transform = (doc: PyGraphDocument): Element[] =>
    new GraphGModelSource().transform(doc).graph.children as unknown as Element[];

const byId = (elements: Element[] | undefined, id: string): Element | undefined => elements?.find(e => e.id === id);
const groups = (elements: Element[]): Element[] => elements.filter(e => e.type === WorkflowDiagramTypes.NODE_GROUP);
/** A container's member nodes, without the boundary ports its crossing edges add. */
const members = (element: Element | undefined): string[] =>
    (element?.children ?? []).filter(c => c.type.startsWith('node')).map(c => c.id);

describe('a producer’s group scopes', () => {
    it('draws the members of a group inside a labelled container, and out of the root', () => {
        const root = transform(docWith([
            { id: 'scope:layer1', kind: 'group', label: 'Layer 1', nodes: ['node:a', 'node:b'] }
        ]));

        const group = byId(root, 'scope:scope:layer1');
        expect(group?.type).toBe(WorkflowDiagramTypes.NODE_GROUP);
        expect(group?.args?.[WorkflowDiagramMetadata.GROUP_LABEL]).toBe('Layer 1');
        expect(group?.args?.[WorkflowDiagramMetadata.STRUCTURE_KIND]).toBe('group');
        expect(members(group).sort()).toEqual(['a', 'b']);
        expect(byId(root, 'a')).toBeUndefined();
        expect(byId(root, 'b')).toBeUndefined();
        expect(byId(root, 'c')).toBeDefined();
    });

    it('takes a node that declares the scope as a member too, and labels a group by its id when it has no label', () => {
        const root = transform(docWith(
            [{ id: 'scope:domain', kind: 'group' }],
            { b: 'scope:domain' }
        ));

        const group = byId(root, 'scope:scope:domain');
        expect(group?.args?.[WorkflowDiagramMetadata.GROUP_LABEL]).toBe('domain');
        expect(members(group)).toEqual(['b']);
    });

    it('nests a group inside its parent group', () => {
        const root = transform(docWith([
            { id: 'scope:outer', kind: 'group', label: 'Outer', nodes: ['node:a'] },
            { id: 'scope:inner', kind: 'group', label: 'Inner', parent: 'scope:outer', nodes: ['node:c'] }
        ]));

        const outer = byId(root, 'scope:scope:outer');
        const inner = byId(outer?.children, 'scope:scope:inner');
        expect(groups(root).map(g => g.id)).toEqual(['scope:scope:outer']);
        expect(members(inner)).toEqual(['c']);
        expect(byId(root, 'c')).toBeUndefined();
    });

    it('keeps an edge between members of one group whole, and cuts one that leaves it at the frame', () => {
        const inside = transform(docWith([
            { id: 'scope:g', kind: 'group', nodes: ['node:a', 'node:c'] }
        ]));
        const whole = byId(inside, 'e');
        expect(whole?.sourceId).toBe('a_port_out');
        expect(whole?.targetId).toBe('c_port_in');

        const leaving = transform(docWith([
            { id: 'scope:g', kind: 'group', nodes: ['node:a'] }
        ]));
        const group = byId(leaving, 'scope:scope:g');
        const port = 'scope:scope:g::out::a_port_out';
        expect(group?.children?.find(c => c.id === port)?.type).toBe(WorkflowDiagramTypes.PORT_GROUP_BOUNDARY);
        // The edge keeps its id and runs from the frame; the piece inside joins the member to it.
        expect(byId(leaving, 'e')?.sourceId).toBe(port);
        expect(byId(leaving, 'e')?.targetId).toBe('c_port_in');
        const piece = byId(leaving, `${port}::piece`);
        expect(piece?.sourceId).toBe('a_port_out');
        expect(piece?.targetId).toBe(port);
    });

    it('creates nothing for a scope of another kind, the root scope included', () => {
        const root = transform(docWith([
            { id: 'scope:root', kind: 'network', nodes: ['node:a', 'node:b', 'node:c'] },
            { id: 'scope:misc', kind: 'region', nodes: ['node:a'] }
        ]));

        expect(groups(root)).toEqual([]);
        expect(['a', 'b', 'c'].every(id => byId(root, id))).toBe(true);
    });

    it('puts two groups that name each other as parent both at the root instead of losing them', () => {
        const root = transform(docWith([
            { id: 'scope:x', kind: 'group', parent: 'scope:y', nodes: ['node:a'] },
            { id: 'scope:y', kind: 'group', parent: 'scope:x', nodes: ['node:b'] }
        ]));

        expect(groups(root).map(g => g.id).sort()).toEqual(['scope:scope:x', 'scope:scope:y']);
    });

    it('claims a node once when two groups list it', () => {
        const root = transform(docWith([
            { id: 'scope:first', kind: 'group', nodes: ['node:a'] },
            { id: 'scope:second', kind: 'group', nodes: ['node:a'] }
        ]));

        const first = byId(root, 'scope:scope:first');
        const second = byId(root, 'scope:scope:second');
        expect(members(first)).toEqual(['a']);
        expect(members(second)).toEqual([]);
    });
});
