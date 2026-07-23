import { describe, expect, it } from 'vitest';
import { WorkflowRerouteEdgesAvoidOverlapsOperationHandler } from '../src/operations/reroute-edges-avoid-overlaps-handler';

// segmentHitsBox is geometry-only; exercise it directly without the DI container.
function hits(a: { x: number; y: number }, b: { x: number; y: number }, box: any): boolean {
    const h: any = new (WorkflowRerouteEdgesAvoidOverlapsOperationHandler as any)();
    return h.segmentHitsBox(a, b, box);
}

// A node box in the handler's {x:left, y:top, r:right, b:bottom} shape.
const box = { id: 'n', x: 100, y: 100, r: 200, b: 160 };

describe('foreign-edge intersection (segmentHitsBox)', () => {
    it('detects a horizontal segment passing through the box', () => {
        expect(hits({ x: 50, y: 130 }, { x: 250, y: 130 }, box)).toBe(true);
    });

    it('detects a vertical segment passing through the box', () => {
        expect(hits({ x: 150, y: 50 }, { x: 150, y: 250 }, box)).toBe(true);
    });

    it('ignores a segment that clears the box', () => {
        expect(hits({ x: 50, y: 80 }, { x: 250, y: 80 }, box)).toBe(false);   // above
        expect(hits({ x: 50, y: 130 }, { x: 90, y: 130 }, box)).toBe(false);  // stops left of box
        expect(hits({ x: 210, y: 50 }, { x: 210, y: 250 }, box)).toBe(false); // right of box
    });

    it('treats a segment grazing the exact border as clear (strict inequality)', () => {
        expect(hits({ x: 50, y: 100 }, { x: 250, y: 100 }, box)).toBe(false); // exactly on top edge
    });
});
