/**
 * A group laid out in rows.
 *
 * A producer may put the members of a group in rows (`meta.row`, the first
 * row on top): the actions of a state by the order they are tried in, say.
 * The members of a row sit side by side in the order the producer gave them,
 * the rows one under another. These tests pin what the transform hands the
 * layout, then run the real ELK and check where the members end up.
 */
import { describe, expect, it } from 'vitest';
import ELK from 'elkjs/lib/elk.bundled.js';
import { GGraph, GNode } from '@eclipse-glsp/server';
import { DefaultElementFilter } from '@eclipse-glsp/layout-elk';
import { ToggleNodeOpenOperation, WorkflowDiagramMetadata } from '@dialogram/shared';
import { GraphGModelSource, type PyGraphDocument } from '../src/model/graph-gmodel-source';
import { openNodes } from '../src/model/open-nodes';
import { portBusStateOf } from '../src/model/port-bundles';
import { stableNodeIds } from '../src/model/stable-ids';
import { applyBoundaryFlowLayerConstraints } from '../src/operations/boundary-flow-layout';
import { WorkflowElkLayoutEngine } from '../src/server/elk-layout-engine';
import { WorkflowLayoutConfigurator } from '../src/server/layout-configurator';
import { convertToGModelRoot } from '../src/server/gmodel-convert';

type Element = { id: string; type: string; args?: Record<string, any>; layoutOptions?: Record<string, string>; children?: Element[] };

/** A member with one output, as an action that leads somewhere has. */
function member(name: string, scope: string, row?: unknown) {
    return {
        id: `node:${name}`,
        kind: 'actor',
        label: name,
        scope,
        ports: [{ id: `port:node:${name}:out`, name: 'out', direction: 'out' as const }],
        ...(row !== undefined ? { meta: { row } } : {})
    };
}

/** Group S: first (row 0), then left and right (row 1), then last (row 2); group T beside it, with no rows. */
function document(extra: ReturnType<typeof member>[] = []): PyGraphDocument {
    return {
        version: '1',
        graph: {
            id: 'root',
            nodes: [
                // Not in row order: the rows are the producer's word, not the order of the nodes.
                member('left', 'scope:S', 1),
                member('last', 'scope:S', 2),
                member('first', 'scope:S', 0),
                member('right', 'scope:S', 1),
                member('t1', 'scope:T'),
                member('t2', 'scope:T'),
                ...extra
            ] as any,
            edges: [
                { id: 'e:first->T', from: 'port:node:first:out', to: 'scope:T', scope: 'scope:root' },
                { id: 'e:left->T', from: 'port:node:left:out', to: 'scope:T', scope: 'scope:root' },
                { id: 'e:right->T', from: 'port:node:right:out', to: 'scope:T', scope: 'scope:root' },
                { id: 'e:last->S', from: 'port:node:last:out', to: 'scope:S', scope: 'scope:root' }
            ],
            subgraphs: [
                { id: 'scope:S', kind: 'group', label: 'S' },
                { id: 'scope:T', kind: 'group', label: 'T' }
            ]
        }
    };
}

const find = (elements: Element[] | undefined, id: string): Element | undefined => {
    for (const element of elements ?? []) {
        if (element.id === id) {
            return element;
        }
        const hit = find(element.children, id);
        if (hit) {
            return hit;
        }
    }
    return undefined;
};
const transform = (doc: PyGraphDocument): Element[] =>
    new GraphGModelSource().transform(doc).graph.children as unknown as Element[];

