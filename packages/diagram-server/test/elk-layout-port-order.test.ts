import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ELK from 'elkjs/lib/elk.bundled.js';
import { GEdge, GGraph, GNode, GPort } from '@eclipse-glsp/server';
import { DefaultElementFilter } from '@eclipse-glsp/layout-elk';
import { WorkflowDiagramTypes } from '@dialogram/shared';
import { PORT_ORDER_FREE, PORT_ORDER_OPTION, WorkflowElkLayoutEngine } from '../src/server/elk-layout-engine';
import { UNTANGLED_ELK_OPTIONS } from '../src/operations/layout-tuned-handler';
import { WorkflowLayoutConfigurator } from '../src/server/layout-configurator';
import { GraphGModelSource, type PyGraphDocument } from '../src/model/graph-gmodel-source';
import { convertToGModelRoot } from '../src/server/gmodel-convert';
import { edgeCrossings as crossings } from '../src/model/edge-crossings';
import { PORT_ORDERS_OPTION, definitionKeyOf, portNameOf } from '../src/model/definition-port-order';

/**
 * Ports sit on a grid in the order the source declares them and ELK may not
 * move them, so on a dense graph that order is what tangles the edges. The
 * default layout keeps it. The Untangled layout keeps it too and tunes ELK's
 * crossing minimisation; the Free Ports layout asks the engine to choose the
 * order first, by a probe layout with FIXED_SIDE, and puts the ports back on
 * their rows in that order, one order for all the instances of a definition
 * (the flow has four of each of five). These tests run the real ELK on the real
 * speculation flow of chips/workflow (40 nodes, 106 edges), exported by
 * `wfpy plan --format graph`, and count the crossings of the routed edges.
 */
type Point = { x: number; y: number };

function find(element: any, id: string): any {
    if (!element) {
        return undefined;
    }
    if (element.id === id) {
        return element;
    }
    for (const child of element.children ?? []) {
        const hit = find(child, id);
        if (hit) {
            return hit;
        }
    }
    return undefined;
}

function collect<T>(element: any, cls: any, out: T[] = []): T[] {
    if (element instanceof cls) {
        out.push(element);
    }
    for (const child of element.children ?? []) {
        collect(child, cls, out);
    }
    return out;
}

/** The nodes of `root` by what they are an instance of. */
function instancesByDefinition(root: GGraph): Map<string, GNode[]> {
    const groups = new Map<string, GNode[]>();
    for (const node of collect<GNode>(root, GNode)) {
        const key = definitionKeyOf(node);
        if (key !== undefined) {
            groups.set(key, [...(groups.get(key) ?? []), node]);
        }
    }
    return groups;
}

/** A node's port names, top to bottom, on each side. */
function drawnOrder(node: GNode): { west: string[]; east: string[] } {
    const ports = collect<GPort>(node, GPort).filter(p => p.parent === node).sort((a, b) => a.position!.y - b.position!.y);
    const names = (input: boolean): string[] =>
        ports.filter(p => (p.type === WorkflowDiagramTypes.PORT_INPUT) === input).map(p => portNameOf(node, p));
    return { west: names(true), east: names(false) };
}

function loadFixture(): GGraph {
    const doc = JSON.parse(readFileSync(join(__dirname, 'fixtures-speculation-flow.json'), 'utf8')) as PyGraphDocument;
    return convertToGModelRoot(new GraphGModelSource({} as any).transform(doc) as any) as unknown as GGraph;
}

function declaredOrder(root: GGraph): Map<string, number> {
    const rows = new Map<string, number>();
    for (const port of collect<GPort>(root, GPort)) {
        rows.set(port.id, port.position!.y);
    }
    return rows;
}

async function layoutFixture(options: Record<string, string> = {}, root: GGraph = loadFixture()): Promise<{ root: GGraph; declared: Map<string, number> }> {
    const declared = declaredOrder(root);
    (root as any).layoutOptions = { ...options };
    const modelState: any = {
        root,
        index: { get: (id: string) => find(root, id), findByClass: (id: string) => find(root, id) }
    };
    const engine = new WorkflowElkLayoutEngine(
        () => new (ELK as any)({ algorithms: ['layered'] }),
        new DefaultElementFilter(),
        new WorkflowLayoutConfigurator(),
        modelState
    );
    await engine.layout();
    return { root, declared };
}

