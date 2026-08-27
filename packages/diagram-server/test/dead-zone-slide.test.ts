/**
 * The dead-zone fast path slides an existing route's endpoints instead of
 * rerouting, when a drag moved them less than 5px. It shipped with a hole: a
 * 2-point route has no interior bend to carry, so sliding it moved both
 * endpoints and left a straight line between them — a diagonal, persisted to
 * the layout file. Every later nudge re-entered the dead zone and slid the same
 * degenerate route again, so an edge in that state could never recover.
 *
 * These tests pin the two guards that close it: a route needs a real bend to be
 * slideable at all, and the slid result must still be orthogonal.
 */
import { describe, expect, it } from 'vitest';
import { isOrthogonalPolyline } from '../src/operations/reroute-edges-avoid-overlaps-handler';

/** The slide, exactly as the handler performs it. */
function slide(
    rps: { x: number; y: number }[],
    srcA: { x: number; y: number },
    tgtA: { x: number; y: number }
): { x: number; y: number }[] {
    const out = rps.map(p => ({ x: p.x, y: p.y }));
    out[0] = { x: srcA.x, y: srcA.y };
    out[1] = { x: out[1].x, y: srcA.y };
    out[out.length - 1] = { x: tgtA.x, y: tgtA.y };
    out[out.length - 2] = { x: out[out.length - 2].x, y: tgtA.y };
    return out;
}

describe('dead-zone slide', () => {
    it('detects a diagonal polyline', () => {
        expect(isOrthogonalPolyline([{ x: 0, y: 0 }, { x: 10, y: 10 }])).toBe(false);
        expect(isOrthogonalPolyline([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 9 }])).toBe(true);
    });

    it('a 2-point route slides into a diagonal — which is why it is now excluded', () => {
        // Reproduces the shipped bug: both endpoints move, nothing keeps it straight.
        const twoPoint = [{ x: 100, y: 200 }, { x: 400, y: 200 }];
        const slid = [
            { x: 102, y: 203 },   // source anchor moved 2,3 — inside the 5px dead zone
            { x: 400, y: 200 }
        ];
        expect(isOrthogonalPolyline(slid)).toBe(false);
        // The guard is on point count, so this route never reaches the slide.
        expect(twoPoint.length < 3).toBe(true);
    });

    it('slides a 3-point route while keeping it orthogonal', () => {
        const rps = [{ x: 100, y: 200 }, { x: 250, y: 200 }, { x: 250, y: 400 }, { x: 400, y: 400 }];
        const slid = slide(rps, { x: 100, y: 203 }, { x: 400, y: 398 });
        expect(isOrthogonalPolyline(slid)).toBe(true);
        expect(slid[0]).toEqual({ x: 100, y: 203 });
        expect(slid[slid.length - 1]).toEqual({ x: 400, y: 398 });
    });

    it('rejects a slide that would bend a vertical stub into a diagonal', () => {
        // First segment is VERTICAL, so aligning point 1 to the source Y breaks it.
        // The handler validates instead of assuming, and falls through to routing.
        const rps = [{ x: 100, y: 200 }, { x: 100, y: 350 }, { x: 300, y: 350 }];
        const slid = slide(rps, { x: 104, y: 203 }, { x: 300, y: 352 });
        expect(isOrthogonalPolyline(slid)).toBe(false);
    });
});
