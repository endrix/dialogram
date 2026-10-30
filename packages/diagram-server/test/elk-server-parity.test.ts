/**
 * The shipped ELK server and the platform's elkjs lay a graph out alike.
 *
 * A layout goes to the server past a size and to elkjs below it, so a product
 * sees whichever engine took the graph; two engines that disagree would move a
 * diagram's nodes as it grows past the threshold. The server is built on the
 * ELK release elkjs is (ELK 0.10.0 and elkjs 0.10.0, see `elk-server/`): elkjs
 * 0.9.x matched no ELK release, and the server's ELK 0.8.1 placed these two
 * documents' nodes in another order.
 *
 * The graphs are the ones the platform's layout engine builds for two real
 * documents, the two that told the engines apart: a specification document in
 * two layer groups (`ndf diagram --group refinement`, outline and panel text
 * trimmed) and an HDL module with glue logic (hdl-sidecar's `glue` golden).
 * Each is laid out by elkjs and by the jar through the platform's own client
 * (gzip-framed), and every node, port and route must match.
 *
 * Raising elkjs means rebuilding the jar on the same ELK; this test fails until
 * both are raised.
 */
import 'reflect-metadata';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import ElkConstructor from 'elkjs/lib/elk.bundled.js';
import type { ElkNode } from 'elkjs';
import { DefaultElementFilter } from '@eclipse-glsp/layout-elk';
import { layoutOnServer } from '../src/server/elk-server/elk-server-client';
import { ElkServerProcess } from '../src/server/elk-server/elk-server-process';
import { GraphGModelSource } from '../src/model/graph-gmodel-source';
import { convertToGModelRoot } from '../src/server/gmodel-convert';
import { WorkflowElkLayoutEngine } from '../src/server/elk-layout-engine';
import { WorkflowLayoutConfigurator } from '../src/server/layout-configurator';
import { javaMajor } from './java-version';

const JAR = path.resolve(__dirname, '../resources/elk-server/elk-server-0.3.0-all.jar');
const FIXTURES = path.resolve(__dirname, 'fixtures/elk-parity');

/** The ELK graphs the platform's layout engine asks a layout of, for a graph document. */
async function elkInputs(document: unknown): Promise<ElkNode[]> {
    const root: any = convertToGModelRoot(new GraphGModelSource().transform(document as any) as any);
    const byId = new Map<string, any>();
    const index = (element: any): void => {
        byId.set(element.id, element);
        (element.children ?? []).forEach(index);
    };
    index(root);
    const modelState: any = { root, index: { get: (id: string) => byId.get(id), findByClass: (id: string) => byId.get(id) } };
    const elkjs = new (ElkConstructor as any)({ algorithms: ['layered'] });
    const captured: ElkNode[] = [];
    const capturing = {
        ...elkjs,
        layout: (graph: ElkNode, args?: unknown) => {
            captured.push(JSON.parse(JSON.stringify(graph)));
            return elkjs.layout(graph, args);
        },
        terminateWorker: () => undefined
    };
    const engine = new WorkflowElkLayoutEngine(() => capturing as any, new DefaultElementFilter(), new WorkflowLayoutConfigurator(), modelState);
    await engine.layout();
    return captured;
}

/** Element id to the numbers that place it: x, y, width and height, or an edge's route. */
function placements(node: any, out: Record<string, number[]> = {}): Record<string, number[]> {
    const shape = (element: any): number[] => [element.x ?? 0, element.y ?? 0, element.width ?? 0, element.height ?? 0];
    out[node.id] = shape(node);
    for (const port of node.ports ?? []) {
        out[port.id] = shape(port);
    }
    for (const label of node.labels ?? []) {
        if (label.id) {
            out[label.id] = shape(label);
        }
    }
    for (const edge of node.edges ?? []) {
        const section = edge.sections?.[0];
        out[edge.id] = section
            ? [section.startPoint.x, section.startPoint.y, ...(section.bendPoints ?? []).flatMap((p: any) => [p.x, p.y]), section.endPoint.x, section.endPoint.y]
            : [];
    }
    for (const child of node.children ?? []) {
        placements(child, out);
    }
    return out;
}

/** Rounded to a thousandth of a pixel, so the comparison reads in a diff. */
function rounded(placed: Record<string, number[]>): Record<string, number[]> {
    return Object.fromEntries(Object.entries(placed).map(([id, numbers]) => [id, numbers.map(n => Math.round(n * 1000) / 1000)]));
}

describe.skipIf(javaMajor() < 17 || !existsSync(JAR))('the shipped ELK server and elkjs', () => {
    it.each(['ndf-trap.json', 'hdl-glue.json'])('lay %s out alike, node for node and route for route', async fixture => {
        const inputs = await elkInputs(JSON.parse(readFileSync(path.join(FIXTURES, fixture), 'utf8')));
        expect(inputs.length).toBeGreaterThan(0);
        const server = new ElkServerProcess({ jar: JAR, javaOpts: '-Xmx512m' });
        try {
            const port = await server.ensureStarted();
            expect(port, 'the server started').toBeDefined();
            for (const input of inputs) {
                const elkjs = new (ElkConstructor as any)({ algorithms: ['layered'] });
                const byElkjs = rounded(placements(await elkjs.layout(JSON.parse(JSON.stringify(input)))));
                const byServer = rounded(placements(await layoutOnServer(port!, JSON.parse(JSON.stringify(input)), 60_000)));
                expect(byServer).toEqual(byElkjs);
            }
        } finally {
            server.dispose();
        }
    }, 120_000);
});
