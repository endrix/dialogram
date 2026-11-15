/**
 * A view the producer marks read-only offers nothing that would write.
 *
 * `supportsElementCreation: false` empties the palette for every diagram of a
 * profile. A producer whose files are mostly editable can also draw some it
 * only reads (a projection of another syntax, a project overview), and one
 * editor passes between both kinds in place. `graph.meta.readOnly` marks such
 * a view: the root carries `wf:readOnlyView`, the palette offers only what
 * the view still allows (its automaton's states and transitions, what its
 * producer declared it can make), and the context menu loses its editing
 * items, while reading, navigating and laying out stay.
 */
import { describe, expect, it } from 'vitest';
import { TRANSITIONS_PALETTE_GROUP, VIEW_CREATE_ELEMENT_TYPE, WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import { GraphGModelSource, type PyGraphDocument } from '../src/model/graph-gmodel-source';
import { WorkflowToolPaletteItemProvider } from '../src/server/tool-palette-provider';
import { WorkflowContextMenuItemProvider } from '../src/server/context-menu-item-provider';

function doc(meta?: Record<string, unknown>): PyGraphDocument {
    return {
        version: '1',
        graph: {
            id: 'root',
            meta,
            nodes: [{ id: 'node:a', kind: 'task', label: 'a', scope: 'root', ports: [] }],
            edges: []
        }
    } as PyGraphDocument;
}

const rootArgs = (meta?: Record<string, unknown>): Record<string, unknown> | undefined =>
    new GraphGModelSource({} as any).transform(doc(meta)).graph.args as Record<string, unknown> | undefined;

function palette(root: unknown): any {
    const provider: any = new WorkflowToolPaletteItemProvider();
    provider.storageOptions = {
        settingsNamespace: 'demo',
        operationPrefix: 'demo',
        entityPaletteItems: [{ elementTypeId: 'node:actor', label: 'Thing', description: 'x' }]
    };
    provider.modelState = { root };
    return provider;
}

function menu(root: any, node: any): any {
    const provider: any = new WorkflowContextMenuItemProvider();
    provider.modelState = { sourceUri: 'file:///w/a.txt', root, index: { find: () => node } };
    return provider;
}

describe('a view the producer marks read-only', () => {
    it('carries the mark on its root, and only when the producer says so', () => {
        expect(rootArgs({ readOnly: true })?.[WorkflowDiagramMetadata.READ_ONLY_VIEW]).toBe(true);
        expect(rootArgs({ readOnly: false })?.[WorkflowDiagramMetadata.READ_ONLY_VIEW]).toBeUndefined();
        expect(rootArgs()?.[WorkflowDiagramMetadata.READ_ONLY_VIEW]).toBeUndefined();
    });

    it('says what can still be edited in it, of the edits the platform has, and what a drawn transition can be taken by', () => {
        const labels = [{ id: 'step', label: 'step', description: ' In → Out ' }, { id: 'stop', label: 'stop' }, { id: '', label: 'nameless' }, 'junk'];
        const args = rootArgs({ readOnly: true, edits: ['transition', 'rename', 7, 'state'], transitionLabels: labels })!;
        expect(args[WorkflowDiagramMetadata.VIEW_EDITS]).toEqual(['transition', 'state']);
        expect(args[WorkflowDiagramMetadata.TRANSITION_LABELS]).toEqual([{ id: 'step', label: 'step', description: 'In → Out' }, { id: 'stop', label: 'stop' }]);
        // An editable view needs no list of what it allows; one that allows no transition, no labels.
        expect(rootArgs({ edits: ['transition'], transitionLabels: labels })?.[WorkflowDiagramMetadata.VIEW_EDITS]).toBeUndefined();
        expect(rootArgs({ readOnly: true, transitionLabels: labels })?.[WorkflowDiagramMetadata.TRANSITION_LABELS]).toBeUndefined();
    });

    it('names each state of its automaton as the producer does, a state with no name none', () => {
        const graph: any = new GraphGModelSource({} as any).transform({
            version: '1',
            graph: {
                id: 'root',
                meta: { readOnly: true, edits: ['transition'] },
                nodes: [
                    { id: 'state:idle', kind: 'state', label: 'idle', scope: 'root', ports: [], meta: { state: 'idle', initial: true } },
                    { id: 'state:*', kind: 'state', label: 'any state', scope: 'root', ports: [], meta: {} }
                ],
                edges: []
            }
        } as PyGraphDocument).graph;
        const names = (graph.children ?? []).filter((c: any) => c.type === WorkflowDiagramTypes.NODE_STATE)
            .map((c: any) => [c.args[WorkflowDiagramMetadata.ENTITY_NAME], c.args[WorkflowDiagramMetadata.STATE_NAME]]);
        expect(names).toEqual([['idle', 'idle'], ['any state', undefined]]);
    });

    it('says what else can be made in it, as its producer declared it, and what it lets be deleted', () => {
        const creates = [
            { id: 'port.in', label: 'Input Port', group: 'Ports', icon: 'arrow-right', asks: [{ key: 'name', prompt: 'Name' }, { key: '', prompt: 'x' }] },
            { id: 'port.in', label: 'Twice' },
            { id: 'action', label: ' Action ', description: 'An action of the actor' },
            { id: 'nameless' },
            'junk'
        ];
        expect(rootArgs({ readOnly: true, creates })?.[WorkflowDiagramMetadata.VIEW_CREATES]).toEqual([
            { id: 'port.in', label: 'Input Port', group: 'Ports', icon: 'arrow-right', asks: [{ key: 'name', prompt: 'Name' }] },
            { id: 'action', label: 'Action', description: 'An action of the actor' }
        ]);
        // An editable view has its own palette.
        expect(rootArgs({ creates })?.[WorkflowDiagramMetadata.VIEW_CREATES]).toBeUndefined();
        const graph: any = new GraphGModelSource({} as any).transform({
            version: '1',
            graph: {
                id: 'root',
                meta: { readOnly: true, edits: ['state'] },
                nodes: [
                    { id: 'state:idle', kind: 'state', label: 'idle', scope: 'root', ports: [], meta: { state: 'idle', delete: true } },
                    { id: 'state:new', kind: 'state', label: 'new', scope: 'root', ports: [], meta: { state: 'new', unwritten: true } },
                    { id: 'wf:in:In', kind: 'wf-input', label: 'In', scope: 'root', ports: [{ id: 'wf:in:In:p', name: 'In', direction: 'out' }], meta: { delete: true } }
                ],
                edges: []
            }
        } as PyGraphDocument).graph;
        const marks = (graph.children ?? []).map((c: any) => [
            c.type, c.args[WorkflowDiagramMetadata.VIEW_DELETABLE], c.args[WorkflowDiagramMetadata.STATE_UNWRITTEN], c.args[WorkflowDiagramMetadata.GRAPH_NODE_ID]
        ]);
        expect(marks).toEqual([
            [WorkflowDiagramTypes.NODE_STATE, true, undefined, 'state:idle'],
            [WorkflowDiagramTypes.NODE_STATE, undefined, true, 'state:new'],
            [WorkflowDiagramTypes.NODE_BOUNDARY_INPUT, true, undefined, 'wf:in:In']
        ]);
    });

    it('offers in the palette what it still allows, and nothing else; an editable view, everything', async () => {
        // The client asks for the items again with each model (`ViewToolPalette`),
        // so an editor that passes from one view to another gets each one's.
        const groups = async (args: Record<string, unknown>) => (await palette({ id: 'root', args }).getItems())
            .map((group: any) => [group.label, group.children.map((item: any) => [item.label, item.actions[0].elementTypeId, item.actions[0].args?.create])]);
        expect(await groups({})).toEqual([
            ['Entities', [['Thing', 'node:actor', undefined]]],
            ['Ports', [['Input Port', WorkflowDiagramTypes.NODE_BOUNDARY_INPUT, undefined], ['Output Port', WorkflowDiagramTypes.NODE_BOUNDARY_OUTPUT, undefined]]],
            ['Connections', [['Connection', WorkflowDiagramTypes.EDGE_CONNECTION, undefined]]]
        ]);
        expect(await groups({ [WorkflowDiagramMetadata.READ_ONLY_VIEW]: true })).toEqual([]);
        expect(await groups({
            [WorkflowDiagramMetadata.READ_ONLY_VIEW]: true,
            [WorkflowDiagramMetadata.VIEW_EDITS]: ['transition', 'state'],
            [WorkflowDiagramMetadata.VIEW_CREATES]: [
                { id: 'port.in', label: 'Input Port', group: 'Ports' },
                { id: 'action', label: 'Action', group: 'Actor' },
                { id: 'port.out', label: 'Output Port', group: 'Ports' },
                { id: 'loose', label: 'Loose' }
            ]
        })).toEqual([
            ['Automaton', [['State', WorkflowDiagramTypes.NODE_STATE, undefined], ['Transition', WorkflowDiagramTypes.EDGE_TRANSITION, undefined]]],
            ['Ports', [['Input Port', VIEW_CREATE_ELEMENT_TYPE, 'port.in'], ['Output Port', VIEW_CREATE_ELEMENT_TYPE, 'port.out']]],
            ['Actor', [['Action', VIEW_CREATE_ELEMENT_TYPE, 'action']]],
            ['Create', [['Loose', VIEW_CREATE_ELEMENT_TYPE, 'loose']]]
        ]);
        // The Transition alone keeps the group the client knew it by.
        const only = await palette({ id: 'root', args: { [WorkflowDiagramMetadata.READ_ONLY_VIEW]: true, [WorkflowDiagramMetadata.VIEW_EDITS]: ['transition'] } }).getItems();
        expect(only.map((group: any) => group.id)).toEqual([TRANSITIONS_PALETTE_GROUP]);
    });

    it('keeps reading and navigating items in the context menu, not editing ones', () => {
        const node = (root: any): any => ({
            id: 'n', type: WorkflowDiagramTypes.NODE_ACTOR, parent: root,
            args: {
                [WorkflowDiagramMetadata.ENTITY_NAME]: 'a',
                [WorkflowDiagramMetadata.ENTITY_DEFINITION_PARAMETERS]: [{ name: 'width', value: '4' }]
            }
        });
        const ids = (args: Record<string, unknown>): string[] => {
            const root: any = { id: 'root', type: 'graph', args };
            return menu(root, node(root)).getItems(['n'], { x: 0, y: 0 }).map((item: any) => item.id);
        };
        const editable = ids({});
        expect(editable).toEqual(expect.arrayContaining(['dialogram.renameEntity', 'dialogram.duplicate', 'dialogram.editParameters']));
        const readOnly = ids({ [WorkflowDiagramMetadata.READ_ONLY_VIEW]: true });
        for (const editing of ['dialogram.renameEntity', 'dialogram.duplicate', 'dialogram.editParameters']) {
            expect(readOnly, `${editing} offered on a read-only view`).not.toContain(editing);
        }
        // What does not write stays.
        expect(readOnly).toEqual(editable.filter(id => !['dialogram.renameEntity', 'dialogram.duplicate', 'dialogram.editParameters'].includes(id)));
    });
});