describe('a group whose members carry a row', () => {
    it('is laid out downward, each row a partition, and says so', () => {
        const root = transform(document());
        const group = find(root, 'scope:scope:S')!;
        expect(group.args?.[WorkflowDiagramMetadata.GROUP_ROWS]).toBe(true);
        expect(group.layoutOptions).toMatchObject({
            'elk.direction': 'DOWN',
            'elk.partitioning.activate': 'true',
            'elk.separateConnectedComponents': 'false',
            // Still a group: laid out on its own, under its header.
            'elk.hierarchyHandling': 'SEPARATE_CHILDREN'
        });
        for (const [name, row] of [['first', 0], ['left', 1], ['right', 1], ['last', 2]] as const) {
            const node = find(root, name)!;
            expect(node.args?.[WorkflowDiagramMetadata.GROUP_ROW], name).toBe(row);
            expect(node.layoutOptions?.['elk.partitioning.partition'], name).toBe(String(row));
        }
    });

    it('leaves a group with no rows as it was', () => {
        const root = transform(document());
        const group = find(root, 'scope:scope:T')!;
        expect(group.args?.[WorkflowDiagramMetadata.GROUP_ROWS]).toBeUndefined();
        expect(group.layoutOptions?.['elk.direction']).toBe('RIGHT');
        expect(group.layoutOptions?.['elk.partitioning.activate']).toBeUndefined();
        expect(find(root, 't1')!.layoutOptions?.['elk.partitioning.partition']).toBeUndefined();
    });

    it('puts a member with no row after the last row, and takes only a whole number from zero as a row', () => {
        const root = transform(document([
            member('none', 'scope:S'),
            member('negative', 'scope:S', -1),
            member('half', 'scope:S', 1.5),
            member('text', 'scope:S', '1'),
            // More rows than a layout can count: no row at all.
            member('absurd', 'scope:S', 3000000000)
        ]));
        for (const name of ['none', 'negative', 'half', 'text', 'absurd']) {
            const node = find(root, name)!;
            expect(node.args?.[WorkflowDiagramMetadata.GROUP_ROW], name).toBeUndefined();
            expect(node.layoutOptions?.['elk.partitioning.partition'], name).toBe('3');
        }
    });

    it('keeps the plain layout when two of its members have an edge between them', () => {
        // Rows are for members that relate only to the outside: an edge
        // between two of them would split a row, or run through the members
        // between its ends.
        const doc = document();
        doc.graph.edges.push({ id: 'e:left->right', from: 'port:node:left:out', to: 'port:node:right:in', scope: 'scope:root' } as any);
        (doc.graph.nodes.find(n => n.id === 'node:right') as any).ports.push({ id: 'port:node:right:in', name: 'in', direction: 'in' });
        const root = transform(doc);
        const group = find(root, 'scope:scope:S')!;
        expect(group.args?.[WorkflowDiagramMetadata.GROUP_ROWS]).toBeUndefined();
        expect(group.layoutOptions?.['elk.direction']).toBe('RIGHT');
        expect(group.layoutOptions?.['elk.partitioning.activate']).toBeUndefined();
        for (const name of ['first', 'left', 'right', 'last']) {
            expect(find(root, name)!.layoutOptions?.['elk.partitioning.partition'], name).toBeUndefined();
            // What the producer said stays on the member.
            expect(typeof find(root, name)!.args?.[WorkflowDiagramMetadata.GROUP_ROW], name).toBe('number');
        }
        // An edge from a member out of the group, or to the group itself, is no such edge: T's neighbour S above had four.
    });

    it('gives a group nested in it a row as it gives a node one: its own, or after the last', () => {
        const doc = document();
        doc.graph.nodes.push(member('in1', 'scope:N1') as any, member('in2', 'scope:N2') as any);
        doc.graph.subgraphs!.push(
            { id: 'scope:N1', kind: 'group', label: 'N1', parent: 'scope:S', row: 1 },
            { id: 'scope:N2', kind: 'group', label: 'N2', parent: 'scope:S' });
        const root = transform(doc);
        expect(find(root, 'scope:scope:S')!.args?.[WorkflowDiagramMetadata.GROUP_ROWS]).toBe(true);
        const nested = find(root, 'scope:scope:N1')!;
        expect(nested.args?.[WorkflowDiagramMetadata.GROUP_ROW]).toBe(1);
        expect(nested.layoutOptions?.['elk.partitioning.partition']).toBe('1');
        // Still a group of its own inside: laid out as groups are, not in rows.
        expect(nested.layoutOptions?.['elk.hierarchyHandling']).toBe('SEPARATE_CHILDREN');
        expect(nested.args?.[WorkflowDiagramMetadata.GROUP_ROWS]).toBeUndefined();
        expect(find(root, 'scope:scope:N2')!.layoutOptions?.['elk.partitioning.partition']).toBe('3');
    });

    it('keeps the row of a member opened in place on the frame it becomes', () => {
        const doc = document();
        const last = doc.graph.nodes.find(n => n.id === 'node:last') as any;
        last.meta = { row: 2, inner: { nodes: [{ id: 'node:last/cell', kind: 'actor', label: 'cell', ports: [] }], edges: [] } };
        const ids = stableNodeIds(doc.graph.nodes);
        const opened = openNodes(doc, portBusStateOf(new Map([['last', new Set([ToggleNodeOpenOperation.OPEN])]])), ids);
        const frame = opened.graph.subgraphs!.find(scope => scope.openNodeKey === 'last');
        expect(frame?.row).toBe(2);
        expect(frame?.parent).toBe('scope:S');
    });

    it('is not given a layer by the pass that pins sources and sinks, and neither is a node with no port', () => {
        const doc = document([{ id: 'node:bare', kind: 'actor', label: 'bare', scope: 'scope:T', ports: [] } as any]);
        const root = convertToGModelRoot(new GraphGModelSource().transform(doc) as any) as unknown as GGraph;
        const changed = applyBoundaryFlowLayerConstraints(root, new Set(), false);
        // t1 and t2 have an output only: sources, pinned as before.
        expect([...changed.keys()].sort()).toEqual(['t1', 't2']);
    });
});

