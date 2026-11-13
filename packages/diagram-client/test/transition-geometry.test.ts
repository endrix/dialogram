/**
 * The shape of a transition, from where its states are, and where its labels go.
 *
 * Pure arithmetic: a pill's outline, the curve between two states (bowed
 * when the other way exists too), a loop turned to the widest gap, and the
 * placement of the blocks of labels of a whole automaton, which keeps them
 * off the states and off one another.
 */
import { describe, expect, it } from 'vitest';
import {
    boxesCrossed,
    curveAt,
    labelBlockAt,
    labelCandidates,
    leaveState,
    loopDirection,
    overlapArea,
    placeLabelBlocks,
    transitionAround,
    transitionBetween,
    transitionLoop,
    transitionStub,
    type Box
} from '../src/transition-geometry';
import { initialMarkDirection } from '../src/automaton-views';

const pill = (x: number, y: number, width = 100, height = 36): Box => ({ x, y, width, height });
const close = (a: number, b: number): boolean => Math.abs(a - b) < 0.01;

describe('a pill and a ray from its centre', () => {
    const state = pill(0, 0);

    it('leaves through a flat side when it goes up or down', () => {
        expect(leaveState(state, { x: 50, y: -100 })).toEqual({ x: 50, y: 0 });
        expect(leaveState(state, { x: 50, y: 200 })).toEqual({ x: 50, y: 36 });
    });

    it('leaves through a round end when it goes sideways, `gap` further out', () => {
        expect(leaveState(state, { x: 500, y: 18 })).toEqual({ x: 100, y: 18 });
        const out = leaveState(state, { x: -500, y: 18 }, 5);
        expect(close(out.x, -5) && close(out.y, 18)).toBe(true);
    });
});

describe('a state that lists the steps of a run', () => {
    // A box with the corners of a state's pill, much taller than wide.
    const box: Box = { x: 0, y: 0, width: 100, height: 200, radius: 18 };

    it('is left through its flat sides, not as a pill of its own height would be', () => {
        const right = leaveState(box, { x: 500, y: 100 });
        expect(close(right.x, 100) && close(right.y, 100)).toBe(true);
        const down = leaveState(box, { x: 50, y: 900 });
        expect(close(down.x, 50) && close(down.y, 200)).toBe(true);
    });

    it('is left through a round corner on a slant', () => {
        // Towards the bottom right corner: on the arc, inside the square corner.
        const out = leaveState(box, { x: 1000, y: 1000 * 2 + 0.0001 });
        expect(out.x).toBeLessThan(100);
        expect(out.y).toBeLessThan(200);
        expect(Math.hypot(out.x - 82, out.y - 182)).toBeCloseTo(18, 3);
    });
});

describe('a transition between two states', () => {
    const a = pill(0, 0);
    const b = pill(300, 0);

    it('is straight when it is the only way between them, with its arrow at the target', () => {
        const shape = transitionBetween(a, b, false);
        const [start, control, end] = shape.controls;
        expect(start.y).toBe(18);
        expect(control.y).toBe(18);
        expect(end.x).toBeLessThan(300);
        expect(shape.tip).toEqual(end);
        expect(close(shape.angle, 0)).toBe(true);
    });

    it('bows to its right when the other way exists too, so the two never lie on each other', () => {
        const there = transitionBetween(a, b, true);
        const back = transitionBetween(b, a, true);
        // Going east, its right is south (y grows downwards); coming back, north.
        expect(curveAt(there.controls, 0.5).y).toBeGreaterThan(18);
        expect(curveAt(back.controls, 0.5).y).toBeLessThan(18);
    });
});

describe('a loop', () => {
    it('turns to the widest gap between the ways its state leaves in, up when there is none', () => {
        expect(loopDirection({ x: 0, y: 0 }, [])).toEqual({ x: 0, y: -1 });
        // Transitions east and south: the widest gap is the quarter from west round to north... and on to east.
        const away = loopDirection({ x: 0, y: 0 }, [{ x: 100, y: 0 }, { x: 0, y: 100 }]);
        expect(away.x).toBeLessThan(0);
        expect(away.y).toBeLessThan(0);
    });

    it('starts and ends on its state and reaches out the way it is turned', () => {
        const state = pill(0, 0);
        const shape = transitionLoop(state, { x: 0, y: -1 });
        const [start, , , end] = shape.controls;
        expect(start.y).toBeLessThanOrEqual(0);
        expect(end.y).toBeLessThanOrEqual(0);
        expect(shape.anchor.y).toBeLessThan(-20);
        expect(shape.box.y).toBeLessThan(-20);
    });
});

