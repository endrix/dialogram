import { describe, expect, it } from 'vitest';
import { GGraph, GNode, GPort, type GModelElement } from '@eclipse-glsp/server';
import { WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import {
    applyKeptPortOrders, definitionKeyOf, drawInSourceOrder, keptPortOrderChanges, keptPortOrdersOf, portsMayReorder,
    regridPortRows, sidesOf, withPortOrderChanges
} from '../src/model/definition-port-order';

const ROW = 20;

function attach<T extends GModelElement>(parent: GModelElement, children: T[]): T[] {
    for (const child of children) {
        (child as { parent?: GModelElement }).parent = parent;
    }
    parent.children = [...(parent.children ?? []), ...children];
    return children;
}

interface PortSpec {
    name: string;
    /** A bus's own port: the bundle it draws. */
    bus?: string;
    /** A member of the open bus of that name. */
    memberOf?: string;
}

const spec = (each: string | PortSpec): PortSpec => (typeof each === 'string' ? { name: each } : each);

/**
 * A node of definition `type`, its inputs and outputs given in the order the
 * source declares them, each on the next row, as a model is built.
 */
function node(id: string, type: string, ins: (string | PortSpec)[], outs: (string | PortSpec)[] = [], args: Record<string, unknown> = {}): GNode {
    const n = Object.assign(new GNode(), {
        id,
        type: WorkflowDiagramTypes.NODE_ACTOR,
        position: { x: 0, y: 0 },
        size: { width: 100, height: 200 },
        args: { [WorkflowDiagramMetadata.ENTITY_TYPE]: type, ...args },
        children: [] as GModelElement[]
    });
    const port = (each: PortSpec, input: boolean, row: number): GPort => Object.assign(new GPort(), {
        id: `${id}_${input ? 'in' : 'out'}_${each.name}`,
        type: input ? WorkflowDiagramTypes.PORT_INPUT : WorkflowDiagramTypes.PORT_OUTPUT,
        position: { x: input ? -5 : 95, y: 30 + row * ROW },
        size: { width: 10, height: 10 },
        args: {
            [WorkflowDiagramMetadata.PORT_NAME]: each.name,
            [WorkflowDiagramMetadata.PORT_DIRECTION]: input ? 'input' : 'output',
            ...(each.bus ? { [WorkflowDiagramMetadata.PORT_BUS_GROUP]: each.bus } : {}),
            ...(each.memberOf ? { [WorkflowDiagramMetadata.PORT_BUS_MEMBER_OF]: each.memberOf } : {})
        }
    });
    attach(n, [...ins.map(spec).map((each, k) => port(each, true, k)), ...outs.map(spec).map((each, k) => port(each, false, k))]);
    return n;
}

function graph(...nodes: GNode[]): GGraph {
    const root = Object.assign(new GGraph(), { id: 'g', type: WorkflowDiagramTypes.GRAPH, children: [] as GModelElement[] });
    attach(root, nodes);
    return root;
}

/** The port names of `n`'s inputs, top to bottom, members included. */
function westRows(n: GNode): string[] {
    return (n.children ?? [])
        .filter((child): child is GPort => child instanceof GPort && child.type === WorkflowDiagramTypes.PORT_INPUT)
        .sort((a, b) => a.position!.y - b.position!.y)
        .map(port => String(port.args![WorkflowDiagramMetadata.PORT_NAME]));
}

function rowsOf(root: GModelElement): Map<string, number> {
    const rows = new Map<string, number>();
    const visit = (element: GModelElement): void => {
        if (element instanceof GPort) {
            rows.set(element.id, element.position!.y);
        }
        (element.children ?? []).forEach(visit);
    };
    visit(root);
    return rows;
}

describe('a port order kept with the layout', () => {
    it('draws every instance of a definition in the order kept for it, on the rows it had', () => {
        const a = node('a', 'Stage', ['A', 'B', 'C'], ['Out']);
        const b = node('b', 'Stage', ['A', 'B', 'C'], ['Out']);
        const other = node('o', 'Other', ['A', 'B']);
        const root = graph(a, b, other);
        const rowsBefore = new Set([...rowsOf(a).values()]);
        const reordered = applyKeptPortOrders(root, { [definitionKeyOf(a)!]: { west: ['C', 'A', 'B'] } });
        expect(reordered).toBe(2);
        expect(westRows(a)).toEqual(['C', 'A', 'B']);
        expect(westRows(b)).toEqual(['C', 'A', 'B']);
        expect(westRows(other)).toEqual(['A', 'B']);
        expect(new Set([...rowsOf(a).values()])).toEqual(rowsBefore);
        // The children stay in the source's order: only the rows moved.
        expect(sidesOf(a, 'source').west).toEqual(['A', 'B', 'C']);
        expect(sidesOf(a, 'drawn').west).toEqual(['C', 'A', 'B']);
    });

    it('lets the source\'s order stand where the kept one no longer fits its ports', () => {
        const a = node('a', 'Stage', ['A', 'B', 'C']);
        const root = graph(a);
        // A port renamed since: the key is another, nothing is applied.
        const stale = definitionKeyOf(node('x', 'Stage', ['A', 'B', 'D']))!;
        expect(applyKeptPortOrders(root, { [stale]: { west: ['D', 'B', 'A'] } })).toBe(0);
        // Under its own key, an order that does not name each port once.
        expect(applyKeptPortOrders(root, { [definitionKeyOf(a)!]: { west: ['C', 'A'] } })).toBe(0);
        expect(westRows(a)).toEqual(['A', 'B', 'C']);
    });

    it('says, from the drawing, which orders to keep and which to let go', () => {
        const a = node('a', 'Stage', ['A', 'B']);
        const b = node('b', 'Stage', ['A', 'B']);
        const m = node('m', 'Merge', ['P', 'Q']);
        const split1 = node('s1', 'Split', ['X', 'Y']);
        const split2 = node('s2', 'Split', ['X', 'Y']);
        const root = graph(a, b, m, split1, split2);
        applyKeptPortOrders(root, { [definitionKeyOf(a)!]: { west: ['B', 'A'] } });
        // Two instances of Split drawn in two orders: neither said.
        regridPortRows(split1, ['s1_in_Y', 's1_in_X']);
        const changes = keptPortOrderChanges(root);
        expect(changes.set).toEqual({ [definitionKeyOf(a)!]: { west: ['B', 'A'], east: [] } });
        expect(changes.remove).toEqual([definitionKeyOf(m)!]);

        const elsewhere = definitionKeyOf(node('z', 'Elsewhere', ['U', 'V']))!;
        const kept = withPortOrderChanges({ [definitionKeyOf(m)!]: { west: ['Q', 'P'] }, [elsewhere]: { west: ['V', 'U'] } }, changes);
        // A definition not drawn here is left as the file has it.
        expect(kept).toEqual({ [definitionKeyOf(a)!]: { west: ['B', 'A'], east: [] }, [elsewhere]: { west: ['V', 'U'] } });
    });

    it('moves an open bus with its members, and keys it alike open or closed', () => {
        const open = node('u1', 'Unit', ['clk', { name: 'req', bus: 'req' }, { name: 'req_valid', memberOf: 'req' }, { name: 'req_data', memberOf: 'req' }, 'rst']);
        const closed = node('u2', 'Unit', ['clk', { name: 'req', bus: 'req' }, 'rst']);
        expect(definitionKeyOf(open)).toBe(definitionKeyOf(closed));
        expect(sidesOf(open, 'source').west).toEqual(['clk', 'req', 'rst']);

        const root = graph(open, closed);
        expect(applyKeptPortOrders(root, { [definitionKeyOf(open)!]: { west: ['req', 'rst', 'clk'] } })).toBe(2);
        expect(westRows(open)).toEqual(['req', 'req_valid', 'req_data', 'rst', 'clk']);
        expect(westRows(closed)).toEqual(['req', 'rst', 'clk']);
        expect(keptPortOrderChanges(root).set).toEqual({ [definitionKeyOf(open)!]: { west: ['req', 'rst', 'clk'], east: [] } });
    });

    it('keeps an open bus\'s members under it whatever order Free Ports found for them', () => {
        const open = node('u', 'Unit', ['clk', { name: 'req', bus: 'req' }, { name: 'req_valid', memberOf: 'req' }, { name: 'req_data', memberOf: 'req' }]);
        // The probe put a member above the clock and its bus below.
        regridPortRows(open, ['u_in_req_data', 'u_in_clk', 'u_in_req', 'u_in_req_valid']);
        expect(westRows(open)).toEqual(['clk', 'req', 'req_valid', 'req_data']);
    });

    it('leaves a cell drawn as its symbol as the symbol has it', () => {
        const mux = node('mux', 'Mux', ['in0', 'in1', 'sel'], ['out'], { [WorkflowDiagramMetadata.SYMBOL]: 'mux' });
        expect(portsMayReorder(mux)).toBe(false);
        const root = graph(mux, node('mux2', 'Mux', ['in0', 'in1', 'sel'], ['out'], { [WorkflowDiagramMetadata.SYMBOL]: 'mux' }));
        expect(applyKeptPortOrders(root, { [definitionKeyOf(mux)!]: { west: ['sel', 'in1', 'in0'] } })).toBe(0);
        expect(keptPortOrderChanges(root)).toEqual({ set: {}, remove: [] });
    });

    it('draws every node in the source\'s order again, an open bus with its members', () => {
        const open = node('u', 'Unit', ['clk', { name: 'req', bus: 'req' }, { name: 'req_valid', memberOf: 'req' }, 'rst']);
        const stage = node('s', 'Stage', ['A', 'B', 'C']);
        const mux = node('mux', 'Mux', ['in0', 'in1', 'sel'], ['out'], { [WorkflowDiagramMetadata.SYMBOL]: 'mux' });
        const root = graph(open, stage, mux);
        const muxRows = rowsOf(mux);
        applyKeptPortOrders(root, { [definitionKeyOf(open)!]: { west: ['rst', 'req', 'clk'] }, [definitionKeyOf(stage)!]: { west: ['C', 'B', 'A'] } });
        expect(westRows(open)).toEqual(['rst', 'req', 'req_valid', 'clk']);
        drawInSourceOrder(root);
        expect(westRows(open)).toEqual(['clk', 'req', 'req_valid', 'rst']);
        expect(westRows(stage)).toEqual(['A', 'B', 'C']);
        expect(rowsOf(mux)).toEqual(muxRows);
        expect(keptPortOrderChanges(root)).toEqual({ set: {}, remove: [definitionKeyOf(open)!, definitionKeyOf(stage)!] });
    });

    it('says nothing of two definitions taken for one that declare their ports in two orders', () => {
        // One name, the same ports, no file said: one key for both.
        const a = node('a', 'Stage', ['A', 'B']);
        const b = node('b', 'Stage', ['B', 'A']);
        expect(definitionKeyOf(a)).toBe(definitionKeyOf(b));
        expect(keptPortOrderChanges(graph(a, b))).toEqual({ set: {}, remove: [] });
    });

    it('reads only well-formed orders from a layout file', () => {
        expect(keptPortOrdersOf(undefined)).toBeUndefined();
        expect(keptPortOrdersOf([])).toBeUndefined();
        expect(keptPortOrdersOf({ k: { west: ['A'], east: 'B' }, j: { north: ['X'] }, l: 3 })).toEqual({ k: { west: ['A'] } });
    });
});
