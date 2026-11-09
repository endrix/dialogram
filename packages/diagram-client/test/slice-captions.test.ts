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
        const edge = (id: string, bits: string) => ({ id, args: { [WorkflowDiagramMetadata.EDGE_TO_INDEX]: bits } });
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
        expect(indexLabelShift({ id: 'x', args: { [WorkflowDiagramMetadata.EDGE_TO_INDEX]: '3' }, target: { incomingEdges: [] } }, 'to')).toBe(0);
    });
});
