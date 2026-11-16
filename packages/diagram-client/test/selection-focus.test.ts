/**
 * The rest of the diagram all but disappears while the selection's links are
 * shown (selection-focus.ts, selection-links.ts).
 *
 * Pinned here:
 *
 *  - what stays in sight: the selection, its links' ends, and the ends of
 *    every edge among them (a transition's two states);
 *  - every other node and edge fades; a node that holds nodes, at any depth,
 *    never does, nor does a port or a label (they go with their node or edge);
 *  - what a kept group holds stays with it; an edge cut at a group's frame
 *    keeps its other part, but where it ends at the group itself;
 *  - a transition kept in sight draws the line it shares with others between
 *    the same two states, since the one that draws it may fade;
 *  - nothing fades while no link is shown (nothing selected, a selection
 *    with no links), nor in the hidden render;
 *  - an edge in error, or what is on the selection's trace, never fades;
 *  - the postprocessor puts the class on the drawing of what fades.
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import { isFadedBySelection, noteSelection } from '../src/selection-links';
import { FOCUS_FADED_CLASS, SelectionFocusPostprocessor, fadesBehindSelection } from '../src/selection-focus';
import { TransitionEdgeView } from '../src/automaton-views';

const T = WorkflowDiagramTypes;

/** A model of `children`, with the links drawn on selection `links`, its elements adopted. */
function model(children: any[], links: Array<{ from: string; to: string }>): any {
    const root: any = {
        id: 'root', type: T.GRAPH, children,
        args: { [WorkflowDiagramMetadata.SELECTION_LINKS]: links.map((link, i) => ({ id: `l${i}`, role: 'read', ...link })) }
    };
    const adopt = (parent: any): void => (parent.children ?? []).forEach((child: any) => { child.parent = parent; child.root = root; adopt(child); });
    adopt(root);
    return root;
}

const element = (id: string, type: string, extra: Record<string, unknown> = {}): any =>
    ({ id, type, position: { x: 0, y: 0 }, size: { width: 80, height: 30 }, ...extra });

/** The drawings in `vnode` that wear the class `name` (the stub's `svg` gives `{tag, props, children}`). */
function withClass(vnode: any, name: string): any[] {
    const out: any[] = [];
    const visit = (each: any): void => {
        if (each && typeof each === 'object') {
            if ((each.data?.class ?? each.props?.class ?? {})[name]) {
                out.push(each);
            }
            (each.children ?? []).forEach(visit);
        }
    };
    visit(vnode);
    return out;
}

/**
 * An automaton: states `a`, `b`, `c`; transitions `t` (a→b) and `u` (b→c);
 * the input `In` (a node with a port); a list of the variables `x` and `y`.
 * `t` reads `x`. `selected` names what is selected.
 */
function automaton(selected: string[]): any {
    const node = (id: string, type: string, extra: Record<string, unknown> = {}): any => ({
        id, type, position: { x: 0, y: 0 }, size: { width: 80, height: 30 }, selected: selected.includes(id), ...extra
    });
    const row = (id: string): any => node(id, WorkflowDiagramTypes.NODE_ACTOR, { args: { [WorkflowDiagramMetadata.LIST_ROW]: { nameX: 8, cells: [] } } });
    const edge = (id: string, sourceId: string, targetId: string): any => ({ id, type: WorkflowDiagramTypes.EDGE_TRANSITION, sourceId, targetId, selected: selected.includes(id) });
    const input = node('In', WorkflowDiagramTypes.NODE_BOUNDARY_INPUT, { children: [{ id: 'In.p', type: WorkflowDiagramTypes.PORT_OUTPUT }] });
    const root: any = {
        id: 'root', type: WorkflowDiagramTypes.GRAPH,
        args: { [WorkflowDiagramMetadata.SELECTION_LINKS]: [{ id: 'reads', from: 't', to: 'x', role: 'read' }] },
        children: [
            node('a', WorkflowDiagramTypes.NODE_STATE), node('b', WorkflowDiagramTypes.NODE_STATE), node('c', WorkflowDiagramTypes.NODE_STATE),
            edge('t', 'a', 'b'), edge('u', 'b', 'c'), input,
            node('variables', WorkflowDiagramTypes.NODE_GROUP, { children: [row('x'), row('y')] })
        ]
    };
    const adopt = (parent: any): void => (parent.children ?? []).forEach((child: any) => { child.parent = parent; child.root = root; adopt(child); });
    adopt(root);
    return root;
}

/** Every element of `root` that fades, by id. */
function faded(root: any): string[] {
    const out: string[] = [];
    const visit = (element: any): void => {
        if (isFadedBySelection(element)) {
            out.push(element.id);
        }
        (element.children ?? []).forEach(visit);
    };
    visit(root);
    return out.sort();
}

