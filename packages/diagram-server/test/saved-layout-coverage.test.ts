import { describe, expect, it } from 'vitest';
import { countCoincidentNodes, savedLayoutIsUsable } from '../src/server/source-model-storage';

/**
 * When a saved layout may stand, and when the diagram must be laid out again.
 *
 * This one boolean decides for the whole graph, because a usable saved layout
 * suppresses the initial layout run entirely — not merely for the nodes the
 * saved file happens to name. That is what makes partial coverage dangerous
 * rather than merely incomplete: the nodes the file has never heard of are not
 * laid out either, so they keep the position they were born with, which is the
 * origin.
 *
 * The visible result is a diagram whose newer nodes sit on top of one another
 * in a corner with edges too short to see. Only the last one drawn shows, so it
 * reads as a diagram that lost most of its content, which sends anyone
 * debugging it toward the producer rather than toward the layout.
 *
 * The threshold used to be "places at least one node". These tests pin the
 * middle case that changed, and the two ends that did not.
 */
describe('savedLayoutIsUsable', () => {
    it('is false when there is no saved layout at all', () => {
        expect(savedLayoutIsUsable(false, 0)).toBe(false);
        expect(savedLayoutIsUsable(false, 7)).toBe(false);
    });

    it('is true when the saved layout places every node', () => {
        expect(savedLayoutIsUsable(true, 0)).toBe(true);
    });

    it('is false when the saved layout places only some of them', () => {
        // The case that changed, and the one that actually happens: a layout
        // written before the graph grew. One unplaced node is enough, because
        // that node has no position to fall back to.
        expect(savedLayoutIsUsable(true, 1)).toBe(false);
        expect(savedLayoutIsUsable(true, 2)).toBe(false);
    });

    it('is false when the saved layout matches nothing', () => {
        // Already handled before this change, and still handled: a file written
        // by a different runtime names nothing in this graph.
        expect(savedLayoutIsUsable(true, 9)).toBe(false);
    });

    it('is false when the layout stacks nodes on one another', () => {
        // Covering every node is not enough. A layout captured before its nodes
        // were placed names all of them and puts several at the same point, so
        // it passes coverage, suppresses the run, and is restored faithfully
        // every time — the diagram opens stacked forever, and only a layout by
        // hand ever fixes it.
        expect(savedLayoutIsUsable(true, 0, 1)).toBe(false);
        expect(savedLayoutIsUsable(true, 0, 0)).toBe(true);
    });
});

describe('countCoincidentNodes', () => {
    it('counts a node sharing a position with another', () => {
        expect(
            countCoincidentNodes([
                { x: 0, y: 0 },
                { x: 0, y: 0 },
                { x: 10, y: 4 }
            ])
        ).toBe(1);
    });

    it('is zero for a layout that placed everything apart', () => {
        expect(
            countCoincidentNodes([
                { x: 0, y: 0 },
                { x: 10, y: 0 },
                { x: 0, y: 10 }
            ])
        ).toBe(0);
    });

    it('is zero for nothing at all', () => {
        // No saved positions is a different case, already handled by the
        // coverage check, and must not be mistaken for a stacked layout.
        expect(countCoincidentNodes([])).toBe(0);
    });

    it('counts every extra at a shared point, not just the pair', () => {
        expect(
            countCoincidentNodes([
                { x: 5, y: 5 },
                { x: 5, y: 5 },
                { x: 5, y: 5 }
            ])
        ).toBe(2);
    });
});