describe('WorkflowElkLayoutEngine port order', () => {
    it('keeps every port in the declared order by default, and under the Untangled options', async () => {
        for (const options of [{}, UNTANGLED_ELK_OPTIONS]) {
            const { root, declared } = await layoutFixture(options);
            for (const port of collect<GPort>(root, GPort)) {
                expect(port.position!.y).toBe(declared.get(port.id));
            }
        }
    });

    it('keeps every port on a server row, on its side, and every edge attached under Free Ports', async () => {
        const { root, declared } = await layoutFixture({ [PORT_ORDER_OPTION]: PORT_ORDER_FREE });
        for (const node of collect<GNode>(root, GNode)) {
            const ports = collect<GPort>(node, GPort).filter(p => p.parent === node);
            for (const input of [true, false]) {
                const side = ports.filter(p => (p.type === WorkflowDiagramTypes.PORT_INPUT) === input);
                const rows = side.map(p => p.position!.y).sort((a, b) => a - b);
                const before = side.map(p => declared.get(p.id)!).sort((a, b) => a - b);
                expect(rows).toEqual(before); // the same rows, permuted at most
            }
        }
        for (const edge of collect<GEdge>(root, GEdge)) {
            expect(((edge as any).routingPoints as Point[]).length).toBeGreaterThanOrEqual(2);
        }
    });

    it('puts every port back on its declared row when a plain layout follows Free Ports', async () => {
        const root = loadFixture();
        const declared = declaredOrder(root);
        await layoutFixture({ [PORT_ORDER_OPTION]: PORT_ORDER_FREE }, root);
        const moved = collect<GPort>(root, GPort).filter(p => p.position!.y !== declared.get(p.id)).length;
        expect(moved).toBeGreaterThan(0);
        await layoutFixture({}, root);
        for (const port of collect<GPort>(root, GPort)) {
            expect(port.position!.y).toBe(declared.get(port.id));
        }
        for (const edge of collect<GEdge>(root, GEdge)) {
            expect(((edge as any).routingPoints as Point[]).length).toBeGreaterThanOrEqual(2);
        }
    });

    it('gives all the instances of a definition one port order under Free Ports', async () => {
        const { root } = await layoutFixture({ ...UNTANGLED_ELK_OPTIONS, [PORT_ORDER_OPTION]: PORT_ORDER_FREE });
        const groups = instancesByDefinition(root);
        expect([...groups.values()].filter(nodes => nodes.length > 1).length).toBeGreaterThanOrEqual(4);
        for (const nodes of groups.values()) {
            const orders = nodes.map(drawnOrder);
            for (const order of orders) {
                expect(order).toEqual(orders[0]);
            }
        }
    });

    it('puts the order given for a definition on each of its instances', async () => {
        const root = loadFixture();
        const [key, nodes] = [...instancesByDefinition(root)].find(([, group]) => group[0].args?.['cal:entityType'] === 'ProgramRound')!;
        expect(nodes.length).toBe(4);
        const declared = drawnOrder(nodes[0]);
        const reversed = { west: [...declared.west].reverse(), east: [...declared.east].reverse() };
        await layoutFixture({ [PORT_ORDER_OPTION]: PORT_ORDER_FREE, [PORT_ORDERS_OPTION]: JSON.stringify({ [key]: reversed }) }, root);
        for (const node of nodes) {
            expect(drawnOrder(node)).toEqual(reversed);
        }
    });

    it('crosses fewer edges: Untangled under the declared order, Free Ports under its own', async () => {
        const declared = crossings((await layoutFixture()).root);
        const untangled = crossings((await layoutFixture(UNTANGLED_ELK_OPTIONS)).root);
        const free = crossings((await layoutFixture({ ...UNTANGLED_ELK_OPTIONS, [PORT_ORDER_OPTION]: PORT_ORDER_FREE })).root);
        console.info(`[port-order] crossings: declared ${declared}, untangled ${untangled}, free ports ${free}`);
        expect(untangled).toBeLessThan(declared);
        expect(free).toBeLessThan(untangled);
    });
});
