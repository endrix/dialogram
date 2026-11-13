/**
 * A list: a group whose scope says `list`, its members the rows of a table
 * instead of cards. A row is its name, then its lines, in columns the list's
 * rows share; the rows stand one under another with nothing between. Pinned
 * on the left of an automaton, the list stands beside what is drawn of it
 * and its ports, its top level with theirs, and goes on in a second column
 * when it is much taller than they are.
 */
import { describe, expect, it } from 'vitest';
import ELK from 'elkjs/lib/elk.bundled.js';
import { GEdge, GGraph, GNode } from '@eclipse-glsp/server';
import { DefaultElementFilter } from '@eclipse-glsp/layout-elk';
import { WorkflowDiagramConstants, WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import { GraphGModelSource, type PyGraphDocument } from '../src/model/graph-gmodel-source';
import { listColumns, listRowOf } from '../src/model/list-rows';
import { convertToGModelRoot } from '../src/server/gmodel-convert';
import { WorkflowElkLayoutEngine } from '../src/server/elk-layout-engine';
import { WorkflowLayoutConfigurator } from '../src/server/layout-configurator';
import { automatonDrawingBox } from '../src/server/automaton-layout';

const k = WorkflowDiagramConstants;

/**
 * An automaton (`idle` and `run`, an input `In`) and `count` variables in a
 * list pinned on its left: the first an `Int(8)` of value 0, the second a
 * `bool` with no value, the others `Int(8)`.
 */
function unit(count: number): PyGraphDocument {
    const state = (name: string, meta: Record<string, unknown> = {}): any =>
        ({ id: `state:${name}`, kind: 'state', label: name, scope: 'scope:root', ports: [], meta });
    const variable = (n: number): any => ({
        id: `v:${n}`, kind: 'variable', label: n === 0 ? 'count' : `v${n}`, scope: 'scope:variables', ports: [],
        meta: {
            lines: n === 1
                ? [{ text: 'bool', kind: 'type' }]
                : [{ text: 'Int(8)', kind: 'type' }, { text: '= 0', kind: 'initial' }]
        }
    });
    return {
        version: '1',
        graph: {
            id: 'root',
            nodes: [
                {
                    id: 'wf:in:In', kind: 'wf-input', label: 'In', scope: 'scope:root',
                    ports: [{ id: 'wf:in:In:p:In', name: 'In', direction: 'out', type: 'Int(8)' }],
                    meta: { networkBoundary: true, boundaryKind: 'input' }
                },
                state('idle', { initial: true }), state('run'),
                ...Array.from({ length: count }, (_, n) => variable(n))
            ],
            edges: [
                { id: 't:go', from: 'state:idle', to: 'state:run', scope: 'scope:root', meta: { label: 'go' } },
                { id: 't:stop', from: 'state:run', to: 'state:idle', scope: 'scope:root', meta: { label: 'stop' } },
                { id: 't:step', from: 'state:run', to: 'state:run', scope: 'scope:root', meta: { label: 'step' } }
            ],
            subgraphs: [
                { id: 'scope:root', kind: 'network', children: ['scope:variables'] },
                { id: 'scope:variables', kind: 'group', label: 'variables', pin: 'left', list: true }
            ]
        } as any
    };
}

const deep = (elements: readonly any[] | undefined): any[] => (elements ?? []).flatMap(e => [e, ...deep(e.children)]);

describe('the columns of a list', () => {
    it('are the name after the mark, then each place of the lines as wide as its widest entry', () => {
        const columns = listColumns([
            { label: 'ab', lines: [{ text: 'xyz' }, { text: '= 1' }] },
            { label: 'abcd', lines: [{ text: 'x' }] }
        ], text => text.length, 10);
        const nameX = k.LIST_ROW_MARK_PX + k.LIST_ROW_PADDING_PX;
        expect(columns.nameX).toBe(nameX);
        expect(columns.cellX).toEqual([nameX + 40 + k.LIST_ROW_COLUMN_GAP_PX, nameX + 40 + 30 + 2 * k.LIST_ROW_COLUMN_GAP_PX]);
        expect(columns.width).toBe(columns.cellX[1] + 30 + k.LIST_ROW_PADDING_PX);
        // A row leaves out a line with no text, and keeps the kind of the others.
        expect(listRowOf({ label: 'ab', lines: [{ text: '' }, { text: '= 1', kind: 'initial' }] }, columns))
            .toEqual({ nameX, cells: [{ text: '= 1', x: columns.cellX[1], kind: 'initial' }] });
    });
});

describe('a member of a list', () => {
    const graph = new GraphGModelSource().transform(unit(3)).graph;
    const rows = deep(graph.children).filter(c => c.args?.[WorkflowDiagramMetadata.LIST_ROW]);

    it('is a row: a row high, as wide as the others, no header and no type under it', () => {
        expect(rows.map(row => row.args[WorkflowDiagramMetadata.ENTITY_NAME])).toEqual(['count', 'v1', 'v2']);
        for (const row of rows) {
            expect(row.size).toEqual({ width: rows[0].size.width, height: k.LIST_ROW_HEIGHT_PX });
            expect(row.args[WorkflowDiagramMetadata.NODE_LINES]).toBeUndefined();
            expect(deep(row.children).filter(c => String(c.type).includes('header'))).toEqual([]);
        }
    });

    it('shows its lines in the columns the list’s rows share, as the producer ordered them', () => {
        const [count, v1] = rows.map(row => row.args[WorkflowDiagramMetadata.LIST_ROW]);
        expect(count.cells.map((c: any) => [c.text, c.kind])).toEqual([['Int(8)', 'type'], ['= 0', 'initial']]);
        expect(v1.cells.map((c: any) => c.text)).toEqual(['bool']);
        expect(v1.cells[0].x).toBe(count.cells[0].x);
        expect(count.cells[1].x).toBeGreaterThan(count.cells[0].x);
    });

    it('is in a frame marked as a list and pinned on the left', () => {
        const frame = deep(graph.children).find(c => c.type === WorkflowDiagramTypes.NODE_GROUP);
        expect(frame.args[WorkflowDiagramMetadata.GROUP_LIST]).toBe(true);
        expect(frame.args[WorkflowDiagramMetadata.GROUP_PIN]).toBe('left');
    });
});

describe('a list pinned on the left of an automaton', () => {
    const place = async (doc: PyGraphDocument): Promise<GGraph> => {
        const root = convertToGModelRoot(new GraphGModelSource({} as any).transform(doc) as any) as unknown as GGraph;
        const byId = new Map(deep([root]).map(e => [e.id, e]));
        const modelState: any = { root, index: { get: (id: string) => byId.get(id), findByClass: (id: string) => byId.get(id) } };
        await new WorkflowElkLayoutEngine(
            () => new (ELK as any)({ algorithms: ['layered', 'stress'] }),
            new DefaultElementFilter(),
            new WorkflowLayoutConfigurator(),
            modelState
        ).layout();
        return root;
    };
    const parts = (root: GGraph) => {
        const nodes = (root.children ?? []).filter((c): c is GNode => c instanceof GNode);
        const frame = nodes.find(n => n.type === WorkflowDiagramTypes.NODE_GROUP)!;
        const input = nodes.find(n => n.type === WorkflowDiagramTypes.NODE_BOUNDARY_INPUT)!;
        const drawn = automatonDrawingBox(
            nodes.filter(n => n.type === WorkflowDiagramTypes.NODE_STATE) as any[],
            (root.children ?? []).filter(c => c instanceof GEdge) as any[]
        )!;
        const rows = (frame.children ?? []).filter((c): c is GNode => c instanceof GNode);
        return { frame, input, drawn, rows };
    };

    it('lays its rows one under another with nothing between, in the order given', async () => {
        const { rows } = parts(await place(unit(3)));
        expect(rows.map(row => row.position!.x)).toEqual([rows[0].position!.x, rows[0].position!.x, rows[0].position!.x]);
        expect(rows[1].position!.y - rows[0].position!.y).toBe(k.LIST_ROW_HEIGHT_PX);
        expect(rows[2].position!.y - rows[1].position!.y).toBe(k.LIST_ROW_HEIGHT_PX);
    });

    it('stands left of the automaton’s ports, a gap away, its top level with the drawing’s', async () => {
        const { frame, input, drawn } = parts(await place(unit(3)));
        const right = frame.position!.x + frame.size!.width;
        expect(input.position!.x - right).toBeGreaterThanOrEqual(k.GROUP_PIN_GAP_PX - 1);
        expect(input.position!.x - right).toBeLessThanOrEqual(k.GROUP_PIN_GAP_PX + 1);
        expect(frame.position!.y).toBe(Math.min(drawn.y, input.position!.y));
    });

    it('goes on in columns when much taller than the automaton, the first rows in the first', async () => {
        const { frame, rows } = parts(await place(unit(40)));
        const columns = [...new Set(rows.map(row => row.position!.x))].sort((a, b) => a - b);
        expect(columns.length).toBeGreaterThanOrEqual(2);
        expect(frame.size!.height).toBeLessThan(40 * k.LIST_ROW_HEIGHT_PX);
        // The first column holds the first rows, top down; the second goes on from there.
        const first = rows.filter(row => row.position!.x === columns[0]);
        expect(first.map(row => row.id)).toEqual(rows.slice(0, first.length).map(row => row.id));
        const second = rows[first.length];
        expect(second.position!.x).toBe(columns[1]);
        expect(second.position!.y).toBe(rows[0].position!.y);
    });
});
