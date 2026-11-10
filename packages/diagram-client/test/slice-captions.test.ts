/**
 * The bits of a port a wire is (a producer's slices, mapped to the end's
 * index): written whatever the captions, and, where several wires meet one
 * port end, one after another along the wire, highest bits first.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
describe('the bits a wire is', () => {
    it('are written at its end whatever the captions', () => {
        const here = path.dirname(fileURLToPath(import.meta.url));
        const views = readFileSync(path.resolve(here, '../src/views.ts'), 'utf8');
        expect(views).toMatch(/const indexCaptions = captions \|\| edgeArgs\?\.\[WorkflowDiagramMetadata\.EDGE_SLICE\] === true;/);
        expect(views).toMatch(/\.\.\.\(indexCaptions && fromIndexLabel/);
        expect(views).toMatch(/\.\.\.\(indexCaptions && toIndexLabel/);
    });
});

describe('index labels sharing a port end', () => {
    it('go one after another along the wire, the highest bits first', async () => {
        const { indexLabelShift } = await import('../src/views');
        const { WorkflowDiagramMetadata } = await import('@dialogram/shared');
        const edge = (id: string, bits: string) => ({ id, args: { [WorkflowDiagramMetadata.EDGE_TO_INDEX]: bits, [WorkflowDiagramMetadata.EDGE_SLICE]: true } });
        const a = edge('a', '1:0'), b = edge('b', '4:3'), c = edge('c', '2');
        const port = { incomingEdges: [a, b, c] };
        for (const e of [a, b, c]) {
            (e as any).target = port;
        }
        const shifts = [b, c, a].map(e => indexLabelShift(e, 'to'));
        expect(shifts[0]).toBe(0);
        expect(shifts[1]).toBeGreaterThan(0);
        expect(shifts[2]).toBeGreaterThan(shifts[1]);
        // Alone at its end, no shift.
        expect(indexLabelShift({ id: 'x', args: { [WorkflowDiagramMetadata.EDGE_TO_INDEX]: '3', [WorkflowDiagramMetadata.EDGE_SLICE]: true }, target: { incomingEdges: [] } }, 'to')).toBe(0);
        // An index that is not a slice (a list connection's) stays where it was.
        const plain = { id: 'p', args: { [WorkflowDiagramMetadata.EDGE_TO_INDEX]: '0' } } as any;
        plain.target = { incomingEdges: [plain, b] };
        expect(indexLabelShift(plain, 'to')).toBe(0);
    });

    it('are walked back along the wire round its bends, never past its other end', async () => {
        const { pointAlongRoute } = await import('../src/views');
        const route = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 10 }];
        // From the end: 10 up the last stretch, then 20 along the first.
        expect(pointAlongRoute(route, 'end', 30, 0)).toEqual({ x: 80, y: 0 });
        // Never past the other end.
        expect(pointAlongRoute(route, 'end', 500, 0)).toEqual({ x: 0, y: 0 });
    });
});

describe('the bits as the producer writes them', () => {
    it('are drawn as written, and take the room they need beside the others', async () => {
        const { indexLabelText, indexLabelShift } = await import('../src/views');
        const { WorkflowDiagramMetadata: M } = await import('@dialogram/shared');
        expect(indexLabelText({ [M.EDGE_TO_INDEX]: '7:4', [M.EDGE_TO_INDEX_LABEL]: '(7 downto 4)' }, 'to')).toBe('(7 downto 4)');
        expect(indexLabelText({ [M.EDGE_TO_INDEX]: '7:4' }, 'to')).toBe('[7:4]');
        expect(indexLabelText({}, 'from')).toBeUndefined();
        // Ordered by the bits; spaced by the text drawn.
        const edge = (id: string, bits: string, label?: string) =>
            ({ id, args: { [M.EDGE_TO_INDEX]: bits, [M.EDGE_SLICE]: true, ...(label ? { [M.EDGE_TO_INDEX_LABEL]: label } : {}) } });
        const hi = edge('hi', '7:4', '(7 downto 4)'), lo = edge('lo', '3:0', '(3 downto 0)');
        const short = edge('hi2', '7:4'), short2 = edge('lo2', '3:0');
        for (const [a, b] of [[hi, lo], [short, short2]]) {
            const port = { incomingEdges: [a, b] };
            (a as any).target = port;
            (b as any).target = port;
        }
        expect(indexLabelShift(hi, 'to')).toBe(0);
        expect(indexLabelShift(lo, 'to')).toBeGreaterThan(indexLabelShift(short2, 'to'));
    });
});
