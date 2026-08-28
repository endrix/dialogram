/**
 * A node's italic type label is drawn BELOW its body, so for a long time it was
 * left out of the node's height entirely. That made it invisible to everything
 * downstream that reasons about geometry: ELK spaced nodes box-to-box and could
 * place a label on top of the node beneath it, and both edge routers take the
 * same boxes as obstacles, so a route could pass straight through a label.
 *
 * The height now reserves the band, and the client draws the body shorter by
 * exactly that amount — the node looks the same, but the space it claims is
 * honest. These tests pin both halves: the reserve is added when there is a
 * label, and NOT added when there isn't.
 */
import { describe, expect, it } from 'vitest';
import { WorkflowDiagramConstants, WorkflowDiagramTypes } from '@dialogram/shared';
import { GraphGModelSource, type PyGraphDocument } from '../src/model/graph-gmodel-source';

const RESERVE = WorkflowDiagramConstants.NODE_FOOTER_LABEL_HEIGHT_PX;

function build(label: string, type: string | undefined, ports: any[] = []): PyGraphDocument {
    return {
        version: '1',
        graph: {
            id: 'root',
            nodes: [{ id: 'n1', kind: 'task', label, type, scope: 'root', ports } as any],
            edges: []
        }
    };
}

function actorOf(doc: PyGraphDocument) {
    const result = new GraphGModelSource().transform(doc);
    return result.graph.children?.find(c =>
        c.type === WorkflowDiagramTypes.NODE_ACTOR || c.type === WorkflowDiagramTypes.NODE_EXTERNAL_ACTOR);
}

describe('node height reserves the footer type label', () => {
    it('adds the band when the type differs from the label', () => {
        const withLabel = actorOf(build('tokenize', 'Tokenizer'));
        const withoutLabel = actorOf(build('Tokenizer', 'Tokenizer'));

        expect(withLabel?.args?.['wf:footerTypeLabel']).toBe('Tokenizer');
        expect(withoutLabel?.args?.['wf:footerTypeLabel']).toBeUndefined();

        const a = (withLabel as any).size.height;
        const b = (withoutLabel as any).size.height;
        expect(a - b).toBe(RESERVE);
    });

    it('does not reserve anything for a node with no type label', () => {
        // Same node twice; only the presence of the label may change the height.
        const first = actorOf(build('same', 'same'));
        const second = actorOf(build('same', undefined));
        expect((first as any).size.height).toBe((second as any).size.height);
    });

    it('reserves on top of the port-driven height, not instead of it', () => {
        const ports = [
            { id: 'p1', name: 'in1', direction: 'in', type: 'int' },
            { id: 'p2', name: 'in2', direction: 'in', type: 'int' },
            { id: 'p3', name: 'in3', direction: 'in', type: 'int' },
            { id: 'p4', name: 'in4', direction: 'in', type: 'int' }
        ];
        const tall = actorOf(build('tokenize', 'Tokenizer', ports));
        const tallNoLabel = actorOf(build('Tokenizer', 'Tokenizer', ports));
        const short = actorOf(build('tokenize', 'Tokenizer'));

        // Four ports make the node taller than the minimum, and the reserve is
        // still added on top of that.
        expect((tall as any).size.height).toBeGreaterThan((short as any).size.height);
        expect((tall as any).size.height - (tallNoLabel as any).size.height).toBe(RESERVE);
    });

    it('leaves ports where they were — the band is at the bottom', () => {
        const ports = [{ id: 'p1', name: 'in1', direction: 'in', type: 'int' }];
        const withLabel = actorOf(build('tokenize', 'Tokenizer', ports));
        const withoutLabel = actorOf(build('Tokenizer', 'Tokenizer', ports));

        const portY = (n: any) => n.children.flatMap((c: any) =>
            c.type === WorkflowDiagramTypes.PORT_INPUT ? [c.position.y] : []);
        expect(portY(withLabel)).toEqual(portY(withoutLabel));
    });
});
