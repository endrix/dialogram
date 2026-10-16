import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ELK from 'elkjs/lib/elk.bundled.js';
import { GEdge, GGraph, GModelElement, GNode, GPort } from '@eclipse-glsp/server';
import { DefaultElementFilter } from '@eclipse-glsp/layout-elk';
import { WorkflowDiagramTypes } from '@dialogram/shared';
import { PORT_ORDER_FREE, PORT_ORDER_OPTION, WorkflowElkLayoutEngine } from '../src/server/elk-layout-engine';
import { UNTANGLED_ELK_OPTIONS } from '../src/operations/layout-tuned-handler';
import { WorkflowLayoutConfigurator } from '../src/server/layout-configurator';
import { GraphGModelSource, type PyGraphDocument } from '../src/model/graph-gmodel-source';
import { convertToGModelRoot } from '../src/server/gmodel-convert';

/**
 * Ports sit on a grid in the order the source declares them and ELK may not
 * move them, so on a dense graph that order is what tangles the edges. The
 * default layout keeps it. The Untangled layout keeps it too and tunes ELK's
 * crossing minimisation; the Free Ports layout asks the engine to choose the
 * order first, by a probe layout with FIXED_SIDE, and puts the ports back on
 * their rows in that order. These tests run the real ELK on the real
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

function absolute(element: GModelElement | undefined): Point {
    let x = 0;
    let y = 0;
    let current: any = element;
    while (current) {
        if (current.position) {
            x += current.position.x ?? 0;
            y += current.position.y ?? 0;
        }
        current = current.parent;
    }
    return { x, y };
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

async function layoutFixture(options: Record<string, string> = {}): Promise<{ root: GGraph; declared: Map<string, number> }> {
    const root = loadFixture();
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

/** Proper crossings between the segments of distinct routed edges. */
function crossings(root: GGraph): number {
    const polylines = collect<GEdge>(root, GEdge)
        .map(edge => {
            const pts = ((edge as any).routingPoints ?? []) as Point[];
            const src = absolute(find(root, edge.sourceId));
            const tgt = absolute(find(root, edge.targetId));
            return [src, ...pts, tgt];
        })
        .filter(pts => pts.length >= 2);
    const orient = (a: Point, b: Point, c: Point): number => Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
    const cross = (a: Point, b: Point, c: Point, d: Point): boolean => {
        const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
        return o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0 && o1 !== o2 && o3 !== o4;
    };
    let n = 0;
    for (let i = 0; i < polylines.length; i++) {
        for (let j = i + 1; j < polylines.length; j++) {
            const p = polylines[i], q = polylines[j];
            for (let a = 0; a + 1 < p.length; a++) {
                for (let b = 0; b + 1 < q.length; b++) {
                    if (cross(p[a], p[a + 1], q[b], q[b + 1])) {
                        n++;
                    }
                }
            }
        }
    }
    return n;
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

    it('crosses fewer edges: Untangled under the declared order, Free Ports under its own', async () => {
        const declared = crossings((await layoutFixture()).root);
        const untangled = crossings((await layoutFixture(UNTANGLED_ELK_OPTIONS)).root);
        const free = crossings((await layoutFixture({ ...UNTANGLED_ELK_OPTIONS, [PORT_ORDER_OPTION]: PORT_ORDER_FREE })).root);
        console.info(`[port-order] crossings: declared ${declared}, untangled ${untangled}, free ports ${free}`);
        expect(untangled).toBeLessThan(declared);
        expect(free).toBeLessThan(untangled);
    });
});
