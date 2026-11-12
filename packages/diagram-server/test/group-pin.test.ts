/**
 * A group pinned to the top.
 *
 * A producer may pin a group (`pin: 'top'`): what belongs to the whole
 * picture rather than to a place in its flow, as the variables of a state
 * machine do. Such a group is laid out apart and put in a band above the
 * rest; the rest is laid out as if it were not there. These tests pin what
 * the transform says, then run the real ELK and check where things end up.
 */
import { describe, expect, it } from 'vitest';
import ELK from 'elkjs/lib/elk.bundled.js';
import { GEdge, GGraph, GNode } from '@eclipse-glsp/server';
import { DefaultElementFilter } from '@eclipse-glsp/layout-elk';
import { WorkflowDiagramConstants, WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import { GraphGModelSource, type PyGraphDocument, type PyGraphScope } from '../src/model/graph-gmodel-source';
import { WorkflowElkLayoutEngine } from '../src/server/elk-layout-engine';
import { WorkflowLayoutConfigurator } from '../src/server/layout-configurator';
import { convertToGModelRoot } from '../src/server/gmodel-convert';

type Point = { x: number; y: number };

function node(name: string, scope = 'scope:root', row?: number) {
    return {
        id: `node:${name}`,
        kind: 'actor',
        label: name,
        scope,
        ports: [
            { id: `port:node:${name}:in`, name: 'in', direction: 'in' as const },
            { id: `port:node:${name}:out`, name: 'out', direction: 'out' as const }
        ],
        ...(row !== undefined ? { meta: { row } } : {})
    };
}
const edge = (from: string, to: string) => ({ id: `e:${from}->${to}`, from: `port:node:${from}:out`, to: `port:node:${to}:in`, scope: 'scope:root' });

/** a -> b -> c in the flow; legend (v1, v2 side by side) and notes (n1) are groups of their own. */
function document(scopes: PyGraphScope[], extraEdges: ReturnType<typeof edge>[] = []): PyGraphDocument {
    return {
        version: '1',
        graph: {
            id: 'root',
            nodes: [
                node('a'), node('b'), node('c'),
                node('v1', 'scope:legend', 0), node('v2', 'scope:legend', 0),
                node('n1', 'scope:notes')
            ] as any,
            edges: [edge('a', 'b'), edge('b', 'c'), ...extraEdges],
            subgraphs: scopes
        }
    };
}

const PINNED: PyGraphScope[] = [
    { id: 'scope:legend', kind: 'group', label: 'Legend', pin: 'top' },
    { id: 'scope:notes', kind: 'group', label: 'Notes', pin: 'top' }
];
const UNPINNED: PyGraphScope[] = PINNED.map(({ pin: _pin, ...scope }) => scope);

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

async function laidOut(doc: PyGraphDocument): Promise<Map<string, any>> {
    const root = convertToGModelRoot(new GraphGModelSource().transform(doc) as any) as unknown as GGraph;
    const byId = index(root);
    const modelState: any = { root, index: { get: (id: string) => byId.get(id), findByClass: (id: string) => byId.get(id) } };
    await new WorkflowElkLayoutEngine(
        () => new (ELK as any)({ algorithms: ['layered'] }),
        new DefaultElementFilter(),
        new WorkflowLayoutConfigurator(),
        modelState
    ).layout();
    return byId;
}

describe('a group pinned to the top', () => {
    it('is marked by the transform, and only for the pin the platform knows', () => {
        const children = new GraphGModelSource().transform(document([
            { id: 'scope:legend', kind: 'group', label: 'Legend', pin: 'top' },
            { id: 'scope:notes', kind: 'group', label: 'Notes', pin: 'elsewhere' }
        ])).graph.children as any[];
        const group = (id: string) => children.find(child => child.id === id);
        expect(group('scope:scope:legend').args[WorkflowDiagramMetadata.GROUP_PIN]).toBe('top');
        expect(group('scope:scope:notes').args[WorkflowDiagramMetadata.GROUP_PIN]).toBeUndefined();
    });

    it('sits in a band above the rest, the first on top, its left edge on the diagram’s', async () => {
        const byId = await laidOut(document(PINNED));
        const legend = byId.get('scope:scope:legend') as GNode;
        const notes = byId.get('scope:scope:notes') as GNode;
        const flow = ['a', 'b', 'c'].map(name => byId.get(name) as GNode);
        const top = Math.min(...flow.map(n => n.position.y));
        const left = Math.min(...flow.map(n => n.position.x));
        const gap = WorkflowDiagramConstants.GROUP_PIN_GAP_PX;
        // Notes, the second, is just above the flow; Legend, the first, above it.
        expect(notes.position.y + notes.size.height).toBe(top - gap);
        expect(legend.position.y + legend.size.height).toBe(notes.position.y - gap);
        expect(legend.position.x).toBe(left);
        expect(notes.position.x).toBe(left);
        // Laid out inside as any group: its members in their row, within the frame.
        const [v1, v2] = ['v1', 'v2'].map(name => byId.get(name) as GNode);
        expect(Math.abs(v1.position.y - v2.position.y)).toBeLessThanOrEqual(1);
        expect(v1.position.x + v1.size.width).toBeLessThanOrEqual(v2.position.x);
        expect(v2.position.x + v2.size.width).toBeLessThanOrEqual(legend.size.width);
        expect(v1.position.y).toBeGreaterThanOrEqual(WorkflowDiagramConstants.GROUP_HEADER_HEIGHT_PX);
    });

    it('leaves the rest laid out as if it were not there', async () => {
        const withPins = await laidOut(document(PINNED));
        const alone = await laidOut({
            version: '1',
            graph: { id: 'root', nodes: [node('a'), node('b'), node('c')] as any, edges: [edge('a', 'b'), edge('b', 'c')], subgraphs: [] }
        });
        for (const name of ['a', 'b', 'c']) {
            expect(absolute(withPins.get(name)), name).toEqual(absolute(alone.get(name)));
        }
        // Not pinned, the same two groups are part of the flow and move it.
        const inFlow = await laidOut(document(UNPINNED));
        const moved = ['a', 'b', 'c'].some(name =>
            JSON.stringify(absolute(inFlow.get(name))) !== JSON.stringify(absolute(alone.get(name))));
        expect(moved).toBe(true);
    });

    it('stays in the flow when an edge crosses its frame: the edge needs it there', async () => {
        const byId = await laidOut(document(PINNED, [edge('c', 'v1')]));
        const legend = byId.get('scope:scope:legend') as GNode;
        const c = byId.get('c') as GNode;
        // To the right of c, where the edge leads, not above the diagram.
        expect(legend.position.x).toBeGreaterThan(c.position.x + c.size.width);
        // The other pinned group is still pinned, above everything in the flow.
        const notes = byId.get('scope:scope:notes') as GNode;
        const top = Math.min(...['a', 'b', 'c', 'scope:scope:legend'].map(id => (byId.get(id) as GNode).position.y));
        expect(notes.position.y + notes.size.height).toBe(top - WorkflowDiagramConstants.GROUP_PIN_GAP_PX);
    });

    it('takes the routes of the edges inside it along', async () => {
        const byId = await laidOut(document(PINNED, [edge('v1', 'v2')]));
        const inside = byId.get('e:v1->v2') as GEdge;
        const points = (inside as any).routingPoints as Point[];
        expect(points.length).toBeGreaterThanOrEqual(2);
        for (const [end, portId] of [[points[0], inside.sourceId], [points[points.length - 1], inside.targetId]] as const) {
            const port = byId.get(portId);
            const at = absolute(port);
            expect(end.x, portId).toBeGreaterThanOrEqual(at.x - 1);
            expect(end.x, portId).toBeLessThanOrEqual(at.x + (port.size?.width ?? 0) + 1);
            expect(Math.abs(end.y - (at.y + (port.size?.height ?? 0) / 2)), portId).toBeLessThanOrEqual(1);
        }
        expect(byId.get('scope:scope:legend').type).toBe(WorkflowDiagramTypes.NODE_GROUP);
    });
});
