/**
 * A wire across a frame, from one of its pins to another: a branch that
 * assigns a net as it is (`count <= load`) draws its input wired straight to
 * its output.
 *
 * ELK takes an edge between two ports of one node for a self-loop and routes
 * it around the node, outside the frame it crosses. It is laid out as two
 * edges through a point inside the frame, and joined back after. These pin
 * the split and the join, then run the real ELK.
 */
import { describe, expect, it } from 'vitest';
import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkExtendedEdge, ElkNode } from 'elkjs';
import { joinPinToPinEdges, splitPinToPinEdges } from '../src/server/pin-to-pin-edges';

const port = (id: string, side: 'WEST' | 'EAST') => ({ id, width: 7, height: 7, layoutOptions: { 'elk.port.side': side } });

/**
 * A graph holding a frame `F`: pins `in` (west) and `out` (east), a member
 * `m` between them, wired `in -> m -> ...`; and `in` wired straight to `out`.
 */
function graph(): ElkNode {
    return {
        id: 'root',
        layoutOptions: { 'elk.algorithm': 'layered', 'elk.direction': 'RIGHT', 'elk.hierarchyHandling': 'SEPARATE_CHILDREN' },
        children: [{
            id: 'F',
            layoutOptions: { 'elk.algorithm': 'layered', 'elk.direction': 'RIGHT', 'elk.portConstraints': 'FIXED_SIDE', 'elk.padding': '[top=30,left=20,bottom=10,right=20]' },
            ports: [port('F:in', 'WEST'), port('F:other', 'WEST'), port('F:out', 'EAST'), port('F:m', 'EAST')],
            children: [{ id: 'm', width: 60, height: 40, ports: [port('m:a', 'WEST'), port('m:y', 'EAST')] }],
            edges: [
                { id: 'into-m', sources: ['F:other'], targets: ['m:a'] },
                { id: 'out-of-m', sources: ['m:y'], targets: ['F:m'] },
                { id: 'across', sources: ['F:in'], targets: ['F:out'] }
            ]
        }],
        edges: []
    };
}

describe('a wire across a frame', () => {
    it('is laid out as two through a point inside the frame', () => {
        const g = graph();
        const splits = splitPinToPinEdges(g);
        const frame = g.children![0];
        expect(splits.map(s => s.edge.id)).toEqual(['across']);
        expect(frame.children!.map(c => c.id)).toEqual(['m', 'across::via']);
        expect(frame.edges!.map(e => [e.id, e.sources[0], e.targets[0]])).toEqual([
            ['into-m', 'F:other', 'm:a'],
            ['out-of-m', 'm:y', 'F:m'],
            ['across::into', 'F:in', 'across::via'],
            ['across::outOf', 'across::via', 'F:out']
        ]);
    });

    it('leaves a feedback wire alone, from a node’s output back to its input, and one on a node with no children', () => {
        const g: ElkNode = {
            id: 'root',
            children: [
                { id: 'n', width: 60, height: 40, ports: [port('n:in', 'WEST'), port('n:out', 'EAST')], edges: [{ id: 'back', sources: ['n:out'], targets: ['n:in'] }] },
                { id: 'leaf', width: 60, height: 40, ports: [port('leaf:in', 'WEST'), port('leaf:out', 'EAST')], edges: [{ id: 'on', sources: ['leaf:in'], targets: ['leaf:out'] }] },
                { id: 'F', children: [], ports: [port('F:out', 'EAST'), port('F:in', 'WEST')], edges: [{ id: 'around', sources: ['F:out'], targets: ['F:in'] }] }
            ]
        };
        expect(splitPinToPinEdges(g)).toEqual([]);
        expect(g.children!.map(c => (c.edges ?? []).map(e => e.id))).toEqual([['back'], ['on'], ['around']]);
        expect(g.children!.map(c => (c.children ?? []).length)).toEqual([0, 0, 0]);
    });

    it('is routed inside the frame by ELK, and joined back into the one edge', async () => {
        const g = graph();
        const splits = splitPinToPinEdges(g);
        const result = await new (ELK as any)({ algorithms: ['layered'] }).layout(g) as ElkNode;
        joinPinToPinEdges(result, splits);
        const frame = result.children![0];
        expect(frame.children!.map(c => c.id)).toEqual(['m']);
        const across = frame.edges!.find(e => e.id === 'across') as ElkExtendedEdge;
        expect(frame.edges!.map(e => e.id).sort()).toEqual(['across', 'into-m', 'out-of-m']);
        expect(across.sources).toEqual(['F:in']);
        expect(across.targets).toEqual(['F:out']);
        const section = across.sections![0];
        const points = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint];
        // From the pin it leaves to the pin it reaches, every point inside the frame (in its coordinates).
        const pin = (id: string) => frame.ports!.find(p => p.id === id)!;
        expect(section.startPoint.x).toBeCloseTo(pin('F:in').x! + pin('F:in').width!, 0);
        expect(section.endPoint.x).toBeCloseTo(pin('F:out').x!, 0);
        for (const point of points) {
            expect(point.x).toBeGreaterThanOrEqual(0);
            expect(point.x).toBeLessThanOrEqual(frame.width!);
            expect(point.y).toBeGreaterThanOrEqual(0);
            expect(point.y).toBeLessThanOrEqual(frame.height!);
        }
        // Each segment straight across or down: the halves meet on one line.
        for (let k = 1; k < points.length; k++) {
            expect(points[k].x === points[k - 1].x || points[k].y === points[k - 1].y, `segment ${k}`).toBe(true);
        }
    });

    it('is routed around the frame by ELK when not split: the case this is for', async () => {
        const result = await new (ELK as any)({ algorithms: ['layered'] }).layout(graph()) as ElkNode;
        const frame = result.children![0];
        const section = frame.edges!.find(e => e.id === 'across')!.sections![0];
        const points = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint];
        // A self-loop, in the coordinates of what holds the frame: some point is out of its box.
        const outside = points.some(p => p.x < frame.x! || p.x > frame.x! + frame.width! || p.y < frame.y! || p.y > frame.y! + frame.height!);
        expect(outside).toBe(true);
    });
});
