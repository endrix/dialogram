/**
 * What an automaton's actions work with, drawn round it: the unit's ports
 * beside the states, its declarations (variables, functions) in groups pinned
 * above, and links that come up while a transition is selected.
 *
 * A link may end at a transition (the action it fires), and one that ends at
 * a transition folded into a run ends at the run's state; the run's steps
 * that link to the same thing are one link. A declaration is a card: its
 * header and its lines, no port area.
 */
import { describe, expect, it } from 'vitest';
import ELK from 'elkjs/lib/elk.bundled.js';
import { GEdge, GGraph, GNode } from '@eclipse-glsp/server';
import { DefaultElementFilter } from '@eclipse-glsp/layout-elk';
import { WorkflowDiagramConstants, WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import { GraphGModelSource, type PyGraphDocument } from '../src/model/graph-gmodel-source';
import { foldId } from '../src/model/automaton-compress';
import { convertToGModelRoot } from '../src/server/gmodel-convert';
import { WorkflowElkLayoutEngine } from '../src/server/elk-layout-engine';
import { WorkflowLayoutConfigurator } from '../src/server/layout-configurator';
import { PORT_COLUMN_GAP_PX, automatonDrawingBox } from '../src/server/automaton-layout';

const state = (name: string, meta: Record<string, unknown> = {}): any =>
    ({ id: `state:${name}`, kind: 'state', label: name, scope: 'scope:root', ports: [], meta });
const t = (from: string, action: string, to: string): any =>
    ({ id: `t:${from}:${action}->${to}`, from: `state:${from}`, to: `state:${to}`, scope: 'scope:root', meta: { label: action } });
const unitPort = (direction: 'in' | 'out', name: string): any => ({
    id: `wf:${direction}:${name}`,
    kind: direction === 'in' ? 'wf-input' : 'wf-output',
    label: name,
    scope: 'scope:root',
    ports: [{ id: `wf:${direction}:${name}:p:${name}`, name, direction: direction === 'in' ? 'out' : 'in', type: 'Int(8)' }],
    meta: { networkBoundary: true, boundaryKind: direction === 'in' ? 'input' : 'output' }
});
const variable = (name: string, initial = '= 0'): any => ({
    id: `v:${name}`, kind: 'variable', label: name, type: 'Int(8)', scope: 'scope:variables', ports: [],
    meta: { row: 0, lines: [{ text: initial, kind: 'initial' }] }
});
const link = (role: string, from: string, to: string, meta: Record<string, unknown> = {}): any =>
    ({ id: `l:${role}:${from}->${to}`, from, to, scope: 'scope:root', meta: { onSelection: true, role, ...meta } });

/**
 * `read` takes a byte; `go` runs a, b, c (a run, folded) and back. `go`
 * writes `count`; each step of the run reads and writes `acc`.
 */
const UNIT: PyGraphDocument = {
    version: '1',
    graph: {
        id: 'root',
        nodes: [
            unitPort('in', 'In'), unitPort('out', 'Out'),
            state('read', { initial: true }), state('a'), state('b'), state('c'),
            variable('count'), variable('acc')
        ],
        edges: [
            t('read', 'go', 'a'), t('read', 'idle', 'read'), t('a', 'x', 'b'), t('b', 'y', 'c'), t('c', 'done', 'read'),
            link('token', 'wf:in:In', 't:read:go->a'),
            link('write', 't:read:go->a', 'v:count'),
            link('write', 't:a:x->b', 'v:acc'),
            link('write', 't:b:y->c', 'v:acc', { bidirectional: true }),
            link('token', 't:c:done->read', 'wf:out:Out')
        ],
        subgraphs: [
            { id: 'scope:root', kind: 'network', children: ['scope:variables'] },
            { id: 'scope:variables', kind: 'group', label: 'variables', pin: 'top' }
        ]
    } as any
};

describe('a link of an automaton', () => {
    const graph = new GraphGModelSource().transform(UNIT).graph;
    const links = (graph as any).args[WorkflowDiagramMetadata.SELECTION_LINKS] as any[];
    const deep = (elements: any[] | undefined): any[] => (elements ?? []).flatMap(e => [e, ...deep(e.children)]);
    const idOf = (name: string): string =>
        deep(graph.children).find((c: any) => c.args?.[WorkflowDiagramMetadata.ENTITY_NAME] === name)!.id;
    const fold = (graph.children ?? []).find((c: any) => c.args?.[WorkflowDiagramMetadata.STATE_STEPS])!;

    it('ends at a transition, by the transition’s id', () => {
        expect(links.find(l => l.id === 'l:token:wf:in:In->t:read:go->a')).toMatchObject({ from: idOf('In'), to: 't:read:go->a' });
        expect(links.find(l => l.id === 'l:write:t:read:go->a->v:count')).toMatchObject({ from: 't:read:go->a', to: idOf('count') });
    });

    it('ends at the run’s state when its transition is folded into the run, and the run’s steps that say the same are one link', () => {
        expect(fold.id).toBe(idOf('a … c'));
        expect(foldId('state:a')).toBe('fold:state:a');
        const toAcc = links.filter(l => l.to === idOf('acc'));
        // Two steps write `acc`: one link, both ways since one of them reads it too.
        expect(toAcc).toEqual([{ id: 'l:write:t:a:x->b->v:acc', from: fold.id, to: idOf('acc'), role: 'write', bidirectional: true }]);
        // The way out of the run is no step of it: its transition is still drawn, and its link ends there.
        expect(links.find(l => l.id === 'l:token:t:c:done->read->wf:out:Out')).toMatchObject({ from: 't:c:done->read', to: idOf('Out') });
    });
});

describe('a declaration', () => {
    const graph = new GraphGModelSource().transform(UNIT).graph;
    const all = (elements: any[] | undefined, out: any[] = []): any[] => {
        for (const element of elements ?? []) {
            out.push(element);
            all(element.children, out);
        }
        return out;
    };
    const card = all(graph.children).find((c: any) => c.args?.[WorkflowDiagramMetadata.ENTITY_NAME] === 'count');

    it('is a card: its header, its lines and its type under it, no port area', () => {
        expect(card.size.height).toBe(WorkflowDiagramConstants.HEADER_HEIGHT_PX + WorkflowDiagramConstants.NODE_LINE_HEIGHT_PX
            + WorkflowDiagramConstants.NODE_FOOTER_LABEL_HEIGHT_PX);
    });

    it('keeps its port area when it has ports, and when it has no lines', () => {
        const withPort = new GraphGModelSource().transform({
            version: '1',
            graph: {
                id: 'root',
                nodes: [
                    { ...variable('p'), scope: 'scope:root', ports: [{ id: 'p:in', name: 'in', direction: 'in' }] },
                    { ...variable('bare'), scope: 'scope:root', meta: {} }
                ],
                edges: []
            }
        } as any).graph;
        const p = all(withPort.children).find((c: any) => c.args?.[WorkflowDiagramMetadata.ENTITY_NAME] === 'p');
        const bare = all(withPort.children).find((c: any) => c.args?.[WorkflowDiagramMetadata.ENTITY_NAME] === 'bare');
        expect(p.size.height).toBeGreaterThan(card.size.height);
        expect(bare.size.height).toBeGreaterThan(WorkflowDiagramConstants.HEADER_HEIGHT_PX + WorkflowDiagramConstants.NODE_FOOTER_LABEL_HEIGHT_PX);
    });
});

describe('what goes round an automaton', () => {
    const place = async (): Promise<GGraph> => {
        const root = convertToGModelRoot(new GraphGModelSource({} as any).transform(UNIT) as any) as unknown as GGraph;
        const find = (element: any, id: string): any => element?.id === id
            ? element
            : (element?.children ?? []).map((child: any) => find(child, id)).find(Boolean);
        const modelState: any = { root, index: { get: (id: string) => find(root, id), findByClass: (id: string) => find(root, id) } };
        const engine = new WorkflowElkLayoutEngine(
            () => new (ELK as any)({ algorithms: ['layered', 'stress'] }),
            new DefaultElementFilter(),
            new WorkflowLayoutConfigurator(),
            modelState
        );
        await engine.layout();
        return root;
    };
    const box = (node: GNode) => ({
        left: node.position!.x, top: node.position!.y,
        right: node.position!.x + node.size!.width, bottom: node.position!.y + node.size!.height
    });

    /** What the client draws of the automaton: its states, curves, loops, labels and initial mark. */
    const drawnOf = (root: GGraph) => {
        const drawn = automatonDrawingBox(
            (root.children ?? []).filter((c): c is GNode => c instanceof GNode && c.type === WorkflowDiagramTypes.NODE_STATE) as any[],
            (root.children ?? []).filter(c => c instanceof GEdge && c.type === WorkflowDiagramTypes.EDGE_TRANSITION) as any[]
        )!;
        return { left: drawn.x, top: drawn.y, right: drawn.x + drawn.width, bottom: drawn.y + drawn.height };
    };

    it('puts the inputs left of the states and the outputs right, a gap from what stands out of them', async () => {
        const root = await place();
        const nodes = (root.children ?? []).filter((c): c is GNode => c instanceof GNode);
        const states = nodes.filter(n => n.type === WorkflowDiagramTypes.NODE_STATE).map(box);
        const input = box(nodes.find(n => n.type === WorkflowDiagramTypes.NODE_BOUNDARY_INPUT)!);
        const output = box(nodes.find(n => n.type === WorkflowDiagramTypes.NODE_BOUNDARY_OUTPUT)!);
        const drawn = drawnOf(root);
        // The loop of `read` and the labels stand out of the states.
        expect(drawn.left).toBeLessThan(Math.min(...states.map(s => s.left)));
        // Beside the drawing, not further: a port is where the tokens of the transitions next to it go.
        expect(drawn.left - input.right).toBeGreaterThanOrEqual(PORT_COLUMN_GAP_PX - 1);
        expect(drawn.left - input.right).toBeLessThanOrEqual(PORT_COLUMN_GAP_PX + 1);
        expect(output.left - drawn.right).toBeGreaterThanOrEqual(PORT_COLUMN_GAP_PX - 1);
        expect(output.left - drawn.right).toBeLessThanOrEqual(PORT_COLUMN_GAP_PX + 1);
        // Level with the states, and on the canvas.
        const middle = (input.top + input.bottom) / 2;
        expect(middle).toBeGreaterThanOrEqual(Math.min(...states.map(s => s.top)));
        expect(middle).toBeLessThanOrEqual(Math.max(...states.map(s => s.bottom)));
        expect(input.left).toBeGreaterThanOrEqual(0);
    });

    it('stacks the declarations above, as far up as an automaton’s labels and loops stand', async () => {
        const root = await place();
        const nodes = (root.children ?? []).filter((c): c is GNode => c instanceof GNode);
        const band = box(nodes.find(n => n.type === WorkflowDiagramTypes.NODE_GROUP)!);
        expect(drawnOf(root).top - band.bottom).toBeGreaterThanOrEqual(WorkflowDiagramConstants.GROUP_PIN_GAP_PX - 1);
    });
});
