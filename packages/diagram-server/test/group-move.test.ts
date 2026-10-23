/**
 * Moving a member of a group: the member keeps its size, and the frame grows.
 *
 * A group is sized by its members and never resized by hand (it is not
 * declared resizable, so GLSP no longer takes a click on a member for the
 * start of a resize of the group). A move changes where a node is, never how
 * big it is, whatever size the client sends with it. A member dragged towards
 * the right or bottom edge takes the frame with it: the group grows to fit,
 * its enclosing groups too, and the ports on its right-hand side follow.
 */
import { describe, expect, it } from 'vitest';
import { GNode, GPort } from '@eclipse-glsp/server';
import { WorkflowDiagramConstants, WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import { GraphGModelSource, type PyGraphDocument } from '../src/model/graph-gmodel-source';
import { convertToGModelRoot } from '../src/server/gmodel-convert';
import { WorkflowDiagramConfiguration } from '../src/server/diagram-configuration';
import { growGroupsToFit } from '../src/server/group-geometry';
import { WorkflowChangeBoundsOperationHandler } from '../src/operations/change-bounds-handler';

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
        nodes: ['a1', 'b1'].map(node),
        edges: [edge('a1', 'b1')],
        subgraphs: [
            { id: 'scope:outer', kind: 'group', label: 'Outer', nodes: [] },
            { id: 'scope:A', kind: 'group', label: 'A', parent: 'scope:outer', nodes: ['node:a1'] }
        ]
    }
};

function model() {
    const root: any = convertToGModelRoot(new GraphGModelSource().transform(DOC) as any);
    const byId = new Map<string, any>();
    const index = (e: any): void => { byId.set(e.id, e); (e.children ?? []).forEach(index); };
    index(root);
    // Laid out as the layout would leave it: A inside Outer, a1 inside A, both frames tight.
    const outer = byId.get('scope:scope:outer') as GNode;
    const group = byId.get('scope:scope:A') as GNode;
    const member = byId.get('a1') as GNode;
    outer.position = { x: 0, y: 0 };
    outer.size = { width: 300, height: 200 };
    group.position = { x: 14, y: 38 };
    group.size = { width: 250, height: 140 };
    member.position = { x: 20, y: 40 };
    member.size = { width: 200, height: 74 };
    for (const port of group.children.filter(c => c instanceof GPort) as GPort[]) {
        port.position = { x: (port as any).args[WorkflowDiagramMetadata.PORT_SIDE] === 'EAST' ? 246 : -4, y: 70 };
        port.size = { width: 8, height: 8 };
    }
    return { root, byId, outer, group, member };
}

describe('moving a member of a group', () => {
    it('is never taken for a resize of the group: groups are not resizable', () => {
        const hint = new WorkflowDiagramConfiguration().shapeTypeHints.find(h => h.elementTypeId === WorkflowDiagramTypes.NODE_GROUP);
        expect(hint?.resizable).toBe(false);
        expect(hint?.repositionable).toBe(true);
    });

    it('grows the group, and the group around it, to fit a member dragged to the right and down', () => {
        const { outer, group, member } = model();
        member.position = { x: 120, y: 90 };
        const grown = growGroupsToFit(member);
        const pad = WorkflowDiagramConstants.GROUP_PADDING_PX;
        expect(group.size).toEqual({ width: 120 + 200 + pad, height: 90 + 74 + pad });
        expect(outer.size).toEqual({ width: 14 + group.size.width + pad, height: 38 + group.size.height + pad });
        expect(grown.map(g => g.id)).toEqual(['scope:scope:A', 'scope:scope:outer']);
        // The port on the right-hand side follows the right edge; the one on the left stays.
        const east = group.children.find(c => (c as any).args?.[WorkflowDiagramMetadata.PORT_SIDE] === 'EAST') as GPort;
        expect(east.position.x).toBe(group.size.width - 4);
    });

    it('leaves the frame alone while the member still fits, and never shrinks it', () => {
        const { group, member } = model();
        member.position = { x: 10, y: 30 };
        expect(growGroupsToFit(member)).toEqual([]);
        expect(group.size).toEqual({ width: 250, height: 140 });
    });

    it('keeps a moved node’s own size whatever size the client sends, but resizes a resizable container', () => {
        const { byId, member } = model();
        const handler = new WorkflowChangeBoundsOperationHandler() as any;
        handler.modelState = {
            index: {
                findByClass: (id: string, cls: any) => { const e = byId.get(id); return e instanceof cls ? e : undefined; },
                find: (id: string) => byId.get(id)
            },
            get: () => undefined
        };
        handler.diagramConfiguration = new WorkflowDiagramConfiguration();
        handler.changeElementBounds('a1', { width: 251, height: 72 }, { x: 30, y: 44 });
        expect(member.size).toEqual({ width: 200, height: 74 });
        expect(member.position).toEqual({ x: 30, y: 44 });

        const branch = new GNode();
        branch.id = 'branch';
        branch.type = WorkflowDiagramTypes.NODE_STRUCTURE_IF;
        branch.size = { width: 100, height: 100 };
        byId.set('branch', branch);
        handler.changeElementBounds('branch', { width: 180, height: 120 }, { x: 0, y: 0 });
        expect(branch.size).toEqual({ width: 180, height: 120 });
    });

    it('saves where the members of a moved group now are, so a reopen keeps them in the frame', async () => {
        const { byId, group } = model();
        const saved: Array<Map<string, { x: number; y: number }>> = [];
        const handler = new WorkflowChangeBoundsOperationHandler() as any;
        handler.modelState = {
            index: {
                findByClass: (id: string, cls: any) => { const e = byId.get(id); return e instanceof cls ? e : undefined; },
                find: (id: string) => byId.get(id)
            },
            get: () => ({ documentUri: 'file:///w/doc.json', workflowName: 'root' })
        };
        handler.diagramConfiguration = new WorkflowDiagramConfiguration();
        handler.layoutPersistence = {
            loadLayout: async () => new Map([['a1', { x: 34, y: 78 }]]),
            saveLayout: (_file: string, _network: string, positions: Map<string, { x: number; y: number }>) => { saved.push(positions); }
        };
        // The group dragged 100 to the right and 50 down; its member rides along.
        handler.executeChangeBounds({ newBounds: [{ elementId: group.id, newSize: group.size, newPosition: { x: 114, y: 88 } }] });
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(saved).toHaveLength(1);
        // a1 sits at (20, 40) in A, now at (114, 88) in Outer at (0, 0).
        expect(saved[0].get('a1')).toEqual({ x: 134, y: 128 });
    });
});