describe('a stub', () => {
    it('leaves its state the way it is sent, a short arrow, with the name of where it goes at its end', () => {
        const stub = transitionStub(pill(0, 0), { x: 50, y: -500 }, 40, 18, 30);
        const [start, , end] = stub.controls;
        expect(close(start.x, 50) && close(start.y, -1)).toBe(true);
        expect(close(end.y, -31)).toBe(true);
        expect(stub.tip).toEqual(end);
        // The chip is past the tip, centred on the way.
        expect(stub.chip.y + stub.chip.height).toBeLessThan(end.y);
        expect(close(stub.chip.x + stub.chip.width / 2, 50)).toBe(true);
    });
});

describe('a transition with a state in its way', () => {
    const a = pill(0, 0);
    const b = pill(600, 0);
    const between = pill(250, 0);

    it('goes round it, and stays straight when nothing is in the way', () => {
        expect(boxesCrossed(transitionBetween(a, b, false).controls, [between])).toBe(1);
        const round = transitionAround(a, b, false, [between]);
        expect(boxesCrossed(round.controls, [between])).toBe(0);
        expect(transitionAround(a, b, false, [pill(250, 300)])).toEqual(transitionBetween(a, b, false));
    });

    it('goes round to its right only when it is one of two ways, so the two stay apart', () => {
        const round = transitionAround(a, b, true, [between]);
        // Going east, its right is south.
        expect(curveAt(round.controls, 0.5).y).toBeGreaterThan(18);
    });
});

describe('where the labels go', () => {
    it('tries a straight curve on both sides, and a bowed one on its right only', () => {
        const straight = labelCandidates(transitionBetween(pill(0, 0), pill(300, 0), false), false, false);
        const bowed = labelCandidates(transitionBetween(pill(0, 0), pill(300, 0), true), false, true);
        expect(straight.length).toBe(2 * bowed.length);
        // Half way along first.
        const middle = curveAt(transitionBetween(pill(0, 0), pill(300, 0), false).controls, 0.5);
        expect(straight[0].at).toEqual(middle);
        expect(bowed.every(candidate => candidate.side.y > 0)).toBe(true);
    });

    it('sets a block beside its place, clear of the curve', () => {
        const block = labelBlockAt({ at: { x: 100, y: 100 }, side: { x: 0, y: 1 } }, 60, 18);
        expect(block.y).toBeGreaterThan(100);
        expect(block.x + block.width / 2).toBe(100);
    });

    it('keeps a block off a state that lies where it would go first', () => {
        const shape = transitionBetween(pill(0, 0), pill(300, 0), false);
        const candidates = labelCandidates(shape, false, false);
        const first = labelBlockAt(candidates[0], 60, 18);
        // A state right where the first place is.
        const inTheWay = { x: first.x - 5, y: first.y - 5, width: first.width + 10, height: first.height + 10 };
        const [placed] = placeLabelBlocks([{ candidates, width: 60, height: 18 }], [inTheWay], [shape.controls]);
        expect(overlapArea(placed, inTheWay)).toBe(0);
    });

    it('keeps two blocks that would go to one place apart, the one that can go nowhere else first', () => {
        const shape = transitionBetween(pill(0, 0), pill(300, 0), false);
        const candidates = labelCandidates(shape, false, false);
        // A block that has only the first place, as a loop's has only one.
        const fixed = { candidates: [candidates[0]], width: 60, height: 18 };
        const free = { candidates, width: 60, height: 18 };
        const [movable, pinned] = placeLabelBlocks([free, fixed], [], [shape.controls, shape.controls]);
        expect(pinned).toEqual(labelBlockAt(candidates[0], 60, 18));
        expect(overlapArea(movable, pinned)).toBe(0);
    });

    it('places the same way every time', () => {
        // Three blocks on one short line: there is no place free for all,
        // and the one that covers least is taken, each time the same.
        const shape = transitionBetween(pill(0, 0), pill(300, 40), false);
        const blocks = [0, 1, 2].map(() => ({ candidates: labelCandidates(shape, false, false), width: 50, height: 18 }));
        const once = placeLabelBlocks(blocks, [pill(0, 0), pill(300, 40)], blocks.map(() => shape.controls));
        expect(placeLabelBlocks(blocks, [pill(0, 0), pill(300, 40)], blocks.map(() => shape.controls))).toEqual(once);
        expect(overlapArea(once[0], once[1])).toBe(0);
    });
});

describe('the initial mark', () => {
    it('comes from the west when nothing is in the way, as a statechart draws it', () => {
        const from = initialMarkDirection({ x: 0, y: 0 }, [], undefined);
        expect(close(from.x, -1) && close(from.y, 0)).toBe(true);
    });

    it('comes from where the state has the most room', () => {
        // Transitions west and east, a loop up: the mark comes from below.
        const from = initialMarkDirection({ x: 0, y: 0 }, [{ x: -100, y: 0 }, { x: 100, y: 0 }], { x: 0, y: -1 });
        expect(close(from.x, 0) && close(from.y, 1)).toBe(true);
    });
});
