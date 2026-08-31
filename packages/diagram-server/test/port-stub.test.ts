/**
 * The fan-out that keeps several edges on one port from kinking as they leave.
 *
 * Like the anchor arithmetic next door, this is shared because the client routes
 * live during a drag and the server routes on commit: if the two disagree the
 * edge jumps when the mouse is released. Both call this function, so these tests
 * pin the rule itself.
 *
 * What it produces is covered end-to-end against real captured geometry in
 * `libavoid-router.test.ts` ("leaves the first edge on a shared port straight").
 * Pinned here is the decision logic that would be awkward to provoke through the
 * solver: the ordering guarantee, the fan direction, and the fallback.
 */
import { describe, expect, it } from 'vitest';
import { portStubOffsets, portStubKey, type PortStubEndpoint } from '@dialogram/shared';

const OPTS = { portStub: 25, nudge: 8 };

/** An east-facing end at (400, y), heading towards `towardY`. */
const east = (
    id: string,
    y: number,
    towardY = y + 500,
    end: 'source' | 'target' = 'source'
): PortStubEndpoint => ({ id, end, x: 400, y, side: 'EAST', towardY });

describe('port stub fan-out', () => {
    it('leaves a port carrying a single edge alone', () => {
        const offsets = portStubOffsets([east('a', 100), east('b', 200)], [], OPTS);

        expect(offsets.size).toBe(0);
    });

    /**
     * The first edge is absent from the map on purpose: keeping the port's own
     * row is what makes it leave straight, and that is the whole point.
     */
    it('keeps the first edge on the port row and fans the rest off it', () => {
        const offsets = portStubOffsets([east('a', 100), east('b', 100), east('c', 100)], [], OPTS);

        expect(offsets.get(portStubKey('a', 'source'))).toBeUndefined();
        expect(offsets.get(portStubKey('b', 'source'))).toEqual({ distance: 33, across: 8 });
        expect(offsets.get(portStubKey('c', 'source'))).toEqual({ distance: 41, across: 16 });
    });

    /**
     * Both parts of that offset earn their place: `across` is what stops
     * libavoid splitting the difference and kinking BOTH edges, `distance` is
     * what stops the turns landing on one x and blurring into a blob.
     */
    it('fans towards where each edge is heading', () => {
        const up = portStubOffsets([east('a', 500, 900), east('b', 500, 100)], [], OPTS);

        expect(up.get(portStubKey('b', 'source'))?.across).toBe(-8);
    });

    /**
     * The order is arbitrary but must not depend on the order edges arrive in:
     * a drag re-routes continuously, and if the ranks reshuffled between frames
     * the edges would visibly swap places under the cursor.
     */
    it('assigns the same offsets whatever order the edges arrive in', () => {
        const forward = portStubOffsets([east('a', 100), east('b', 100), east('c', 100)], [], OPTS);
        const reversed = portStubOffsets([east('c', 100), east('b', 100), east('a', 100)], [], OPTS);

        expect([...reversed].sort()).toEqual([...forward].sort());
    });

    it('fans a west port back towards its own side', () => {
        const west = (id: string): PortStubEndpoint =>
            ({ id, end: 'source', x: 400, y: 100, side: 'WEST', towardY: 600 });
        const offsets = portStubOffsets([west('a'), west('b')], [], OPTS);

        // 400 - 33; the box sits where an EAST fan would have gone, and is
        // therefore irrelevant to a WEST one.
        expect(offsets.get(portStubKey('b', 'source'))).toEqual({ distance: 33, across: 8 });
    });

    it('gives up the fan when the start would land in a node', () => {
        const west = (id: string): PortStubEndpoint =>
            ({ id, end: 'source', x: 400, y: 100, side: 'WEST', towardY: 108 });
        // 400 - 33 = 367 with across +8 lands inside this box; the base start
        // (375, 100) does not.
        const offsets = portStubOffsets([west('a'), west('b')], [{ x: 360, y: 100, width: 12, height: 20 }], OPTS);

        expect(offsets.get(portStubKey('b', 'source'))).toBeUndefined();
    });

    it('treats the two ends of one edge independently', () => {
        // Two edges meeting at one INPUT port fan there too — the kink forms on
        // a shared port whichever end of the edges it is.
        const offsets = portStubOffsets(
            [east('a', 100, 600, 'target'), east('b', 100, 600, 'target'), east('a', 500), east('b', 900)],
            [],
            OPTS
        );

        expect(offsets.get(portStubKey('b', 'target'))?.across).toBe(8);
        expect(offsets.get(portStubKey('b', 'source'))).toBeUndefined();
    });

    it('does not group ports that merely share a coordinate on different sides', () => {
        const offsets = portStubOffsets(
            [east('a', 100), { id: 'b', end: 'source', x: 400, y: 100, side: 'WEST', towardY: 600 }],
            [],
            OPTS
        );

        expect(offsets.size).toBe(0);
    });
});
