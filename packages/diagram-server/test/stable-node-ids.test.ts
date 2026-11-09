/**
 * A node's id is its label wherever the label names one node, and the
 * producer's id where it does not: the same expression on two ports is two
 * nodes with one label, and two elements with one id is a model the client
 * refuses whole (the sparc64soc `tlu`, `sparc_exu_div` and `eth_miim` units
 * drew nothing).
 */
import { describe, expect, it } from 'vitest';
import { WorkflowDiagramMetadata } from '@dialogram/shared';
import { GraphGModelSource, type PyGraphDocument, type PyGraphNode } from '../src/model/graph-gmodel-source';
import { stableNodeIds } from '../src/model/stable-ids';
import { portBusStateOf } from '../src/model/port-bundles';

const expr = (id: string): PyGraphNode => ({
    id, kind: 'logic', label: '{ tid[1:0], tpl[2:0] }', scope: 'root',
    ports: [{ id: `port:${id}:out`, name: 'wr_adr', direction: 'out' }]
});
const mem = (name: string): PyGraphNode => ({
    id: `node:scope:root:${name}`, kind: 'instance', label: name, scope: 'root',
    ports: [{ id: `port:node:scope:root:${name}:wr_adr`, name: 'wr_adr', direction: 'in' }]
});
const doc: PyGraphDocument = {
    version: '1',
    graph: {
        id: 'top',
        nodes: [mem('m0'), mem('m1'), expr('node:scope:root:m0.wr_adr'), expr('node:scope:root:m1.wr_adr')],
        edges: [
            { id: 'e0', from: 'port:node:scope:root:m0.wr_adr:out', to: 'port:node:scope:root:m0:wr_adr', scope: 'root' },
            { id: 'e1', from: 'port:node:scope:root:m1.wr_adr:out', to: 'port:node:scope:root:m1:wr_adr', scope: 'root' }
        ]
    }
};

function ids(element: any, out: string[] = []): string[] {
    out.push(element.id);
    for (const child of element.children ?? []) {
        ids(child, out);
    }
    return out;
}

describe('node ids', () => {
    it('are the label for the first node that carries it, the producer’s id for the later ones', () => {
        const byId = stableNodeIds(doc.graph.nodes);
        expect(byId.get('node:scope:root:m0')).toBe('m0');
        expect(byId.get('node:scope:root:m0.wr_adr')).toBe('{ tid[1:0], tpl[2:0] }');
        expect(byId.get('node:scope:root:m1.wr_adr')).toBe('node:scope:root:m1.wr_adr');
    });

    it('are unique across the model, and each edge still reaches its own port', () => {
        const graph: any = new GraphGModelSource().transform(doc).graph;
        const all = ids(graph);
        expect(new Set(all).size).toBe(all.length);
        const edges = graph.children.filter((c: any) => typeof c.sourceId === 'string');
        expect(edges.map((e: any) => [e.sourceId, e.targetId])).toEqual([
            ['{ tid[1:0], tpl[2:0] }_port_wr_adr', 'm0_port_wr_adr'],
            ['node:scope:root:m1.wr_adr_port_wr_adr', 'm1_port_wr_adr']
        ]);
        // The label the reader sees is unchanged.
        const node = graph.children.find((c: any) => c.id === 'node:scope:root:m1.wr_adr');
        expect(node.args[WorkflowDiagramMetadata.ENTITY_NAME]).toBe('{ tid[1:0], tpl[2:0] }');
    });

    it('keep a label that was unique before, even where it is another node’s producer id', () => {
        const byId = stableNodeIds([
            { id: 'a', kind: 'instance', label: 'b', scope: 'root', ports: [] },
            { id: 'b', kind: 'instance', label: 'c', scope: 'root', ports: [] }
        ]);
        expect([byId.get('a'), byId.get('b')]).toEqual(['b', 'c']);
    });

    it('give up a label that another node’s fallback id takes, and a blank one', () => {
        const byId = stableNodeIds([
            { id: 'x', kind: 'logic', label: 'L', scope: 'root', ports: [] },
            { id: 'y', kind: 'logic', label: 'L', scope: 'root', ports: [] },   // falls back to `y`
            { id: 'z', kind: 'instance', label: 'y', scope: 'root', ports: [] },  // so `y` is taken
            { id: 'n', kind: 'logic', label: '  ', scope: 'root', ports: [] }
        ]);
        expect([...byId.values()]).toEqual(['L', 'y', 'z', 'n']);
    });

    it('are the keys a node’s open bundles are saved under, for nodes that share a label too', () => {
        const busNode = (id: string): PyGraphNode => ({
            id, kind: 'instance', label: 'dup', scope: 'root',
            ports: [
                { id: `port:${id}:a_valid`, name: 'a_valid', direction: 'out', group: 'a' },
                { id: `port:${id}:a_data`, name: 'a_data', direction: 'out', group: 'a' }
            ]
        });
        const twins: PyGraphDocument = { version: '1', graph: { id: 'top', nodes: [busNode('first'), busNode('second')], edges: [] } };
        // The second twin's bundle is open: it is saved under its model id, `second`.
        const graph: any = new GraphGModelSource().transform(twins, {
            portBuses: portBusStateOf(new Map([['second', new Set(['a'])]]))
        }).graph;
        const expanded = (nodeId: string) => graph.children.find((c: any) => c.id === nodeId)
            .children.find((c: any) => c.args?.[WorkflowDiagramMetadata.PORT_BUS_GROUP] === 'a')
            .args[WorkflowDiagramMetadata.PORT_BUS_EXPANDED];
        expect([expanded('dup'), expanded('second')]).toEqual([false, true]);
    });
});
