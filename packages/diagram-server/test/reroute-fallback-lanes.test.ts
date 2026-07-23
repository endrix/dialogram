import { describe, expect, it } from 'vitest';
import { snapToOrthogonalPath } from '../src/routing/orthogonal-fallback';

describe('reroute fallback lanes', () => {
    it('uses different lanes for different source ports', () => {
        const startA = { x: 404, y: 458 };
        const startB = { x: 404, y: 512 };
        const end = { x: 744, y: 300 };

        const routeA = snapToOrthogonalPath(startA, end, 'E:SW::controller_port_PE_B_REF');
        const routeB = snapToOrthogonalPath(startB, end, 'E:SW::controller_port_PE_ALL_READ');

        expect(routeA).toHaveLength(4);
        expect(routeB).toHaveLength(4);

        // route[1].x is the lane-defining midX.
        expect(routeA[1].x).not.toBe(routeB[1].x);
    });

    it('is stable for the same source port key', () => {
        const start = { x: 404, y: 458 };
        const end1 = { x: 744, y: 281 };
        const end2 = { x: 744, y: 320 };

        const key = 'E:SW::controller_port_PE_B_REF';
        const route1 = snapToOrthogonalPath(start, end1, key);
        const route2 = snapToOrthogonalPath(start, end2, key);

        // Same port => same lane => same initial horizontal segment end.
        expect(route1[1].x).toBe(route2[1].x);
    });
});
