/**
 * A node that grows in place (a bus opened) pushes down the nodes stacked
 * under it, and pulls them back up when it shrinks.
 */
import { describe, expect, it } from 'vitest';
import { makeRoom, MIN_GAP_PX, type Box } from '../src/operations/make-room';

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
    it('pulls the column back up by what it shrank, so a toggle and its undo leave the layout as it was', () => {
        const grown = [box('queue7', 0, 110, 150), box('queue9', 0, 310), box('queue5', 0, 420)];
        expect(Object.fromEntries(makeRoom(grown, 'queue7', 60).entries())).toEqual({});
        const shrunk = [box('queue7', 0, 110, 60), box('queue9', 0, 310), box('queue5', 0, 420)];
        expect(Object.fromEntries(makeRoom(shrunk, 'queue7', 150))).toEqual({ queue9: -90, queue5: -90 });
    });

    it('pulls up only as far as a node above the column, outside it, allows', () => {
        const moves = makeRoom([
            box('a', 0, 0, 60),
            box('b', 0, 200, 60, 400),          // stacked under a, wide
            box('blocker', 300, 0, 160)         // above b's right half, bottom at 160
        ], 'a', 150);
        // Without the blocker b would rise 90; it may rise to 20 under the blocker's bottom.
        expect(moves.get('b')).toBe(-(200 - 160 - MIN_GAP_PX));
    });

    it('moves nothing when the height did not change', () => {
        expect(makeRoom([box('a', 0, 0), box('b', 0, 110)], 'a', 60).size).toBe(0);
    });
});
