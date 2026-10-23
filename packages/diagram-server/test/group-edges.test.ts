/**
 * Edges cut at group frames, and the layout that cutting makes possible.
 *
 * A group lays out on its own (`SEPARATE_CHILDREN`), so an edge that leaves or
 * enters one is cut where it crosses the frame, at a boundary port: one piece
 * per level, edges reaching the same member through the same frame sharing the
 * way in. These tests pin the cut on the model, then run the real ELK against
 * the real configurator and check that members end up inside their frames,
 * ports on the frame lines and every piece attached to its ports.
 */
import { describe, expect, it } from 'vitest';
import ELK from 'elkjs/lib/elk.bundled.js';
import { GEdge, GGraph, GNode, GPort } from '@eclipse-glsp/server';
import { DefaultElementFilter } from '@eclipse-glsp/layout-elk';
import { WorkflowDiagramConstants, WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import { GraphGModelSource, type PyGraphDocument, type PyGraphScope } from '../src/model/graph-gmodel-source';
import { splitEdgesAtGroups } from '../src/model/group-edges';
import { WorkflowElkLayoutEngine } from '../src/server/elk-layout-engine';
import { WorkflowLayoutConfigurator } from '../src/server/layout-configurator';
import { convertToGModelRoot } from '../src/server/gmodel-convert';

type Element = { id: string; type: string; args?: Record<string, any>; children?: Element[]; sourceId?: string; targetId?: string; cssClasses?: string[] };

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

function edge(from: string, to: string, role: string, label?: string) {
    return {
        id: `e:${from}->${to}:${role}`,
        from: `port:node:${from}:out`,
        to: `port:node:${to}:in`,
        scope: 'scope:root',
        meta: { role, ...(label ? { label } : {}) }
    };
}

/** Groups A (a1, a2) and B (b1), a root node x, and edges inside, across and into the groups. */
function document(extraEdges: ReturnType<typeof edge>[] = [], subgraphs?: PyGraphScope[]): PyGraphDocument {
    return {
        version: '1',
        graph: {
            id: 'root',
            nodes: ['a1', 'a2', 'b1', 'x'].map(name => node(name)),
            edges: [
                edge('a1', 'a2', 'depends-on'),
                edge('a1', 'b1', 'refines', 'refines'),
                edge('a2', 'b1', 'refines'),
                edge('x', 'a1', 'verifies'),
                ...extraEdges
            ],
            subgraphs: subgraphs ?? [
                { id: 'scope:A', kind: 'group', label: 'A', nodes: ['node:a1', 'node:a2'] },
                { id: 'scope:B', kind: 'group', label: 'B', nodes: ['node:b1'] }
            ]
        }
    };
}

const transform = (doc: PyGraphDocument): Element[] =>
    new GraphGModelSource().transform(doc).graph.children as unknown as Element[];

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
const edgesOf = (root: Element[]): Element[] => root.filter(e => e.type.startsWith('edge:'));
const portsOf = (group: Element | undefined): Element[] =>
    (group?.children ?? []).filter(c => c.type === WorkflowDiagramTypes.PORT_GROUP_BOUNDARY);

describe('cutting edges at group frames', () => {
    it('leaves an edge between members of one group whole', () => {
        const root = transform(document());
        const inside = find(root, 'e:a1->a2:depends-on');
        expect(inside?.sourceId).toBe('a1_port_out');
        expect(inside?.targetId).toBe('a2_port_in');
        expect(inside?.args?.[WorkflowDiagramMetadata.EDGE_SEGMENT]).toBeUndefined();
    });

    it('cuts an edge from one group to another into a piece in each group and the stretch between', () => {
        const root = transform(document());
        const out = 'scope:scope:A::out::a1_port_out';
        const into = 'scope:scope:B::in::b1_port_in';
        const middle = find(root, 'e:a1->b1:refines');
        expect(middle?.sourceId).toBe(out);
        expect(middle?.targetId).toBe(into);
        expect(middle?.args?.[WorkflowDiagramMetadata.EDGE_SEGMENT]).toBe('middle');
        expect(middle?.args?.[WorkflowDiagramMetadata.EDGES_OF]).toEqual(['e:a1->b1:refines']);
        // The caption stays on the stretch between, and only there.
        expect(middle?.args?.[WorkflowDiagramMetadata.EDGE_LABEL]).toBe('refines');
        const leaving = find(root, `${out}::piece`);
        expect([leaving?.sourceId, leaving?.targetId]).toEqual(['a1_port_out', out]);
        expect(leaving?.args?.[WorkflowDiagramMetadata.EDGE_SEGMENT]).toBe('source');
        expect(leaving?.args?.[WorkflowDiagramMetadata.EDGE_LABEL]).toBeUndefined();
        const entering = find(root, `${into}::piece`);
        expect([entering?.sourceId, entering?.targetId]).toEqual([into, 'b1_port_in']);
        expect(entering?.args?.[WorkflowDiagramMetadata.EDGE_SEGMENT]).toBe('target');
        // Every piece stays at the root, where every edge lives.
        for (const id of [middle!.id, leaving!.id, entering!.id]) {
            expect(root.some(e => e.id === id)).toBe(true);
        }
        // The ports sit on the frames, on the side the edges cross.
        expect(portsOf(find(root, 'scope:scope:A')).map(p => p.args?.[WorkflowDiagramMetadata.PORT_SIDE])).toContain('EAST');
        expect(find(root, into)?.args?.[WorkflowDiagramMetadata.PORT_SIDE]).toBe('WEST');
    });

    it('lets edges into the same member through the same frame share the way in', () => {
        const root = transform(document());
        const into = 'scope:scope:B::in::b1_port_in';
        // a1->b1 and a2->b1 both enter B for b1: one port, one piece inside, standing for both.
        expect(portsOf(find(root, 'scope:scope:B')).map(p => p.id)).toEqual([into]);
        const shared = find(root, `${into}::piece`);
        expect(shared?.args?.[WorkflowDiagramMetadata.EDGES_OF]).toEqual(['e:a1->b1:refines', 'e:a2->b1:refines']);
        // Both are refines: the role stays. The one-edge endpoints go.
        expect(shared?.args?.[WorkflowDiagramMetadata.EDGE_ROLE]).toBe('refines');
        expect(shared?.cssClasses).toContain('edge-role-refines');
        expect(shared?.args?.['wf:from']).toBeUndefined();
        // Each edge keeps its own stretch between the frames.
        expect(find(root, 'e:a2->b1:refines')?.targetId).toBe(into);
    });

    it('drops the role of a shared piece whose edges differ', () => {
        const root = transform(document([edge('x', 'b1', 'verifies')]));
        const shared = find(root, 'scope:scope:B::in::b1_port_in::piece');
        expect(shared?.args?.[WorkflowDiagramMetadata.EDGES_OF]).toHaveLength(3);
        expect(shared?.args?.[WorkflowDiagramMetadata.EDGE_ROLE]).toBeUndefined();
        expect((shared?.cssClasses ?? []).some(c => c.startsWith('edge-role-'))).toBe(false);
    });

    it('cuts an edge from the root into a group once, at that group', () => {
        const root = transform(document());
        const middle = find(root, 'e:x->a1:verifies');
        expect(middle?.sourceId).toBe('x_port_out');
        expect(middle?.targetId).toBe('scope:scope:A::in::a1_port_in');
    });

    it('cuts once per level across nested groups', () => {
        const nested: PyGraphScope[] = [
            { id: 'scope:outer', kind: 'group', nodes: [] },
            { id: 'scope:inner', kind: 'group', parent: 'scope:outer', nodes: ['node:a1'] }
        ];
        const root = transform(document([], nested));
        const innerPort = 'scope:scope:inner::out::a1_port_out';
        const outerPort = `scope:scope:outer::out::${innerPort}`;
        const middle = find(root, 'e:a1->b1:refines');
        expect(middle?.sourceId).toBe(outerPort);
        expect(find(root, `${innerPort}::piece`)?.sourceId).toBe('a1_port_out');
        const between = find(root, `${outerPort}::piece`);
        expect([between?.sourceId, between?.targetId]).toEqual([innerPort, outerPort]);
        // Leaving, a1's edges share one way out of the inner group; x's edge enters it by its own.
        expect(portsOf(find(root, 'scope:scope:inner')).map(p => p.id)).toEqual([innerPort, 'scope:scope:inner::in::a1_port_in']);
    });

    it('leaves a model without groups exactly as it was', () => {
        const children: any[] = [
            { id: 'n1', type: 'node:actor', children: [{ id: 'p1', type: 'port:output' }] },
            { id: 'n2', type: 'node:actor', children: [{ id: 'p2', type: 'port:input' }] },
            { id: 'e', type: 'edge:connection', sourceId: 'p1', targetId: 'p2', args: {} }
        ];
        const before = JSON.stringify(children);
        splitEdgesAtGroups(children);
        expect(JSON.stringify(children)).toBe(before);
    });
});

// ── The layout ──────────────────────────────────────────────────────────────

type Point = { x: number; y: number };

function index(element: any, map = new Map<string, any>()): Map<string, any> {
    map.set(element.id, element);
    for (const child of element.children ?? []) {
        index(child, map);
    }
    return map;
}

function absolute(element: any): Point {
    let x = 0;
    let y = 0;
    for (let current = element; current; current = current.parent) {
        x += current.position?.x ?? 0;
        y += current.position?.y ?? 0;
    }
    return { x, y };
}

async function laidOut(doc: PyGraphDocument): Promise<{ root: GGraph; byId: Map<string, any> }> {
    const root = convertToGModelRoot(new GraphGModelSource().transform(doc) as any) as unknown as GGraph;
    const byId = index(root);
    const modelState: any = { root, index: { get: (id: string) => byId.get(id), findByClass: (id: string) => byId.get(id) } };
    await new WorkflowElkLayoutEngine(
        () => new (ELK as any)({ algorithms: ['layered'] }),
        new DefaultElementFilter(),
        new WorkflowLayoutConfigurator(),
        modelState
    ).layout();
    return { root, byId };
}

describe('a group laid out on its own', () => {
    it('holds its members below its header, keeps its ports on its frame, and attaches every piece', async () => {
        const { root, byId } = await laidOut(document());
        const header = WorkflowDiagramConstants.GROUP_HEADER_HEIGHT_PX;
        const groups = [...byId.values()].filter(e => e instanceof GNode && e.type === WorkflowDiagramTypes.NODE_GROUP) as GNode[];
        expect(groups).toHaveLength(2);
        for (const group of groups) {
            const { width, height } = group.size;
            expect(width).toBeGreaterThan(0);
            for (const member of group.children.filter(c => c instanceof GNode && !(c instanceof GPort)) as GNode[]) {
                expect(member.position.x).toBeGreaterThanOrEqual(0);
                expect(member.position.y).toBeGreaterThanOrEqual(header);
                expect(member.position.x + member.size.width).toBeLessThanOrEqual(width);
                expect(member.position.y + member.size.height).toBeLessThanOrEqual(height);
            }
            for (const port of group.children.filter(c => c.type === WorkflowDiagramTypes.PORT_GROUP_BOUNDARY) as GPort[]) {
                const centre = { x: port.position.x + port.size.width / 2, y: port.position.y + port.size.height / 2 };
                const side = (port as any).args[WorkflowDiagramMetadata.PORT_SIDE];
                expect(Math.abs(centre.x - (side === 'WEST' ? 0 : width)), `${port.id} on the ${side} frame line`).toBeLessThanOrEqual(1);
                expect(centre.y).toBeGreaterThanOrEqual(header);
                expect(centre.y).toBeLessThanOrEqual(height);
            }
        }
        // The two groups do not overlap.
        const [g, h] = groups.map(group => ({ ...absolute(group), w: group.size.width, h: group.size.height }));
        const overlap = g.x < h.x + h.w && h.x < g.x + g.w && g.y < h.y + h.h && h.y < g.y + g.h;
        expect(overlap).toBe(false);
        // Each piece runs between its own two ports: its route starts and ends on them.
        for (const piece of root.children.filter(c => c instanceof GEdge) as GEdge[]) {
            const points = (piece as any).routingPoints as Point[] | undefined;
            expect(points && points.length >= 2, piece.id).toBe(true);
            for (const [end, portId] of [[points![0], piece.sourceId], [points![points!.length - 1], piece.targetId]] as const) {
                const port = byId.get(portId);
                const box = { ...absolute(port), w: port.size?.width ?? 0, h: port.size?.height ?? 0 };
                expect(end.x, `${piece.id} at ${portId}`).toBeGreaterThanOrEqual(box.x - 1);
                expect(end.x, `${piece.id} at ${portId}`).toBeLessThanOrEqual(box.x + box.w + 1);
                expect(Math.abs(end.y - (box.y + box.h / 2)), `${piece.id} at ${portId}`).toBeLessThanOrEqual(1);
            }
        }
    });
});
