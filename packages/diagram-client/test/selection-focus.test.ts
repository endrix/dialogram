/**
 * The rest of the diagram all but disappears while the selection's links are
 * shown (selection-focus.ts, selection-links.ts).
 *
 * Pinned here:
 *
 *  - what stays in sight: the selection, its links' ends, and the ends of
 *    every edge among them (a transition's two states);
 *  - every other node and edge fades; a node that holds nodes never does,
 *    nor does a port or a label (they go with their node or edge);
 *  - nothing fades while no link is shown (nothing selected, a selection
 *    with no links), nor in the hidden render;
 *  - the postprocessor puts the class on the drawing of what fades.
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import { isFadedBySelection, noteSelection } from '../src/selection-links';
import { FOCUS_FADED_CLASS, SelectionFocusPostprocessor } from '../src/selection-focus';

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

    it('is put on the drawing of what fades, and only on it', () => {
        const root = automaton(['t']);
        noteSelection(root, 'main');
        const post = new SelectionFocusPostprocessor();
        const drawingOf = (id: string): any => post.decorate({ sel: 'g', data: { class: { mine: true } } } as any, root.children.find((each: any) => each.id === id));
        expect(drawingOf('u').data.class).toEqual({ mine: true, [FOCUS_FADED_CLASS]: true });
        expect(drawingOf('t').data.class).toEqual({ mine: true });
    });
});