describe('the rest of the diagram while the selection’s links are shown', () => {
    it('fades but the selection, its links’ ends, and its edges’ ends', () => {
        const root = automaton(['t']);
        noteSelection(root, 'main');
        // `t`, its states `a` and `b`, and `x` stay; the group of the rows never fades, the port goes with its node.
        expect(faded(root)).toEqual(['In', 'c', 'u', 'y']);
    });

    it('keeps the ends of an edge at a link’s end in sight, when the other end is selected', () => {
        const root = automaton(['x']);
        noteSelection(root, 'main');
        expect(faded(root)).toEqual(['In', 'c', 'u', 'y']);
    });

    it('fades nothing while no link is shown, nor in the hidden render', () => {
        const none = automaton([]);
        noteSelection(none, 'main');
        expect(faded(none)).toEqual([]);
        // A state has no links: selecting it fades nothing.
        const state = automaton(['c']);
        noteSelection(state, 'main');
        expect(faded(state)).toEqual([]);
        const hidden = automaton(['t']);
        noteSelection(hidden, 'hidden');
        expect(faded(hidden)).toEqual([]);
    });

    it('keeps all a group a link leads to holds', () => {
        const root = model([
            element('t', T.EDGE_TRANSITION, { sourceId: 'a', targetId: 'b', selected: true }),
            element('a', T.NODE_STATE), element('b', T.NODE_STATE), element('c', T.NODE_STATE),
            element('g', T.NODE_GROUP, { children: [element('m1', T.NODE_ACTOR), element('m2', T.NODE_ACTOR)] })
        ], [{ from: 't', to: 'g' }]);
        noteSelection(root, 'main');
        expect(faded(root)).toEqual(['c']);
    });

    it('never fades a node that holds nodes under something else, but what it holds does', () => {
        const root = model([
            element('t', T.EDGE_TRANSITION, { sourceId: 'a', targetId: 'b', selected: true }),
            element('a', T.NODE_STATE), element('b', T.NODE_STATE), element('x', T.NODE_ACTOR),
            element('outer', T.NODE_ACTOR, { children: [{ id: 'outer.comp', type: T.COMPARTMENT_HEADER, children: [element('inner', T.NODE_ACTOR)] }] })
        ], [{ from: 't', to: 'x' }]);
        noteSelection(root, 'main');
        expect(faded(root)).toEqual(['inner']);
    });

    it('keeps the other part of an edge cut at a group’s frame, but not where the edge ends at the group', () => {
        const framed = (groupEnd: boolean): any => model([
            element('p', T.NODE_ACTOR, { children: [{ id: 'p.o', type: T.PORT_OUTPUT }] }),
            element('g', T.NODE_GROUP, {
                children: [
                    { id: 'g.b', type: T.PORT_GROUP_BOUNDARY, ...(groupEnd ? { args: { [WorkflowDiagramMetadata.GROUP_END]: true } } : {}) },
                    element('m', T.NODE_ACTOR, { children: [{ id: 'm.i', type: T.PORT_INPUT }] })
                ]
            }),
            element('in', T.EDGE_CONNECTION, { sourceId: 'p.o', targetId: 'g.b', selected: true }),
            element('on', T.EDGE_CONNECTION, { sourceId: 'g.b', targetId: 'm.i' }),
            element('q', T.NODE_ACTOR), element('r', T.NODE_ACTOR), element('x', T.NODE_ACTOR),
            element('other', T.EDGE_CONNECTION, { sourceId: 'q', targetId: 'r' })
        ], [{ from: 'in', to: 'x' }]);
        const cut = framed(false);
        noteSelection(cut, 'main');
        expect(faded(cut)).toEqual(['other', 'q', 'r']);
        const atGroup = framed(true);
        noteSelection(atGroup, 'main');
        expect(faded(atGroup)).toEqual(['m', 'on', 'other', 'q', 'r']);
    });

    it('draws the line a kept transition shares with one that fades', () => {
        const pair = (links: Array<{ from: string; to: string }>, selected: string[]): any => {
            const state = (id: string, x: number): any => element(id, T.NODE_STATE, {
                position: { x, y: 0 }, size: { width: 80, height: 36 }, args: { [WorkflowDiagramMetadata.ENTITY_NAME]: id }
            });
            const [a, b] = [state('a', 0), state('b', 300)];
            const transition = (id: string): any => ({
                id, type: T.EDGE_TRANSITION, sourceId: 'a', targetId: 'b', source: a, target: b,
                args: { [WorkflowDiagramMetadata.EDGE_LABEL]: id, [WorkflowDiagramMetadata.TRANSITION_LABEL_WIDTH]: 60 }
            });
            const root = model([a, b, transition('t1'), transition('t2'), element('x', T.NODE_ACTOR, { position: { x: 0, y: 200 } })], links);
            root.children.forEach((child: any) => { child.selected = selected.includes(child.id); });
            noteSelection(root, 'main');
            return root;
        };
        const lines = (root: any, id: string): number =>
            withClass(new TransitionEdgeView().render(root.children.find((each: any) => each.id === id), {} as any), 'edge-line').length;
        // With nothing selected, one of the two draws the line.
        const plain = pair([], []);
        const drawing = ['t1', 't2'].filter(id => lines(plain, id) === 1);
        expect(drawing).toHaveLength(1);
        const other = drawing[0] === 't1' ? 't2' : 't1';
        // The other is at a link's end: the one that drew the line fades, and the other draws it.
        const root = pair([{ from: 'x', to: other }], ['x']);
        expect(faded(root)).toEqual([drawing[0]]);
        expect(lines(root, other)).toBe(1);
    });

    it('never fades an edge in error, nor what is on the selection’s trace', () => {
        const root = automaton(['t']);
        noteSelection(root, 'main');
        const u = root.children.find((each: any) => each.id === 'u');
        const c = root.children.find((each: any) => each.id === 'c');
        expect([fadesBehindSelection(u), fadesBehindSelection(c)]).toEqual([true, true]);
        u.cssClasses = ['cal-edge-error'];
        c.cssClasses = ['wf-trace-downstream'];
        expect([fadesBehindSelection(u), fadesBehindSelection(c)]).toEqual([false, false]);
    });

    it('is put on the drawing of what fades, and only on it', () => {
        const root = automaton(['t']);
        noteSelection(root, 'main');
        const post = new SelectionFocusPostprocessor();
        const drawingOf = (id: string): any => post.decorate({ sel: 'g', data: { class: { mine: true } } } as any, root.children.find((each: any) => each.id === id));
        expect(drawingOf('u').data.class).toEqual({ mine: true, [FOCUS_FADED_CLASS]: true });
        expect(drawingOf('t').data.class).toEqual({ mine: true });
    });
});