// ── The layout ──────────────────────────────────────────────────────────────

function index(element: any, map = new Map<string, any>()): Map<string, any> {
    map.set(element.id, element);
    for (const child of element.children ?? []) {
        index(child, map);
    }
    return map;
}

async function laidOut(doc: PyGraphDocument): Promise<Map<string, any>> {
    const root = convertToGModelRoot(new GraphGModelSource().transform(doc) as any) as unknown as GGraph;
    const byId = index(root);
    const modelState: any = { root, index: { get: (id: string) => byId.get(id), findByClass: (id: string) => byId.get(id) } };
    // As on opening a diagram: sources and sinks are pinned first.
    applyBoundaryFlowLayerConstraints(root, new Set(), false);
    await new WorkflowElkLayoutEngine(
        () => new (ELK as any)({ algorithms: ['layered'] }),
        new DefaultElementFilter(),
        new WorkflowLayoutConfigurator(),
        modelState
    ).layout();
    return byId;
}

describe('the layout of a group in rows', () => {
    it('puts the members of a row side by side in the producer’s order, and the rows one under another', async () => {
        const byId = await laidOut(document());
        const at = (name: string): GNode => byId.get(name) as GNode;
        const bottom = (name: string): number => at(name).position.y + at(name).size.height;
        // One row: the same height on the page, left before right as the document has them.
        expect(Math.abs(at('left').position.y - at('right').position.y)).toBeLessThanOrEqual(1);
        expect(at('left').position.x + at('left').size.width).toBeLessThanOrEqual(at('right').position.x);
        // The rows in order, none overlapping the next.
        expect(bottom('first')).toBeLessThanOrEqual(at('left').position.y);
        expect(bottom('left')).toBeLessThanOrEqual(at('last').position.y);
        expect(bottom('right')).toBeLessThanOrEqual(at('last').position.y);
        // All inside the frame.
        const group = byId.get('scope:scope:S') as GNode;
        for (const name of ['first', 'left', 'right', 'last']) {
            expect(at(name).position.x, name).toBeGreaterThanOrEqual(0);
            expect(at(name).position.x + at(name).size.width, name).toBeLessThanOrEqual(group.size.width);
            expect(bottom(name), name).toBeLessThanOrEqual(group.size.height);
        }
    });

    it('keeps a row together when its members have nothing between them and nothing leaving', async () => {
        const doc = document();
        doc.graph.edges = [];
        const byId = await laidOut(doc);
        const at = (name: string): GNode => byId.get(name) as GNode;
        expect(Math.abs(at('left').position.y - at('right').position.y)).toBeLessThanOrEqual(1);
        expect(at('first').position.y).toBeLessThan(at('left').position.y);
        expect(at('left').position.y).toBeLessThan(at('last').position.y);
    });
});
