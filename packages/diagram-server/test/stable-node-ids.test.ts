/**
 * A node's id is its label wherever the label names one node, and the
 * producer's id where it does not: the same expression on two ports is two
 * nodes with one label, and two elements with one id is a model the client
 * refuses whole (the sparc64soc `tlu`, `sparc_exu_div` and `eth_miim` units
 * drew nothing). A port's id is its node's and its name, under the same rule
 * among the ports of one node (`fpu_div_frac_dp`, `Top/W1` and 15 more drew
 * nothing).
 */
import { describe, expect, it } from 'vitest';
import { WorkflowDiagramMetadata } from '@dialogram/shared';
import { GraphGModelSource, type PyGraphDocument, type PyGraphNode } from '../src/model/graph-gmodel-source';
import { stableNodeIds, stablePortNames } from '../src/model/stable-ids';
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

describe('port ids', () => {
    // `{div_lead0[5:0], div_lead0[5:0]}` into a flop: one net read twice.
    const twice: PyGraphNode = {
        id: 'node:scope:root:regs.din', kind: 'logic', label: '{ div_lead0[5:0], div_lead0[5:0] }', scope: 'root',
        ports: [
            { id: 'port:node:scope:root:regs.din:out', name: 'din', direction: 'out' },
            { id: 'port:node:scope:root:regs.din:in:0', name: 'div_lead0[5:0]', direction: 'in' },
            { id: 'port:node:scope:root:regs.din:in:1', name: 'div_lead0[5:0]', direction: 'in' }
        ]
    };
    // `.fp_rdy(fp_rdy != 8'h00)`: the expression reads the net its port is named after.
    const self: PyGraphNode = {
        id: 'node:scope:root:u.fp_rdy', kind: 'logic', label: "fp_rdy!=8'h00", scope: 'root',
        ports: [
            { id: 'port:node:scope:root:u.fp_rdy:out', name: 'fp_rdy', direction: 'out' },
            { id: 'port:node:scope:root:u.fp_rdy:in:0', name: 'fp_rdy', direction: 'in' }
        ]
    };
    const source = (name: string, port: string): PyGraphNode => ({
        id: `node:scope:root:${name}`, kind: 'wf-input', label: name, scope: 'root',
        ports: [{ id: port, name, direction: 'out' }]
    });
    const shared: PyGraphDocument = {
        version: '1',
        graph: {
            id: 'top',
            nodes: [source('div_lead0', 'p:lead0'), source('fp_rdy', 'p:rdy'), twice, self],
            edges: [
                { id: 'e0', from: 'p:lead0', to: 'port:node:scope:root:regs.din:in:0', scope: 'root' },
                { id: 'e1', from: 'p:lead0', to: 'port:node:scope:root:regs.din:in:1', scope: 'root' },
                { id: 'e2', from: 'p:rdy', to: 'port:node:scope:root:u.fp_rdy:in:0', scope: 'root' }
            ]
        }
    };

    it('are the name for the first port on the node that carries it, the producer’s port id for later ones', () => {
        const names = stablePortNames(twice.ports);
        expect([...names.values()]).toEqual(['din', 'div_lead0[5:0]', 'port:node:scope:root:regs.din:in:1']);
        expect([...stablePortNames(self.ports).values()]).toEqual(['fp_rdy', 'port:node:scope:root:u.fp_rdy:in:0']);
    });

    it('give up a name another port’s fallback id takes', () => {
        const names = stablePortNames([
            { id: 'a', name: 'x', direction: 'in' },
            { id: 'b', name: 'x', direction: 'in' },   // falls back to `b`
            { id: 'c', name: 'b', direction: 'out' }   // so `b` is taken
        ]);
        expect([...names.values()]).toEqual(['x', 'b', 'c']);
    });

    it('are unique across the model, and each edge reaches the port it was drawn to', () => {
        const graph: any = new GraphGModelSource().transform(shared).graph;
        const all = ids(graph);
        expect(new Set(all).size).toBe(all.length);
        const edges = graph.children.filter((c: any) => typeof c.sourceId === 'string');
        expect(edges.map((e: any) => e.targetId)).toEqual([
            '{ div_lead0[5:0], div_lead0[5:0] }_port_div_lead0[5:0]',
            '{ div_lead0[5:0], div_lead0[5:0] }_port_port:node:scope:root:regs.din:in:1',
            "fp_rdy!=8'h00_port_port:node:scope:root:u.fp_rdy:in:0"
        ]);
        // Both ports still read as the net they carry.
        const node = graph.children.find((c: any) => c.id === '{ div_lead0[5:0], div_lead0[5:0] }');
        const shown = node.children.filter((c: any) => c.type?.startsWith('port'))
            .map((p: any) => p.args[WorkflowDiagramMetadata.PORT_NAME]);
        expect(shown).toEqual(['div_lead0[5:0]', 'div_lead0[5:0]', 'din']);
    });
});
