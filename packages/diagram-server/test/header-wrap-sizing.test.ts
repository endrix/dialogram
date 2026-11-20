/**
 * A long name breaks onto lines in its node's header, which grows taller
 * instead of the node wider (header-lines.ts). The server sizes the node by
 * the lines and hands them to the client on the name label.
 */
import { describe, expect, it } from 'vitest';
import { headerTextWidth, WorkflowDiagramConstants, WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import { GraphGModelSource, type PyGraphDocument, type PyGraphNode } from '../src/model/graph-gmodel-source';

const LONG = 'Q-003: an undecoded instruction hangs when `CATCH_ILLINSN` is off and a co-processor is present';

function transform(nodes: PyGraphNode[]): any[] {
    const doc: PyGraphDocument = { version: '1', graph: { id: 'root', nodes, edges: [] } };
    return new GraphGModelSource().transform(doc).graph.children ?? [];
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
