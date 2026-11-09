/**
 * A node that grows in place (a bus opened) pushes down the nodes stacked
 * under it. Moving them back is the toggle's (port-buses.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { makeRoom, type Box } from '../src/operations/make-room';

const box = (id: string, x: number, y: number, height = 60, width = 140): Box => ({ id, x, y, width, height });

describe('a node that grows', () => {
    it('pushes the column under it down by what it grew, each node keeping its gap', () => {
        // queue7 grows from 60 to 150; queue9 and queue5 are stacked under it, 50 apart.
        const moves = makeRoom([
            box('queue3', 0, 0),
            box('queue7', 0, 110, 150),
            box('queue9', 0, 220),
            box('queue5', 0, 330),
            box('instance48', 400, 110, 300)
        ], 'queue7', 60);
        expect(Object.fromEntries(moves)).toEqual({ queue9: 90, queue5: 90 });
    });

    it('pushes a node it would reach however far below it is, and leaves one it would not', () => {
        const near = makeRoom([box('a', 0, 0, 400), box('b', 0, 300), box('c', 0, 800)], 'a', 60);
        expect(Object.fromEntries(near)).toEqual({ b: 340 });
    });

    it('moves a node beside the column only when one it pushes would reach it', () => {
        const moves = makeRoom([
            box('a', 0, 0, 150),
            box('wide', 0, 110, 60, 400),     // under a, and wider
            box('right', 300, 200),           // under `wide` only
            box('apart', 600, 110)            // beside, under nothing that moves
        ], 'a', 60);
        expect(Object.fromEntries(moves)).toEqual({ wide: 90, right: 90 });
    });

    it('never moves nodes above it or in another column', () => {
        expect(makeRoom([box('above', 0, 0), box('a', 0, 110, 150), box('other', 400, 200)], 'a', 60).size).toBe(0);
    });
});

describe('a node that shrinks', () => {
    it('moves nothing: what a growth pushed cannot be read off the layout, so the toggle moves it back itself', () => {
        expect(makeRoom([box('a', 0, 0, 60), box('b', 0, 200)], 'a', 150).size).toBe(0);
    });

    it('nor does a node that kept its height', () => {
        expect(makeRoom([box('a', 0, 0), box('b', 0, 110)], 'a', 60).size).toBe(0);
    });
});
