import { describe, expect, it } from 'vitest';
import ELK from 'elkjs/lib/elk.bundled.js';
import { GEdge, GGraph, GLabel, GModelElement, GNode, GPort } from '@eclipse-glsp/server';
import { DefaultElementFilter } from '@eclipse-glsp/layout-elk';
import { WorkflowDiagramConstants, WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import { WorkflowElkLayoutEngine } from '../src/server/elk-layout-engine';
import { WorkflowLayoutConfigurator } from '../src/server/layout-configurator';

/**
 * Every node type declares `elk.portConstraints: FIXED_POS`, so ELK must not move ports — but it
 * does not return them untouched. It re-centres a port on a whole-pixel routing lane, so a port
 * of odd height (PORT_HEIGHT_PX is 7) comes back at y + 0.5. Writing that back left a freshly
 * laid-out diagram half a pixel off every later open of the SAME layout, because a reopen skips
 * ELK and re-places ports at the server coordinates — a visible twitch on every reload.
 *
 * These tests run the real ELK against the real configurator.
 */
const PORT_W = WorkflowDiagramConstants.PORT_WIDTH_PX;
const PORT_H = WorkflowDiagramConstants.PORT_HEIGHT_PX;
const NODE_W = 140;
const PORT_Y = [30, 51, 72];

function buildPort(id: string, direction: 'input' | 'output', x: number, y: number, text: string): GPort {
    const label = GLabel.builder()
        .id(`${id}_label`)
        .type(WorkflowDiagramTypes.LABEL_PORT)
        .text(text)
        .size(Math.ceil(text.length * 8.4 + 6), 15)
        .build();
    const port = GPort.builder()
        .id(id)
        .type(direction === 'output' ? WorkflowDiagramTypes.PORT_OUTPUT : WorkflowDiagramTypes.PORT_INPUT)
        .position(x, y)
        .size(PORT_W, PORT_H)
        .addChildren(label)
        .build();
    port.args = { [WorkflowDiagramMetadata.PORT_DIRECTION]: direction };
    return port;
}

function buildActor(id: string, inputs: string[], outputs: string[]): GNode {
    const ports = [
        ...inputs.map((name, i) => buildPort(`${id}|in|${name}`, 'input', -PORT_W, PORT_Y[i], name)),
        ...outputs.map((name, i) => buildPort(`${id}|out|${name}`, 'output', NODE_W, PORT_Y[i], name))
    ];
    const node = GNode.builder()
        .id(id)
        .type(WorkflowDiagramTypes.NODE_ACTOR)
        .size(NODE_W, 100)
        .addChildren(...ports)
        .build();
    (node as any).layoutOptions = { 'elk.portConstraints': 'FIXED_POS' };
    return node;
}

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

function collectPorts(element: any, out: GPort[] = []): GPort[] {
    if (element instanceof GPort) {
        out.push(element);
    }
    for (const child of element.children ?? []) {
        collectPorts(child, out);
    }
    return out;
}

function absolutePosition(element: GModelElement | undefined): { x: number; y: number } {
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

async function layoutFixture(): Promise<{ root: GGraph; edgeIds: string[] }> {
    const framebuf = buildActor('framebuf', ['BTYPE', 'MV', 'WD'], ['halfpel', 'RD']);
    const interpolation = buildActor('interpolation', ['halfpel', 'RD'], ['MOT']);
    const add = buildActor('add', ['BTYPE', 'MOT', 'TEX'], ['VID']);

    const edge = (id: string, sourceId: string, targetId: string): GEdge =>
        GEdge.builder().id(id).sourceId(sourceId).targetId(targetId).build();

    const edges = [
        edge('e1', 'framebuf|out|halfpel', 'interpolation|in|halfpel'),
        edge('e2', 'framebuf|out|RD', 'interpolation|in|RD'),
        edge('e3', 'interpolation|out|MOT', 'add|in|MOT'),
        edge('e4', 'add|out|VID', 'framebuf|in|WD')
    ];

    const root = GGraph.builder().id('root').addChildren(framebuf, interpolation, add, ...edges).build();
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

    return { root, edgeIds: edges.map(e => e.id) };
}

describe('WorkflowElkLayoutEngine port stability', () => {
    it('leaves server-placed port positions exactly as ELK received them', async () => {
        const { root } = await layoutFixture();

        for (const port of collectPorts(root)) {
            const direction = (port as any).args?.[WorkflowDiagramMetadata.PORT_DIRECTION];
            const expectedX = direction === 'output' ? NODE_W : -PORT_W;
            expect(PORT_Y).toContain(port.position!.y); // no half-pixel drift
            expect(port.position!.x).toBe(expectedX);
            expect(port.size).toEqual({ width: PORT_W, height: PORT_H });
        }
    });

    it('attaches every routed edge exactly to its source and target port anchors', async () => {
        const { root, edgeIds } = await layoutFixture();

        for (const id of edgeIds) {
            const edge: any = find(root, id);
            const points = edge.routingPoints as { x: number; y: number }[];
            expect(points.length).toBeGreaterThanOrEqual(2);

            for (const [portId, point] of [
                [edge.sourceId, points[0]] as const,
                [edge.targetId, points[points.length - 1]] as const
            ]) {
                const port: any = find(root, portId);
                const abs = absolutePosition(port);
                const isOutput = port.args?.[WorkflowDiagramMetadata.PORT_DIRECTION] === 'output';
                expect(point).toEqual({
                    x: isOutput ? abs.x + PORT_W : abs.x,
                    y: abs.y + PORT_H / 2
                });
            }
        }
    });

    it('still lets ELK position and size the nodes', async () => {
        const { root } = await layoutFixture();

        const positions = ['framebuf', 'interpolation', 'add'].map(id => find(root, id).position.x);
        // Laid out left-to-right in distinct layers, so ELK clearly ran.
        expect(positions[0]).toBeLessThan(positions[1]);
        expect(positions[1]).toBeLessThan(positions[2]);
        expect(find(root, 'framebuf').size).toEqual({ width: NODE_W, height: 100 });
    });
});
