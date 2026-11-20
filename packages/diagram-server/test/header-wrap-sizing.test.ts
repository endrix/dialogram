/**
 * A long name breaks onto lines in its node's header, which grows taller
 * instead of the node wider (header-lines.ts). The server sizes the node by
 * the lines and hands them to the client on the name label.
 */
import { describe, expect, it } from 'vitest';
import { headerTextWidth, WorkflowDiagramConstants, WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import { GraphGModelSource, type PyGraphDocument, type PyGraphNode } from '../src/model/graph-gmodel-source';
import type { StorageRuntimeOptions } from '../src/server/storage-runtime-options';

const LONG = 'Q-003: an undecoded instruction hangs when `CATCH_ILLINSN` is off and a co-processor is present';

function transform(nodes: PyGraphNode[], storage?: StorageRuntimeOptions): any[] {
    const doc: PyGraphDocument = { version: '1', graph: { id: 'root', nodes, edges: [] } };
    return new GraphGModelSource(storage).transform(doc).graph.children ?? [];
}

function node(label: string, extra: Partial<PyGraphNode> = {}): PyGraphNode {
    return {
        id: `node:${label.length}`,
        kind: 'requirement',
        label,
        scope: 'root',
        ports: [
            { id: `p:${label.length}:in`, name: 'in', direction: 'in' },
            { id: `p:${label.length}:out`, name: 'out', direction: 'out' }
        ],
        ...extra
    };
}

const nameLabel = (gnode: any): any => gnode.children
    .find((child: any) => child.type === WorkflowDiagramTypes.COMPARTMENT_HEADER)
    ?.children.find((child: any) => child.type === WorkflowDiagramTypes.LABEL_NAME);

describe('a long name in its header', () => {
    const [wrapped] = transform([node(LONG)]);
    const [short] = transform([node('A trap is a halt')]);

    it('hands the client its lines and keeps the whole name as the label', () => {
        const label = nameLabel(wrapped);
        expect(label.text).toBe(LONG);
        const lines = label.args[WorkflowDiagramMetadata.HEADER_LINES];
        expect(lines).toHaveLength(3);
        expect(lines.join(' ')).toBe(LONG);
    });

    it('makes the node narrower than the name on one line, and taller by its lines', () => {
        const oneLine = headerTextWidth(LONG);
        expect(wrapped.size.width).toBeLessThan(oneLine / 2);
        expect(wrapped.size.height - short.size.height).toBe(2 * WorkflowDiagramConstants.HEADER_LINE_HEIGHT_PX);
    });

    it('puts the ports under the taller header', () => {
        const portY = (gnode: any) => Math.min(...gnode.children
            .filter((child: any) => typeof child.type === 'string' && child.type.startsWith('port'))
            .map((port: any) => port.position.y));
        expect(portY(wrapped) - portY(short)).toBe(2 * WorkflowDiagramConstants.HEADER_LINE_HEIGHT_PX);
    });

    it('keeps a name on one line when the node is wide enough for it anyway', () => {
        // Its ports make it wide: the name fits on one line in that room.
        const [wide] = transform([node('The fetch unit and its memory port', {
            ports: [
                { id: 'p:w:in', name: 'instruction_memory_request_valid', direction: 'in' },
                { id: 'p:w:out', name: 'instruction_memory_response_ready', direction: 'out' }
            ]
        })]);
        expect(nameLabel(wide).args?.[WorkflowDiagramMetadata.HEADER_LINES]).toBeUndefined();
        const [narrow] = transform([node('The fetch unit and its memory port')]);
        expect(nameLabel(narrow).args?.[WorkflowDiagramMetadata.HEADER_LINES]).toHaveLength(2);
    });

    it('leaves a short name, and a name with nowhere to break, on one line', () => {
        expect(nameLabel(short).args?.[WorkflowDiagramMetadata.HEADER_LINES]).toBeUndefined();
        const [identifier] = transform([node('picorv32_axi_adapter_with_a_very_long_name')]);
        expect(nameLabel(identifier).args?.[WorkflowDiagramMetadata.HEADER_LINES]).toBeUndefined();
        expect(identifier.size.height).toBe(short.size.height);
    });
});

describe('a product or a producer that keeps names on one line', () => {
    const product = (headerWrap: boolean): StorageRuntimeOptions => ({ settingsNamespace: 'test', operationPrefix: 'test', headerWrap });
    const CODE = 'data_out <= {fifo[rd_ptr][7:0], parity, stop_bits, start_bit, frame_error}';
    const linesOf = (gnode: any) => nameLabel(gnode).args?.[WorkflowDiagramMetadata.HEADER_LINES];

    it('breaks a long name by default', () => {
        const [wrapped] = transform([node(CODE)]);
        expect(linesOf(wrapped).length).toBeGreaterThan(1);
    });

    it('keeps every name on one line, sized by it, when the product turns the wrap off', () => {
        const [code] = transform([node(CODE)], product(false));
        expect(linesOf(code)).toBeUndefined();
        expect(code.size.width).toBeGreaterThanOrEqual(headerTextWidth(CODE));
        const [short] = transform([node('A trap is a halt')], product(false));
        expect(code.size.height).toBe(short.size.height);
    });

    it('keeps a node on one line that its producer marks, and wraps the others', () => {
        const [code, prose] = transform([
            node(CODE, { meta: { headerWrap: false } }),
            node(LONG, { id: 'prose' })
        ]);
        expect(linesOf(code)).toBeUndefined();
        expect(linesOf(prose)).toHaveLength(3);
    });

    it('wraps a node its producer marks, in a product that turned the wrap off', () => {
        const [prose, code] = transform([
            node(LONG, { meta: { headerWrap: true } }),
            node(CODE, { id: 'code' })
        ], product(false));
        expect(linesOf(prose)).toHaveLength(3);
        expect(linesOf(code)).toBeUndefined();
    });
});
