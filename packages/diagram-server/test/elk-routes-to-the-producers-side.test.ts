/**
 * A wire reaches a port from the side the producer put it on.
 *
 * A handshake's `ready` answers backwards: the boundary output sits in the
 * west margin beside the `valid` it answers, its glyph faces east, and the
 * wire from the instance should arrive from the east in one straight run.
 * ELK was told the side from the direction alone, so it routed the wire
 * around the far west and in through the node, across the label. This pins
 * the route ELK gives, on the layout the server really runs.
 */
import { describe, expect, it } from 'vitest';
import ELK from 'elkjs/lib/elk.bundled.js';
import { GEdge, GGraph, GNode } from '@eclipse-glsp/server';
import { DefaultElementFilter } from '@eclipse-glsp/layout-elk';
import { WorkflowElkLayoutEngine } from '../src/server/elk-layout-engine';
import { WorkflowLayoutConfigurator } from '../src/server/layout-configurator';
import { GraphGModelSource, type PyGraphDocument } from '../src/model/graph-gmodel-source';
import { convertToGModelRoot } from '../src/server/gmodel-convert';

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

const DOC: PyGraphDocument = {
    version: '1.1',
    graph: {
        id: 'wf:top',
        nodes: [
            { id: 'wf:input:valid', kind: 'wf-input', label: 'valid', scope: 'scope:root',
              ports: [{ id: 'p:valid', name: 'valid', direction: 'out', type: 'logic', group: 's' }] },
            { id: 'wf:output:ready', kind: 'wf-output', label: 'ready', scope: 'scope:root', meta: { side: 'west' },
              ports: [{ id: 'p:ready', name: 'ready', direction: 'in', type: 'logic', side: 'east', group: 's' }] },
            { id: 'wf:input:m_ready', kind: 'wf-input', label: 'm_ready', scope: 'scope:root', meta: { side: 'east' },
              ports: [{ id: 'p:m_ready', name: 'm_ready', direction: 'out', type: 'logic', side: 'west', group: 'm' }] },
            { id: 'wf:output:m_valid', kind: 'wf-output', label: 'm_valid', scope: 'scope:root',
              ports: [{ id: 'p:m_valid', name: 'm_valid', direction: 'in', type: 'logic', group: 'm' }] },
            { id: 'node:u', kind: 'instance', label: 'u', type: 'stage', scope: 'scope:root',
              ports: [
                  { id: 'p:u:in_valid', name: 'in_valid', direction: 'in', type: 'logic', group: 'in' },
                  { id: 'p:u:in_ready', name: 'in_ready', direction: 'out', type: 'logic', group: 'in', side: 'west' },
                  { id: 'p:u:out_valid', name: 'out_valid', direction: 'out', type: 'logic', group: 'out' },
                  { id: 'p:u:out_ready', name: 'out_ready', direction: 'in', type: 'logic', group: 'out', side: 'east' }
              ] }
        ],
        edges: [
            { id: 'e1', from: 'p:valid', to: 'p:u:in_valid', scope: 'scope:root' },
            { id: 'e2', from: 'p:u:in_ready', to: 'p:ready', scope: 'scope:root' },
            { id: 'e3', from: 'p:u:out_valid', to: 'p:m_valid', scope: 'scope:root' },
            { id: 'e4', from: 'p:m_ready', to: 'p:u:out_ready', scope: 'scope:root' }
        ]
    }
};

async function layout(): Promise<GGraph> {
    const root = convertToGModelRoot(new GraphGModelSource({} as any).transform(DOC) as any) as unknown as GGraph;
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
    return root;
}

describe('a ready wire reaches its boundary port from the side the glyph faces', () => {
    it('west margin: the wire arrives from the east, and the port column is one', async () => {
        const root = await layout();
        const nodes = collect<GNode>(root, GNode);
        const ready = nodes.find(n => n.id === 'ready')!;
        const valid = nodes.find(n => n.id === 'valid')!;
        const u = nodes.find(n => n.id === 'u')!;
        expect(Math.abs(ready.position.x - valid.position.x)).toBeLessThanOrEqual(10); // one column, west margin
        expect(u.position.x).toBeGreaterThan(ready.position.x + ready.size.width);
        const edge = collect<GEdge>(root, GEdge).find(e => e.targetId === 'ready_port_ready')!;
        const route = ((edge as any).routingPoints ?? []) as Array<{ x: number; y: number }>;
        const glyphTip = ready.position.x + ready.size.width;
        // Every point of the route is east of the glyph: nothing runs across the node.
        expect(route.length).toBeGreaterThanOrEqual(2);
        for (const p of route) {
            expect(p.x).toBeGreaterThanOrEqual(glyphTip - 1);
        }
    });

    it('east margin: the wire leaves westward', async () => {
        const root = await layout();
        const nodes = collect<GNode>(root, GNode);
        const mReady = nodes.find(n => n.id === 'm_ready')!;
        const edge = collect<GEdge>(root, GEdge).find(e => e.sourceId === 'm_ready_port_m_ready')!;
        const route = ((edge as any).routingPoints ?? []) as Array<{ x: number; y: number }>;
        expect(route.length).toBeGreaterThanOrEqual(2);
        for (const p of route) {
            expect(p.x).toBeLessThanOrEqual(mReady.position.x + 1);
        }
    });
});
