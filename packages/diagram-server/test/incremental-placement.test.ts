/**
 * A graph that grows (incremental-placement.ts): the nodes a step adds go
 * beside the nodes they are wired to, and nothing placed moves.
 */
import { describe, expect, it } from 'vitest';
import {
    INCREMENTAL_GAP_X,
    INCREMENTAL_GAP_Y,
    placeBesideNeighbours,
    routeCrosses,
    type FreshNode,
    type NodeLink,
    type PlacedNode
} from '../src/server/incremental-placement';
import { countCoincidentNodes, graphGrows, savedLayoutIsUsable } from '../src/server/source-model-storage';

const box = (id: string, x: number, y: number, width = 60, height = 40): PlacedNode => ({ id, x, y, width, height });
const fresh = (id: string, width = 60, height = 40): FreshNode => ({ id, width, height });
const link = (from: string, to: string, fromY = 20, toY = 20): NodeLink => ({ from, to, fromY, toY });

function overlaps(a: { x: number; y: number; width: number; height: number }, b: typeof a): boolean {
    return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

describe('incremental placement', () => {
    it('puts a driver in the column to the left and a load in the column to the right, the wire straight', () => {
        const placed = [box('reg', 400, 200)];
        const at = placeBesideNeighbours(placed, [fresh('drv'), fresh('load', 80, 30)], [
            link('drv', 'reg', 20, 10),
            link('reg', 'load', 30, 15)
        ]);
        // Left of reg by the gap, its output at the height of the pin it drives.
        expect(at.get('drv')).toEqual({ x: 400 - INCREMENTAL_GAP_X - 60, y: 200 + 10 - 20 });
        // Right of reg by the gap, its input at the height of the pin that drives it.
        expect(at.get('load')).toEqual({ x: 400 + 60 + INCREMENTAL_GAP_X, y: 200 + 30 - 15 });
        // What was placed is not in the answer: it does not move.
        expect(at.has('reg')).toBe(false);
    });

    it('slides along the column to the nearest free place, and never onto a node', () => {
        const placed = [box('reg', 400, 200), box('other', 270, 190)];
        const loads = ['a', 'b', 'c', 'd', 'e'].map(id => fresh(id));
        const at = placeBesideNeighbours(placed, [fresh('drv'), ...loads], [
            link('drv', 'reg'),
            ...loads.map(l => link('reg', l.id))
        ]);
        const all = [
            ...placed,
            ...[...at].map(([id, p]) => ({ id, ...p, width: 60, height: 40 }))
        ];
        for (let i = 0; i < all.length; i++) {
            for (let j = i + 1; j < all.length; j++) {
                expect(overlaps(all[i], all[j]), `${all[i].id} on ${all[j].id}`).toBe(false);
            }
        }
        // The loads share a column, one gap apart at least.
        const column = loads.map(l => at.get(l.id)!);
        expect(new Set(column.map(p => p.x))).toEqual(new Set([400 + 60 + INCREMENTAL_GAP_X]));
        const ys = column.map(p => p.y).sort((p, q) => p - q);
        for (let k = 1; k < ys.length; k++) {
            expect(ys[k] - ys[k - 1]).toBeGreaterThanOrEqual(40 + INCREMENTAL_GAP_Y);
        }
        // The driver's place was taken by `other`: it slid, staying in its column.
        expect(at.get('drv')!.x).toBe(400 - INCREMENTAL_GAP_X - 60);
        expect(at.get('drv')!.y).not.toBe(200);
    });

    it('takes the next column out rather than slide the length of a full one', () => {
        // The column right of `reg` is full for a thousand pixels either way.
        const wall = Array.from({ length: 41 }, (_, k) => box(`w${k}`, 530, -1000 + k * 50));
        const at = placeBesideNeighbours([box('reg', 400, 0), ...wall], [fresh('load')], [link('reg', 'load')]);
        // One column further, at the height of the wire: nearer than the top of the wall.
        expect(at.get('load')).toEqual({ x: 400 + 60 + INCREMENTAL_GAP_X + (60 + INCREMENTAL_GAP_X), y: 0 });
    });

    it('unrolls a chain a column at a time, each node beside the one before', () => {
        const at = placeBesideNeighbours([box('reg', 1000, 0)], [fresh('g1'), fresh('g2'), fresh('g3')], [
            link('g3', 'g2'), link('g2', 'g1'), link('g1', 'reg')
        ]);
        const xs = ['g1', 'g2', 'g3'].map(id => at.get(id)!.x);
        expect(xs).toEqual([1000 - 130, 1000 - 260, 1000 - 390]);
        expect(['g1', 'g2', 'g3'].map(id => at.get(id)!.y)).toEqual([0, 0, 0]);
    });

    it('keeps a pin’s fan-out in the order of the pins it hangs off', () => {
        // Two outputs of one node, the upper at y 10 and the lower at y 50.
        const at = placeBesideNeighbours([box('cell', 0, 0, 60, 60)], [fresh('low'), fresh('high')], [
            link('cell', 'low', 50, 20),
            link('cell', 'high', 10, 20)
        ]);
        expect(at.get('high')!.y).toBeLessThan(at.get('low')!.y);
    });

    it('parks what is wired to nothing placed under the diagram', () => {
        const at = placeBesideNeighbours([box('reg', 100, 100)], [fresh('lost'), fresh('lost2')], [link('lost', 'lost2')]);
        expect(at.get('lost')!.y).toBeGreaterThan(140);
        expect(at.get('lost2')!.y).toBeGreaterThan(140);
        expect(at.get('lost')!.x).not.toBe(at.get('lost2')!.x);
    });

    it('starts a piece wired to nothing placed from its hub, what drives it to its left and what it drives to its right', () => {
        // A cell picked from a list comes with the stubs of its pins: three that drive it, one it drives.
        const news = [fresh('in0', 34, 34), fresh('cell', 200, 100), fresh('in1', 34, 34), fresh('out', 34, 34), fresh('in2', 34, 34)];
        const links = [
            { from: 'in0', to: 'cell', fromY: 17, toY: 20 }, { from: 'in1', to: 'cell', fromY: 17, toY: 45 },
            { from: 'in2', to: 'cell', fromY: 17, toY: 70 }, { from: 'cell', to: 'out', fromY: 20, toY: 17 }
        ];
        const at = placeBesideNeighbours([box('reg', 100, 100)], news, links);
        const cell = at.get('cell')!;
        // Under the diagram, set in from its left edge by the room of what drives it.
        expect(cell.y).toBeGreaterThan(140);
        expect(cell.x).toBeGreaterThan(100);
        for (const input of ['in0', 'in1', 'in2']) {
            expect(at.get(input)!.x + 34).toBeLessThan(cell.x);
            expect(at.get(input)!.x).toBeGreaterThanOrEqual(100);
            // Clear of the diagram above it.
            expect(at.get(input)!.y).toBeGreaterThan(140);
        }
        expect(at.get('out')!.x).toBeGreaterThan(cell.x + 200);
        // The output's wire is straight; the inputs keep the order of the pins they drive.
        expect(at.get('out')!.y + 17).toBe(cell.y + 20);
        expect(at.get('in0')!.y).toBeLessThan(at.get('in1')!.y);
        expect(at.get('in1')!.y).toBeLessThan(at.get('in2')!.y);
        const all = [...news.map(n => ({ id: n.id, ...at.get(n.id)!, width: n.width, height: n.height })), box('reg', 100, 100)];
        for (const a of all) {
            for (const b of all) {
                expect(a === b || !overlaps(a, b), `${a.id} on ${b.id}`).toBe(true);
            }
        }
    });

    it('starts each piece of its own under what is there by then, and parks a node wired to nothing', () => {
        const news = [fresh('a'), fresh('a2'), fresh('b'), fresh('b2'), fresh('alone')];
        const at = placeBesideNeighbours([box('reg', 100, 100)], news, [link('a', 'a2'), link('b', 'b2')]);
        expect(at.get('a2')!.y).toBe(at.get('a')!.y);
        expect(at.get('b2')!.y).toBe(at.get('b')!.y);
        expect(at.get('b')!.y).toBeGreaterThan(at.get('a')!.y + 40);
        expect(at.get('alone')!.y).toBeGreaterThan(at.get('b')!.y + 40);
    });

    it('answers a thousand new nodes among a thousand placed without one landing on another', () => {
        const placed = Array.from({ length: 1000 }, (_, k) => box(`p${k}`, (k % 40) * 130, Math.floor(k / 40) * 60));
        const news = Array.from({ length: 1000 }, (_, k) => fresh(`n${k}`));
        const links = news.map((n, k) => (k % 2 ? link(n.id, `p${k}`) : link(`p${k}`, n.id)));
        const started = Date.now();
        const at = placeBesideNeighbours(placed, news, links);
        expect(Date.now() - started).toBeLessThan(5000);
        expect(at.size).toBe(1000);
        const all = [...placed, ...news.map(n => ({ id: n.id, ...at.get(n.id)!, width: 60, height: 40 }))];
        const cells = new Map<string, typeof all>();
        for (const b of all) {
            for (let cx = Math.floor(b.x / 200); cx <= Math.floor((b.x + b.width) / 200); cx++) {
                for (let cy = Math.floor(b.y / 200); cy <= Math.floor((b.y + b.height) / 200); cy++) {
                    const key = `${cx},${cy}`;
                    for (const other of cells.get(key) ?? []) {
                        expect(overlaps(b, other), `${b.id} on ${other.id}`).toBe(false);
                    }
                    cells.set(key, [...(cells.get(key) ?? []), b]);
                }
            }
        }
    });

    it('never puts a node on another, however many one pin gains: the columns go on until there is room', () => {
        // One pin, up to three thousand loads in one step: more than the columns near it hold.
        for (const [count, width, height] of [[1200, 60, 40], [3000, 60, 40], [700, 160, 90]] as const) {
            const placed = [box('clk', 0, 0)];
            const loads = Array.from({ length: count }, (_, k) => fresh(`l${k}`, width, height));
            const started = Date.now();
            const at = placeBesideNeighbours(placed, loads, loads.map(l => link('clk', l.id)));
            expect(Date.now() - started).toBeLessThan(8000);
            expect(at.size).toBe(count);
            // No two at one point (what a saved layout is thrown away for), and no two touching at all.
            expect(countCoincidentNodes(at.values())).toBe(0);
            const all = [...placed, ...loads.map(l => ({ id: l.id, ...at.get(l.id)!, width, height }))];
            const cells = new Map<string, typeof all>();
            let touching = 0;
            for (const b of all) {
                for (let cx = Math.floor(b.x / 400); cx <= Math.floor((b.x + b.width) / 400); cx++) {
                    for (let cy = Math.floor(b.y / 400); cy <= Math.floor((b.y + b.height) / 400); cy++) {
                        const key = `${cx},${cy}`;
                        const cell = cells.get(key) ?? [];
                        touching += cell.filter(other => other !== b && overlaps(b, other)).length;
                        cell.push(b);
                        cells.set(key, cell);
                    }
                }
            }
            expect(touching, `${count} loads of ${width}x${height}`).toBe(0);
            // All to the right of the pin that drives them.
            expect(Math.min(...[...at.values()].map(p => p.x))).toBe(60 + INCREMENTAL_GAP_X);
        }
    });

    it('finds a place for a node of no size among nodes with no gap between them', () => {
        const at = placeBesideNeighbours([box('a', 0, 0, 0, 0)], [fresh('b', 0, 0), fresh('c', 0, 0)], [link('a', 'b', 0, 0), link('a', 'c', 0, 0)], { gapX: 0, gapY: 0 });
        expect(at.size).toBe(2);
    });

    it('says which saved routes a new node sits on', () => {
        const route = [{ x: 0, y: 50 }, { x: 100, y: 50 }, { x: 100, y: 200 }];
        expect(routeCrosses(route, { x: 40, y: 30, width: 30, height: 40 })).toBe(true);   // on the horizontal run
        expect(routeCrosses(route, { x: 90, y: 100, width: 30, height: 40 })).toBe(true);  // on the vertical run
        expect(routeCrosses(route, { x: 40, y: 80, width: 30, height: 40 })).toBe(false);  // in the corner's elbow
        expect(routeCrosses([], { x: 0, y: 0, width: 10, height: 10 })).toBe(false);
    });
});

describe('a saved layout of a graph that grows', () => {
    it('is used when it places some of the nodes', () => {
        // Any other graph: one node without a place lays the whole diagram out again.
        expect(savedLayoutIsUsable(true, 1)).toBe(false);
        // One that grows: the placed stay, the rest are put beside them.
        expect(savedLayoutIsUsable(true, 12, 0, 30)).toBe(true);
        // But not one that places nothing, nor one with nodes on top of each other.
        expect(savedLayoutIsUsable(true, 12, 0, 0)).toBe(false);
        expect(savedLayoutIsUsable(true, 12, 2, 30)).toBe(false);
        expect(savedLayoutIsUsable(false, 12, 0, 30)).toBe(false);
    });

    it('is a graph whose producer says so', () => {
        expect(graphGrows({ graph: { meta: { incremental: true } } })).toBe(true);
        expect(graphGrows({ graph: { meta: { incremental: 'yes' } } })).toBe(false);
        expect(graphGrows({ graph: {} })).toBe(false);
        expect(graphGrows(undefined)).toBe(false);
    });
});
