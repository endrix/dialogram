import { describe, expect, it } from 'vitest';
import { GNode, GPort } from '@eclipse-glsp/server';
import { WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import {
    PORT_ORDERS_OPTION, definitionKeyOf, givenPortOrders, onePortOrderPerDefinition, orderBySides, type ProbedOrder
} from '../src/model/definition-port-order';

/** A node of definition `type` with input ports `ins` and output ports `outs`, in that order. */
function node(id: string, type: string | undefined, ins: string[], outs: string[], file?: string): GNode {
    const n = Object.assign(new GNode(), {
        id,
        args: {
            ...(type ? { [WorkflowDiagramMetadata.ENTITY_TYPE]: type } : {}),
            ...(file ? { [WorkflowDiagramMetadata.REFERENCED_URI]: file, [WorkflowDiagramMetadata.REFERENCED_IS_DEFINITION]: true } : {})
        },
        children: [] as GPort[]
    });
    const port = (name: string, input: boolean): GPort => Object.assign(new GPort(), {
        id: `${id}_port_${name}`,
        type: input ? WorkflowDiagramTypes.PORT_INPUT : WorkflowDiagramTypes.PORT_OUTPUT,
        args: {
            [WorkflowDiagramMetadata.PORT_NAME]: name,
            [WorkflowDiagramMetadata.PORT_DIRECTION]: input ? 'input' : 'output'
        },
        parent: n
    });
    n.children = [...ins.map(name => port(name, true)), ...outs.map(name => port(name, false))];
    return n;
}

/** Probed `n` with its ports top to bottom as `names` say, and `edges` edges. */
function probed(n: GNode, names: string[], edges = 1): ProbedOrder {
    return { node: n, order: names.map(name => `${n.id}_port_${name}`), edges };
}

/** The port names of `order` (ids of `n`'s ports); an output named like an input is `name>`. */
const namesIn = (n: GNode, order: string[] | undefined): string[] | undefined =>
    order?.map(id => id.slice(`${n.id}_port_`.length));

describe('definition port order', () => {
    it('keys a node by its definition, its file and its ports', () => {
        const a = node('a', 'Round', ['Image', 'Model'], ['Program']);
        const b = node('b', 'Round', ['Model', 'Image'], ['Program']);
        expect(definitionKeyOf(a)).toBe(definitionKeyOf(b));
        expect(definitionKeyOf(node('c', 'Round', ['Image'], ['Program']))).not.toBe(definitionKeyOf(a));
        expect(definitionKeyOf(node('d', 'Round', ['Image', 'Model'], ['Program'], 'file:///x.py'))).not.toBe(definitionKeyOf(a));
        expect(definitionKeyOf(node('e', undefined, ['Image'], []))).toBeUndefined();
    });

    it('orders a side by names only when they are exactly its ports', () => {
        const a = node('a', 'Round', ['Image', 'Model'], ['Program', 'Name']);
        expect(namesIn(a, orderBySides(a, { west: ['Model', 'Image'], east: ['Name', 'Program'] })))
            .toEqual(['Model', 'Image', 'Name', 'Program']);
        // A side not listed keeps the fallback's order.
        expect(namesIn(a, orderBySides(a, { west: ['Model', 'Image'] }, ['a_port_Name', 'a_port_Program'])))
            .toEqual(['Model', 'Image', 'Name', 'Program']);
        expect(orderBySides(a, { west: ['Model'] })).toBeUndefined();
        expect(orderBySides(a, { west: ['Model', 'Image', 'Extra'] })).toBeUndefined();
        expect(orderBySides(a, { west: ['Model', 'Model'] })).toBeUndefined();
        expect(orderBySides(a, { west: ['Model', 'Program'] })).toBeUndefined();
    });

    it('gives one order to the instances of a definition with an input and an output of one name', () => {
        // Ids must differ: the output's is under `data>`.
        const make = (id: string): GNode => {
            const n = node(id, 'Pass', ['data', 'cfg'], ['data2']);
            const out = n.children[2] as GPort;
            out.id = `${id}_port_data>`;
            (out.args as Record<string, unknown>)[WorkflowDiagramMetadata.PORT_NAME] = 'data';
            return n;
        };
        const a = make('a');
        const b = make('b');
        const { orders, shared } = onePortOrderPerDefinition([
            { node: a, order: ['a_port_cfg', 'a_port_data>', 'a_port_data'], edges: 5 },
            { node: b, order: ['b_port_data', 'b_port_data>', 'b_port_cfg'], edges: 1 }
        ]);
        expect(shared.has(a) && shared.has(b)).toBe(true);
        expect(namesIn(a, orders.get(a))).toEqual(['cfg', 'data', 'data>']);
        expect(namesIn(b, orders.get(b))).toEqual(['cfg', 'data', 'data>']);
    });

    it('gives the instances of a definition one order, each port at its mean place', () => {
        const a = node('a', 'Round', ['I1', 'I2', 'I3'], []);
        const b = node('b', 'Round', ['I1', 'I2', 'I3'], []);
        const c = node('c', 'Round', ['I1', 'I2', 'I3'], []);
        const lone = node('lone', 'Other', ['X', 'Y'], []);
        const { orders, shared } = onePortOrderPerDefinition([
            probed(a, ['I3', 'I1', 'I2'], 3),
            probed(b, ['I3', 'I2', 'I1']),
            probed(c, ['I1', 'I3', 'I2']),
            probed(lone, ['Y', 'X'])
        ]);
        for (const n of [a, b, c]) {
            expect(namesIn(n, orders.get(n))).toEqual(['I3', 'I1', 'I2']);
            expect(shared.has(n)).toBe(true);
        }
        expect(namesIn(lone, orders.get(lone))).toEqual(['Y', 'X']);
        expect(shared.has(lone)).toBe(false);
    });

    it('puts the order given for a definition on its instances, even a lone one', () => {
        const a = node('a', 'Round', ['I1', 'I2'], []);
        const lone = node('lone', 'Other', ['X', 'Y'], []);
        const given = givenPortOrders({
            [PORT_ORDERS_OPTION]: JSON.stringify({
                [definitionKeyOf(a)!]: { west: ['I2', 'I1'] },
                Other: { west: ['Y', 'X'] },
                Missing: { west: ['Q'] }
            })
        });
        const { orders, shared, unmatched } = onePortOrderPerDefinition([probed(a, ['I1', 'I2']), probed(lone, ['X', 'Y'])], given);
        expect(namesIn(a, orders.get(a))).toEqual(['I2', 'I1']);
        // Named by its definition's name alone.
        expect(namesIn(lone, orders.get(lone))).toEqual(['Y', 'X']);
        expect(shared.has(lone)).toBe(true);
        expect(unmatched).toEqual(['Missing']);
    });

    it('reads no orders out of an option that is not a JSON object of name lists', () => {
        expect(givenPortOrders(undefined)).toEqual({});
        expect(givenPortOrders({ [PORT_ORDERS_OPTION]: 'not json' })).toEqual({});
        expect(givenPortOrders({ [PORT_ORDERS_OPTION]: '["a"]' })).toEqual({});
        expect(givenPortOrders({ [PORT_ORDERS_OPTION]: '{"k":{"west":["a",1]},"j":{"east":["b"]},"l":["c"]}' }))
            .toEqual({ j: { east: ['b'] } });
    });
});
