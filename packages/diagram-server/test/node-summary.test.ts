/**
 * What a node says (`meta.summary`): a paragraph in its body, under its
 * ports, in the place of its family's mark. The server wraps it at the
 * node's width and sizes the node by it (node-summary.ts).
 */
import { describe, expect, it } from 'vitest';
import { summaryLines, summaryRuns, summaryWidth, uiTextWidth, WorkflowDiagramConstants, WorkflowDiagramMetadata } from '@dialogram/shared';
import { GraphGModelSource, type PyGraphDocument, type PyGraphNode } from '../src/model/graph-gmodel-source';

const RULE = 'Entering `cpu_state_trap` MUST stop the machine permanently: the state is absorbing, and the only exit is reset.';
const LONG = 'The two state machines MUST be coupled combinationally in both directions, and an implementation that inserts a register at any of the four crossings breaks the timing every test of the core relies on, which nothing else in the design would notice before silicon.';
const { SUMMARY_FONT_SIZE_PX: SIZE, SUMMARY_LINE_HEIGHT_PX: LINE, SUMMARY_PADDING_PX: PAD, SUMMARY_WIDTH_PX: ASK, SUMMARY_MAX_LINES: MAX } = WorkflowDiagramConstants;

function transform(nodes: PyGraphNode[]): any[] {
    const doc: PyGraphDocument = { version: '1', graph: { id: 'root', nodes, edges: [] } };
    return new GraphGModelSource().transform(doc).graph.children ?? [];
}

function node(id: string, summary?: unknown, extra: Partial<PyGraphNode> = {}): PyGraphNode {
    return {
        id,
        kind: 'requirement',
        label: 'A trap is a halt',
        scope: 'root',
        ports: [
            { id: `${id}:in`, name: 'in', direction: 'in' },
            { id: `${id}:out`, name: 'out', direction: 'out' }
        ],
        ...(summary !== undefined ? { meta: { summary } } : {}),
        ...extra
    } as PyGraphNode;
}

/** How wide a line is drawn: prose in the UI font, code in the editor's columns. */
const drawnWidth = (line: string): number => summaryRuns(line)
    .reduce((sum, run) => sum + (run.code ? run.text.length * Math.max(5, Math.round(SIZE * 0.6)) : uiTextWidth(run.text, SIZE)), 0);

describe('a node that says something', () => {
    const [said, plain] = transform([node('said', RULE), node('plain')]);

    it('hands the client its paragraph in lines, every word of it, code spans in backticks', () => {
        const lines: string[] = said.args[WorkflowDiagramMetadata.NODE_SUMMARY];
        expect(lines.length).toBeGreaterThan(1);
        expect(lines.join(' ')).toBe(RULE);
        expect(plain.args[WorkflowDiagramMetadata.NODE_SUMMARY]).toBeUndefined();
    });

    it('is as wide as a paragraph asks, and every line fits inside its padding', () => {
        expect(said.size.width).toBe(ASK);
        for (const line of said.args[WorkflowDiagramMetadata.NODE_SUMMARY]) {
            expect(drawnWidth(line), line).toBeLessThanOrEqual(said.size.width - 2 * PAD);
        }
    });

    it('is taller by its lines, under its ports, without the room its mark had', () => {
        const lines = said.args[WorkflowDiagramMetadata.NODE_SUMMARY].length;
        // The port area, as the server sizes it: one row of ports under the header.
        const { HEADER_HEIGHT_PX, PORT_AREA_PADDING_PX, PORT_HEIGHT_PX, PORT_ROW_VERTICAL_GAP_PX } = WorkflowDiagramConstants;
        const portBottom = HEADER_HEIGHT_PX + PORT_AREA_PADDING_PX + (PORT_HEIGHT_PX + PORT_ROW_VERTICAL_GAP_PX)
            - PORT_ROW_VERTICAL_GAP_PX + PORT_HEIGHT_PX + PORT_AREA_PADDING_PX;
        expect(said.size.height).toBe(portBottom + lines * LINE + 2 * PAD);
        // The plain node keeps the room for its family's mark.
        expect(plain.size.height).toBeGreaterThan(portBottom);
    });

    it('asks less than the full width when it is shorter, and more for a word wider than that', () => {
        const short = 'The machine MUST stop.';
        expect(summaryWidth(short)).toBeLessThan(ASK);
        expect(summaryLines(short, summaryWidth(short))).toEqual([short]);
        const word = `\`${'x'.repeat(60)}\``;
        expect(summaryWidth(`A ${word} MUST hold.`)).toBeGreaterThan(ASK);
        expect(summaryWidth(undefined)).toBe(0);
        expect(summaryWidth('   ')).toBe(0);
    });

    it('stops after its last line with an ellipsis when it says more than fits', () => {
        const [long] = transform([node('long', LONG)]);
        const lines: string[] = long.args[WorkflowDiagramMetadata.NODE_SUMMARY];
        expect(lines).toHaveLength(MAX);
        expect(lines[MAX - 1].endsWith('…')).toBe(true);
        expect(drawnWidth(lines[MAX - 1])).toBeLessThanOrEqual(long.size.width - 2 * PAD);
        expect(LONG.startsWith(lines.slice(0, -1).join(' '))).toBe(true);
    });

    it('balances its lines, so the last is not a word on its own', () => {
        const lines = summaryLines('At most one instruction MUST be in flight.', ASK);
        expect(lines).toHaveLength(2);
        expect(lines[1].split(' ').length).toBeGreaterThan(1);
    });

    it('keeps a code span that breaks across lines in backticks on each', () => {
        const lines = summaryLines('A register `cpu state id rs2 latch` MUST hold it.', 120);
        for (const line of lines) {
            expect((line.match(/`/g) ?? []).length % 2, line).toBe(0);
        }
        expect(summaryRuns('a `b` c')).toEqual([{ text: 'a ', code: false }, { text: 'b', code: true }, { text: ' c', code: false }]);
        expect(summaryRuns('a `b')).toEqual([{ text: 'a `b', code: false }]);
    });

    it('is not drawn on a state, a frame, a symbol, or for anything but text', () => {
        const [state, frame, number] = transform([
            node('state', RULE, { kind: 'state', ports: [] }),
            node('frame', RULE, { kind: 'loop' }),
            node('number', 42)
        ]);
        for (const gnode of [state, frame, number]) {
            expect(gnode.args[WorkflowDiagramMetadata.NODE_SUMMARY], gnode.id).toBeUndefined();
        }
    });
});
