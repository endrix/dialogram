/**
 * The lines of text a producer puts in a node (`meta.lines`).
 *
 * They reach the client as the node's `NODE_LINES` argument, in the
 * producer's order, each with its kind when it has one. The node is taller
 * by a band per line and at least as wide as the longest. A line longer than
 * a node should be is cut, a list longer than a node should hold is cut
 * short, a malformed entry is passed over, and a symbol, which has no body
 * for them, takes none.
 */
import { describe, expect, it } from 'vitest';
import { WorkflowDiagramConstants, WorkflowDiagramMetadata } from '@dialogram/shared';
import { GraphGModelSource, type PyGraphDocument } from '../src/model/graph-gmodel-source';

type Element = { id: string; args?: Record<string, unknown>; size?: { width: number; height: number } };

function docWith(meta?: Record<string, unknown>, type?: string): PyGraphDocument {
    return {
        version: '1',
        graph: {
            id: 'root',
            nodes: [{
                id: 'node:a', kind: 'actor', label: 'a', scope: 'scope:root', meta, ...(type ? { type } : {}),
                ports: [{ id: 'node:a:in', name: 'in', direction: 'in' }, { id: 'node:a:out', name: 'out', direction: 'out' }]
            }],
            edges: []
        }
    };
}

const nodeFor = (meta?: Record<string, unknown>, type?: string): Element =>
    (new GraphGModelSource().transform(docWith(meta, type)).graph.children as unknown as Element[]).find(e => e.id === 'a')!;

const linesOf = (node: Element): unknown => node.args?.[WorkflowDiagramMetadata.NODE_LINES];

describe('lines of text in a node', () => {
    it('reach the client in order, each with its kind', () => {
        const node = nodeFor({ lines: [{ text: 'x > 3', kind: 'guard' }, { text: 'In 1 → Out 2' }, 'a bare string'] });

        expect(linesOf(node)).toEqual([{ text: 'x > 3', kind: 'guard' }, { text: 'In 1 → Out 2' }, { text: 'a bare string' }]);
    });

    it('make the node taller by a band each, under what it is without them', () => {
        const plain = nodeFor();
        const one = nodeFor({ lines: [{ text: 'x > 3' }] });
        const three = nodeFor({ lines: ['a', 'b', 'c'] });

        expect(one.size!.height).toBe(plain.size!.height + WorkflowDiagramConstants.NODE_LINE_HEIGHT_PX);
        expect(three.size!.height).toBe(plain.size!.height + 3 * WorkflowDiagramConstants.NODE_LINE_HEIGHT_PX);
        expect(one.size!.width).toBe(plain.size!.width);
    });

    it('keep the band of the type under the node as well', () => {
        const typed = nodeFor(undefined, 'Kind');
        const both = nodeFor({ lines: ['a', 'b'] }, 'Kind');

        expect(both.size!.height).toBe(typed.size!.height + 2 * WorkflowDiagramConstants.NODE_LINE_HEIGHT_PX);
    });

    it('widen the node for the longest line', () => {
        const plain = nodeFor();
        const long = nodeFor({ lines: ['self.count < self.limit and tok.kind == 7'] });

        expect(long.size!.width).toBeGreaterThan(plain.size!.width);
    });

    it('cut a line longer than a node should be, and its spaces to one', () => {
        const text = `a   ==\n  b and ${'x'.repeat(100)}`;
        const [line] = linesOf(nodeFor({ lines: [text] })) as { text: string }[];

        expect(line.text).toHaveLength(WorkflowDiagramConstants.NODE_LINE_MAX_CHARS);
        expect(line.text.startsWith('a == b and xxx')).toBe(true);
        expect(line.text.endsWith('…')).toBe(true);
    });

    it('hold no more than a node should', () => {
        const many = Array.from({ length: 20 }, (_, i) => `line ${i}`);
        const node = nodeFor({ lines: many });

        expect(linesOf(node)).toHaveLength(WorkflowDiagramConstants.NODE_LINE_MAX_COUNT);
        expect(node.size!.height).toBe(nodeFor().size!.height
            + WorkflowDiagramConstants.NODE_LINE_MAX_COUNT * WorkflowDiagramConstants.NODE_LINE_HEIGHT_PX);
    });

    it('pass over what is not a line, and drop a kind that is not a class name', () => {
        const node = nodeFor({ lines: [null, 7, { text: '  ' }, { kind: 'guard' }, { text: 'kept', kind: 'two words' }, { text: 'also', kind: 3 }] });

        expect(linesOf(node)).toEqual([{ text: 'kept' }, { text: 'also' }]);
    });

    it('are absent, and the node its usual size, when the producer gives none', () => {
        for (const meta of [undefined, {}, { lines: [] }, { lines: 'x > 3' }, { lines: [{ text: '' }] }]) {
            const node = nodeFor(meta as Record<string, unknown> | undefined);
            expect(linesOf(node)).toBeUndefined();
            expect(node.size).toEqual(nodeFor().size);
        }
    });

    it('are not given to a symbol, which has no body for them', () => {
        const node = nodeFor({ symbol: 'and', lines: ['x > 3'] });

        expect(linesOf(node)).toBeUndefined();
        expect(node.size).toEqual(nodeFor({ symbol: 'and' }).size);
    });
});
