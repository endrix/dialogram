/**
 * Reopening a saved layout that has groups in it.
 *
 * A saved layout holds absolute node positions and absolute edge routes, and
 * reopening it skips the layout run. Two things went wrong with groups: the
 * loader wrote each absolute position back as a position relative to the
 * node's parent, so every member landed outside its group by the group's own
 * offset; and a group's size and its boundary ports, which only the layout run
 * produces, were left unset, so the frame came back at a default size with its
 * ports in a corner.
 *
 * This lays a model out with the real ELK, saves it the way the handlers do,
 * reopens it into a fresh model the way the loader does, and compares.
 */
import { describe, expect, it } from 'vitest';
import ELK from 'elkjs/lib/elk.bundled.js';
import { GEdge, GGraph, GNode, GPort } from '@eclipse-glsp/server';
import { DefaultElementFilter } from '@eclipse-glsp/layout-elk';
import { WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import { GraphGModelSource, type PyGraphDocument } from '../src/model/graph-gmodel-source';
import { WorkflowElkLayoutEngine } from '../src/server/elk-layout-engine';
import { WorkflowLayoutConfigurator } from '../src/server/layout-configurator';
import { convertToGModelRoot } from '../src/server/gmodel-convert';
import { relativeToParent, restoreGroupGeometry } from '../src/server/group-geometry';

type Point = { x: number; y: number };

function node(name: string) {
    return {
        id: `node:${name}`, kind: 'actor', label: name, scope: 'scope:root',
        ports: [
            { id: `port:node:${name}:in`, name: 'in', direction: 'in' as const },
            { id: `port:node:${name}:out`, name: 'out', direction: 'out' as const }
        ]
    };
}
const edge = (from: string, to: string) => ({ id: `e:${from}->${to}`, from: `port:node:${from}:out`, to: `port:node:${to}:in`, scope: 'scope:root' });

const DOC: PyGraphDocument = {
    version: '1',
    graph: {
        id: 'root',
        nodes: ['a1', 'a2', 'b1', 'x'].map(node),
        edges: [edge('a1', 'a2'), edge('a1', 'b1'), edge('a2', 'b1'), edge('x', 'a1')],
        subgraphs: [
            { id: 'scope:A', kind: 'group', label: 'A', nodes: ['node:a1', 'node:a2'] },
            { id: 'scope:B', kind: 'group', label: 'B', nodes: ['node:b1'] }
        ]
    }
};

function index(element: any, map = new Map<string, any>()): Map<string, any> {
    map.set(element.id, element);
    for (const child of element.children ?? []) {
        index(child, map);
    }
    return map;
}
function absolute(element: any): Point {
    let x = 0;
    let y = 0;
    for (let current = element; current; current = current.parent) {
        x += current.position?.x ?? 0;
        y += current.position?.y ?? 0;
    }
    return { x, y };
}
const fresh = (): GGraph => convertToGModelRoot(new GraphGModelSource().transform(DOC) as any) as unknown as GGraph;

describe('reopening a saved layout with groups', () => {
    it('puts the members back inside their groups and rebuilds each frame as the layout left it', async () => {
        // Lay out, then save as every handler saves: absolute positions by key, absolute routes by edge id.
        const laid = fresh();
        const laidIndex = index(laid);
        const modelState: any = { root: laid, index: { get: (id: string) => laidIndex.get(id), findByClass: (id: string) => laidIndex.get(id) } };
        await new WorkflowElkLayoutEngine(() => new (ELK as any)({ algorithms: ['layered'] }), new DefaultElementFilter(), new WorkflowLayoutConfigurator(), modelState).layout();
        const saved = new Map<string, Point>();
        const routes = new Map<string, Point[]>();
        for (const element of laidIndex.values()) {
            if (typeof element.type === 'string' && element.type.startsWith('node:')) {
                saved.set(element.args?.[WorkflowDiagramMetadata.AST_PATH] ?? element.id, absolute(element));
            }
            if (element instanceof GEdge && (element as any).routingPoints) {
                routes.set(element.id, (element as any).routingPoints);
            }
        }

        // Reopen: the loader's walk, then the group geometry, before the routes are snapped.
        const reopened = fresh();
        const apply = (element: any, parentOrigin: Point): void => {
            let origin = { x: parentOrigin.x + (element.position?.x ?? 0), y: parentOrigin.y + (element.position?.y ?? 0) };
            const key = element.args?.[WorkflowDiagramMetadata.AST_PATH] ?? element.id;
            if (typeof element.type === 'string' && element.type.startsWith('node:') && saved.has(key)) {
                element.position = relativeToParent(saved.get(key)!, parentOrigin);
                origin = saved.get(key)!;
            }
            for (const child of element.children ?? []) {
                apply(child, origin);
            }
        };
        apply(reopened, { x: 0, y: 0 });
        restoreGroupGeometry(reopened as any, routes);

        const reopenedIndex = index(reopened);
        for (const [id, before] of laidIndex) {
            const after = reopenedIndex.get(id);
            if (!(before instanceof GNode) || before instanceof GPort) {
                continue;
            }
            // Every node is back where it was, groups and members alike.
            expect(absolute(after), id).toEqual(absolute(before));
            if (before.type === WorkflowDiagramTypes.NODE_GROUP) {
                // The frame hugs its members as the layout did. The width is
                // exact where a route leaves by a port on the right; elsewhere
                // the right inset mirrors the left one, which ELK makes a few
                // pixels narrower when a port sits on the left only.
                expect(Math.abs(after.size.width - before.size.width), `${id} width`).toBeLessThanOrEqual(5);
                expect(Math.abs(after.size.height - before.size.height), `${id} height`).toBeLessThanOrEqual(2);
            }
        }
        // Every boundary port is back on its frame, where its route crossed it.
        const ports = [...laidIndex.values()].filter(e => e.type === WorkflowDiagramTypes.PORT_GROUP_BOUNDARY);
        expect(ports.length).toBeGreaterThan(0);
        for (const before of ports) {
            const after = reopenedIndex.get(before.id);
            expect(Math.abs(absolute(after).x - absolute(before).x), `${before.id} x`).toBeLessThanOrEqual(2);
            expect(Math.abs(absolute(after).y - absolute(before).y), `${before.id} y`).toBeLessThanOrEqual(1);
        }
    });

    it('without saved routes, puts a port level with the port of the member it leads to', () => {
        const model = fresh();
        const byId = index(model);
        const group = byId.get('scope:scope:B') as GNode;
        const member = byId.get('b1') as GNode;
        group.position = { x: 100, y: 50 };
        member.position = { x: 14, y: 60 };
        member.size = { width: 120, height: 74 };
        restoreGroupGeometry(model as any, undefined);
        // The member sits 14 in from the left, so it gets 14 on the right too.
        expect(group.size).toEqual({ width: 14 + 120 + 14, height: 60 + 74 + 14 });
        const port = byId.get('scope:scope:B::in::b1_port_in') as GPort;
        const memberPort = byId.get('b1_port_in') as GPort;
        expect(port.position.x).toBe(-port.size.width / 2);
        expect(port.position.y + port.size.height / 2).toBe(60 + memberPort.position.y + memberPort.size.height / 2);
    });

    it('converts an absolute saved position into one relative to the parent', () => {
        expect(relativeToParent({ x: 1139, y: 119 }, { x: 1118, y: 93 })).toEqual({ x: 21, y: 26 });
        expect(relativeToParent({ x: 40, y: 30 }, { x: 0, y: 0 })).toEqual({ x: 40, y: 30 });
    });
});
