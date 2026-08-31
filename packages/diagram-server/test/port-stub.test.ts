/**
 * The stagger that keeps several edges on one port from turning at the same x.
 *
 * Like the anchor arithmetic next door, this is shared because the client routes
 * live during a drag and the server routes on commit: if the two disagree the
 * edge jumps when the mouse is released. Both call this function, so these tests
 * pin the rule itself.
 *
 * The behaviour it exists for is covered end-to-end against real captured
 * geometry in `libavoid-router.test.ts` ("does not turn two edges off one port
 * at the same x"). What is pinned here is the decision logic that would be
 * awkward to provoke through the solver: the ordering guarantee, the fallback,
 * and the fact that a port with one edge is left completely alone.
 */
import { describe, expect, it } from 'vitest';
import { portStubDistances, portStubKey, type PortStubEndpoint } from '@dialogram/shared';

const OPTS = { portStub: 25, nudge: 8 };
const east = (id: string, y: number, end: 'source' | 'target' = 'source'): PortStubEndpoint =>
    ({ id, end, x: 400, y, side: 'EAST' });

describe('port stub stagger', () => {
    it('leaves a port carrying a single edge alone', () => {
        const stubs = portStubDistances([east('a', 100), east('b', 200)], [], OPTS);

        expect(stubs.size).toBe(0);
    });

    it('pushes each extra edge on a port one nudge further out', () => {
        const stubs = portStubDistances([east('a', 100), east('b', 100), east('c', 100)], [], OPTS);

        // The first edge keeps the base distance and is absent from the map.
        expect(stubs.get(portStubKey('a', 'source'))).toBeUndefined();
        expect(stubs.get(portStubKey('b', 'source'))).toBe(33);
        expect(stubs.get(portStubKey('c', 'source'))).toBe(41);
    });

    /**
     * The ordering is arbitrary but must not depend on the order edges arrive
     * in: a drag re-routes continuously, and if the ranks reshuffled between
     * frames the edges would visibly swap places under the cursor.
     */
    it('assigns the same distances whatever order the edges arrive in', () => {
        const forward = portStubDistances([east('a', 100), east('b', 100), east('c', 100)], [], OPTS);
        const reversed = portStubDistances([east('c', 100), east('b', 100), east('a', 100)], [], OPTS);

        expect([...reversed.entries()].sort()).toEqual([...forward.entries()].sort());
    });

    it('staggers a west port back towards its own side', () => {
        const west = (id: string): PortStubEndpoint => ({ id, end: 'source', x: 400, y: 100, side: 'WEST' });
        // A box just left of the port: the staggered start must clear it, and it
        // does, because a WEST stub goes further LEFT rather than further right.
        const stubs = portStubDistances([west('a'), west('b')], [{ x: 300, y: 90, width: 20, height: 20 }], OPTS);

        expect(stubs.get(portStubKey('b', 'source'))).toBe(33);
    });

    it('keeps the base distance when the staggered start would land in a node', () => {
        // 400 - 33 = 367 sits inside this box; 400 - 25 = 375 does not.
        const west = (id: string): PortStubEndpoint => ({ id, end: 'source', x: 400, y: 100, side: 'WEST' });
        const stubs = portStubDistances([west('a'), west('b')], [{ x: 360, y: 90, width: 12, height: 20 }], OPTS);

        expect(stubs.get(portStubKey('b', 'source'))).toBeUndefined();
    });

    it('treats the two ends of one edge independently', () => {
        // Two edges meeting at one INPUT port stagger there too — the blob forms
        // on a shared port whichever end of the edges it is.
        const stubs = portStubDistances(
            [east('a', 100, 'target'), east('b', 100, 'target'), east('a', 500), east('b', 900)],
            [],
            OPTS
        );

        expect(stubs.get(portStubKey('b', 'target'))).toBe(33);
        expect(stubs.get(portStubKey('b', 'source'))).toBeUndefined();
    });

    it('does not group ports that merely share a coordinate on different sides', () => {
        const stubs = portStubDistances(
            [east('a', 100), { id: 'b', end: 'source', x: 400, y: 100, side: 'WEST' }],
            [],
            OPTS
        );

        expect(stubs.size).toBe(0);
    });
});
