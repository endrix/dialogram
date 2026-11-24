import { describe, expect, it } from 'vitest';
import { GEdge, GGraph, GModelElement, GNode, GPort } from '@eclipse-glsp/server';
import { edgeCrossings } from '../src/model/edge-crossings';

/** An element of `cls` with `props`, holding `children`. */
function el<T extends GModelElement>(cls: new () => T, props: Record<string, unknown>, children: GModelElement[] = []): T {
    const element = Object.assign(new cls(), props, { children });
    for (const child of children) {
        (child as { parent?: GModelElement }).parent = element;
    }
    return element;
}

/** A node at (x, y), 10 by 10, with one port in its middle named `<id>.p`. */
function node(id: string, x: number, y: number): GNode {
    return el(GNode, { id, position: { x, y }, size: { width: 10, height: 10 } }, [
        el(GPort, { id: `${id}.p`, position: { x: 4, y: 4 }, size: { width: 2, height: 2 } })
    ]);
}

function edge(id: string, from: string, to: string, routingPoints: Array<{ x: number; y: number }> = []): GEdge {
    return el(GEdge, { id, sourceId: `${from}.p`, targetId: `${to}.p`, routingPoints });
}

describe('edgeCrossings', () => {
    it('counts two straight edges that cross once', () => {
        const root = el(GGraph, { id: 'g' }, [
            node('a', 0, 0), node('b', 100, 100), node('c', 0, 100), node('d', 100, 0),
            edge('ab', 'a', 'b'), edge('cd', 'c', 'd')
        ]);
        expect(edgeCrossings(root)).toBe(1);
    });

    it('does not count edges that only meet at a port, or run apart', () => {
        const root = el(GGraph, { id: 'g' }, [
            node('a', 0, 0), node('b', 100, 0), node('c', 100, 100), node('d', 0, 100),
            edge('ab', 'a', 'b'), edge('ac', 'a', 'c'), edge('dc', 'd', 'c')
        ]);
        expect(edgeCrossings(root)).toBe(0);
    });

    it('follows the bend points, read from the element holding the edge', () => {
        // Inside a group at (50, 0): the bend (0, 100) is (50, 100) in the diagram,
        // so the edge from a goes down and across, under the edge from c to d.
        const group = el(GNode, { id: 'grp', position: { x: 50, y: 0 }, size: { width: 10, height: 10 } }, [
            edge('ab', 'a', 'b', [{ x: -45, y: 5 }, { x: -45, y: 100 }, { x: 55, y: 100 }])
        ]);
        const root = el(GGraph, { id: 'g' }, [
            node('a', 0, 0), node('b', 100, 0), node('c', 50, 50), node('d', 50, 150),
            edge('cd', 'c', 'd'), group
        ]);
        expect(edgeCrossings(root)).toBe(1);
    });

    it('skips an edge whose end is not in the model', () => {
        const root = el(GGraph, { id: 'g' }, [node('a', 0, 0), edge('ax', 'a', 'x')]);
        expect(edgeCrossings(root)).toBe(0);
    });
});
