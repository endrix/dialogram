/**
 * The lines of text a producer puts in a node (`meta.lines`).
 *
 * They reach the client as the node's `NODE_LINES` argument, in the
 * producer's order, each with its kind when it has one. The node is taller
 * by a band per line and at least as wide as the longest. A line longer than
 * a node should be is cut (by character, counting a wide one as two columns),
 * a list longer than a node should hold is cut short, a malformed entry is
 * passed over, characters that have no place in a line are taken out, and a
 * symbol, an `if` and a loop take none.
 */
import { describe, expect, it } from 'vitest';
import { WorkflowDiagramConstants, WorkflowDiagramMetadata } from '@dialogram/shared';
import { GraphGModelSource, type PyGraphDocument } from '../src/model/graph-gmodel-source';
import { portBusStateOf } from '../src/model/port-bundles';
import { parseLinesMeta, textColumns } from '../src/server/graph-load-request-options';
import { ToggleNodeOpenOperation } from '@dialogram/shared';

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

    it('widen the node for the longest line: its columns in the fixed-width font, and the padding', () => {
        const text = 'self.count < self.limit and tok.kind == 7';
        const long = nodeFor({ lines: ['short', text] });

        expect(long.size!.width).toBe(2 * WorkflowDiagramConstants.NODE_LINE_PADDING_PX + 6 * text.length);
        // A wide character takes two columns.
        const wide = nodeFor({ lines: ['状態が三より大きい場合にのみ発火する'] });
        expect(wide.size!.width).toBe(2 * WorkflowDiagramConstants.NODE_LINE_PADDING_PX + 6 * 2 * 18);
    });

    it('sit under the last row of ports of a node taller than the least', () => {
        const ports = Array.from({ length: 6 }, (_, k) => ({ id: `node:a:in${k}`, name: `in${k}`, direction: 'in' as const }));
        const transformOf = (meta?: Record<string, unknown>): Element => (new GraphGModelSource().transform({
            version: '1',
            graph: { id: 'root', nodes: [{ id: 'node:a', kind: 'actor', label: 'a', scope: 'scope:root', meta, ports }], edges: [] }
        }).graph.children as unknown as Element[]).find(e => e.id === 'a')!;
        const plain = transformOf();
        const lined = transformOf({ lines: ['a', 'b'] });

        expect(plain.size!.height).toBeGreaterThan(60);
        expect(lined.size!.height).toBe(plain.size!.height + 2 * WorkflowDiagramConstants.NODE_LINE_HEIGHT_PX);
    });

    it('cut a line longer than a node should be, and its spaces to one', () => {
        const text = `a   ==\n  b and ${'x'.repeat(100)}`;
        const [line] = linesOf(nodeFor({ lines: [text] })) as { text: string }[];

        expect(line.text).toHaveLength(WorkflowDiagramConstants.NODE_LINE_MAX_CHARS);
        expect(line.text.startsWith('a == b and xxx')).toBe(true);
        expect(line.text.endsWith('…')).toBe(true);
        // As long as a node may hold is kept whole; one more is cut.
        const max = WorkflowDiagramConstants.NODE_LINE_MAX_CHARS;
        expect(parseLinesMeta(['x'.repeat(max)])[0].text).toBe('x'.repeat(max));
        expect(parseLinesMeta(['x'.repeat(max + 1)])[0].text).toBe(`${'x'.repeat(max - 1)}…`);
    });

    it('cut by character, never through one, and count a wide character as two columns', () => {
        const max = WorkflowDiagramConstants.NODE_LINE_MAX_CHARS;
        // A character outside the basic plane is two units of the string: the cut must not fall between them.
        const [astral] = parseLinesMeta([`${'x'.repeat(max - 2)}😀bbbb`]);
        expect(astral.text).toBe(`${'x'.repeat(max - 2)}…`);
        expect(astral.text.isWellFormed()).toBe(true);
        const [emoji] = parseLinesMeta(['😀'.repeat(40)]);
        expect(emoji.text.isWellFormed()).toBe(true);
        expect(textColumns(emoji.text)).toBeLessThanOrEqual(max);
        const [cjk] = parseLinesMeta(['状'.repeat(48)]);
        expect(cjk.text).toBe(`${'状'.repeat(23)}…`);
        expect(textColumns(cjk.text)).toBe(max - 1);
    });

    it('take out what has no place in a line: control characters, marks that turn the text, spaces of no width', () => {
        expect(parseLinesMeta(['a\u0001b', '\u001b[31m red', 'abc \u202edesrever', 'x\u200by'])).toEqual([
            { text: 'a b' }, { text: '[31m red' }, { text: 'abc desrever' }, { text: 'x y' }
        ]);
        // Nothing left to read is no line.
        expect(parseLinesMeta(['\u200b', '\u0000\u202e', { text: '\ufeff' }])).toEqual([]);
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
        // What is passed over does not count toward the most a node holds.
        const six = Array.from({ length: 7 }, (_, i) => `line ${i}`);
        expect(parseLinesMeta([null, { text: '' }, 7, ...six]).map(line => line.text)).toEqual(six.slice(0, 6));
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

    it('are not given to an `if` or a loop, a frame around what it holds, nor to a port of the unit', () => {
        const of = (kind: string, meta?: Record<string, unknown>): Element => (new GraphGModelSource().transform({
            version: '1',
            graph: {
                id: 'root',
                nodes: [{
                    id: 'node:a', kind, label: 'a', scope: 'scope:root', meta,
                    ports: [{ id: 'node:a:p', name: 'p', direction: kind === 'wf-output' ? 'in' : 'out' }]
                }],
                edges: []
            }
        }).graph.children as unknown as Element[])[0];
        for (const kind of ['if', 'loop', 'wf-input', 'wf-output']) {
            const lined = of(kind, { lines: ['x > 3', 'second'], ...(kind.startsWith('wf-') ? { networkBoundary: true } : {}) });
            const plain = of(kind, kind.startsWith('wf-') ? { networkBoundary: true } : undefined);
            expect(linesOf(lined), kind).toBeUndefined();
            expect(lined.size, kind).toEqual(plain.size);
        }
    });

    it('are drawn in a node that can open while it is closed; opened, it is a frame and has none', () => {
        const doc: PyGraphDocument = {
            version: '1',
            graph: {
                id: 'root',
                nodes: [{
                    id: 'node:big', kind: 'actor', label: 'big', scope: 'scope:root',
                    ports: [{ id: 'node:big:in', name: 'in', direction: 'in' }],
                    meta: {
                        lines: ['x > 3'],
                        inner: {
                            nodes: [{ id: 'cell', kind: 'actor', label: 'cell', ports: [{ id: 'cell:a', name: 'a', direction: 'in' }] }],
                            edges: [{ from: 'node:big:in', to: 'cell:a' }]
                        }
                    }
                }],
                edges: []
            }
        };
        const all = (elements: any[], out: any[] = []): any[] => {
            for (const element of elements ?? []) {
                out.push(element);
                all(element.children, out);
            }
            return out;
        };
        const closed = all(new GraphGModelSource().transform(doc).graph.children as any[]);
        expect(closed.find(e => e.id === 'big').args[WorkflowDiagramMetadata.NODE_LINES]).toEqual([{ text: 'x > 3' }]);
        const open = portBusStateOf(new Map([['big', new Set([ToggleNodeOpenOperation.OPEN])]]));
        const opened = all(new GraphGModelSource().transform(doc, { portBuses: open }).graph.children as any[]);
        expect(opened.some(e => e.id === 'big')).toBe(false);
        expect(opened.some(e => e.args?.[WorkflowDiagramMetadata.NODE_LINES])).toBe(false);
    });
});
