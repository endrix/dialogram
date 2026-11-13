/**
 * What a list draws, and what a transition's label says of the tokens its
 * action moves.
 *
 * A member of a list is a row of a table: a body, the family's mark down its
 * left edge, its name and its lines at the columns the server gave it. A link
 * leaves a row by a side, never along the table. A transition's label ends
 * in the tokens its action takes and gives, after its condition's mark.
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { WorkflowDiagramConstants, WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import { listRowOf, renderListRow } from '../src/list-row-view';
import { nodeFamilyCss } from '../src/palette-icons';
import { renderSelectionLinks, type LinkElement } from '../src/selection-links';
import { TransitionEdgeView } from '../src/automaton-views';

// The GLSP `svg` helper gives `{tag, props, children}` here, snabbdom vnodes in a browser.
const classesOf = (vnode: any): Record<string, boolean> => vnode?.data?.class ?? vnode?.props?.class ?? {};
const attrsOf = (vnode: any): Record<string, any> => vnode?.data?.attrs ?? vnode?.props?.attrs ?? {};
const textOf = (vnode: any): string => (vnode?.children ?? []).map((c: any) => typeof c === 'string' ? c : c?.text ?? '').join('') || vnode?.text || '';

function withClass(vnode: any, name: string): any[] {
    const out: any[] = [];
    const visit = (each: any): void => {
        if (!each || typeof each !== 'object') {
            return;
        }
        if (classesOf(each)[name]) {
            out.push(each);
        }
        (each.children ?? []).forEach(visit);
    };
    visit(vnode);
    return out;
}

const ROW = { nameX: 11, cells: [{ text: 'Int(8)', x: 90, kind: 'type' }, { text: '= 0', x: 150, kind: 'initial' }, { text: 'odd', x: 190, kind: 'Not A Kind' }] };

describe('a row of a list', () => {
    it('is read from its argument, and nothing else is taken for one', () => {
        expect(listRowOf({ args: { [WorkflowDiagramMetadata.LIST_ROW]: ROW } })).toBe(ROW);
        expect(listRowOf({ args: { [WorkflowDiagramMetadata.LIST_ROW]: { cells: [] } } })).toBeUndefined();
        expect(listRowOf({ args: { [WorkflowDiagramMetadata.LIST_ROW]: 'count' } })).toBeUndefined();
        expect(listRowOf({})).toBeUndefined();
    });

    it('draws a body, the family’s mark, its name and its lines at their columns', () => {
        const node = { args: { [WorkflowDiagramMetadata.ENTITY_NAME]: 'count' }, position: { x: 8, y: 52 }, selected: true };
        const drawn = renderListRow(node, ROW, { width: 220, height: 20 }, { 'external-actor-state': true }, { renderChildren: () => [] } as any);
        expect(classesOf(drawn)).toMatchObject({ 'workflow-node': true, 'external-actor-state': true, 'list-row': true, selected: true, hover: false });
        expect(attrsOf(drawn).transform).toBe('translate(8, 52)');
        expect(attrsOf(withClass(drawn, 'list-row-body')[0])).toMatchObject({ width: 220, height: 20 });
        expect(attrsOf(withClass(drawn, 'list-row-mark')[0])).toMatchObject({ x: 0, width: WorkflowDiagramConstants.LIST_ROW_MARK_PX, height: 20 });
        const [name] = withClass(drawn, 'list-row-name');
        expect([textOf(name), attrsOf(name).x, attrsOf(name).y]).toEqual(['count', 11, 10]);
        const cells = withClass(drawn, 'list-row-cell');
        expect(cells.map(cell => [textOf(cell), attrsOf(cell).x])).toEqual([['Int(8)', 90], ['= 0', 150], ['odd', 190]]);
        // A kind the product can colour; one that is no class name is none.
        expect(classesOf(cells[0])['list-row-cell-type']).toBe(true);
        expect(classesOf(cells[1])['list-row-cell-initial']).toBe(true);
        expect(Object.keys(classesOf(cells[2])).sort()).toEqual(['list-row-cell', 'list-row-text']);
    });

    it('wears its family’s colour down its mark', () => {
        expect(nodeFamilyCss([{ annotation: 'state', color: '#12a38c' }]))
            .toMatch(/\.list-row\.external-actor-state \.list-row-mark \{\s*fill: #12a38c;\s*\}/);
    });

    it('is left by a side by a link, not along the rows above and below it', () => {
        const row = (id: string, y: number, list: boolean, extra: Record<string, unknown> = {}): LinkElement => ({
            id, type: WorkflowDiagramTypes.NODE_ACTOR, position: { x: 8, y }, size: { width: 200, height: 20 },
            ...(list ? { args: { [WorkflowDiagramMetadata.LIST_ROW]: ROW } } : {}), ...extra
        } as LinkElement);
        const startOf = (list: boolean): { x: number; y: number } => {
            const frame = {
                id: 'frame', type: WorkflowDiagramTypes.NODE_GROUP, position: { x: 0, y: 0 }, size: { width: 216, height: 80 },
                children: [row('first', 32, list, { selected: true }), row('second', 52, list)]
            };
            const act = { id: 'act', type: WorkflowDiagramTypes.NODE_ACTOR, position: { x: 300, y: -400 }, size: { width: 100, height: 40 } };
            const model: any = {
                id: 'root', type: WorkflowDiagramTypes.GRAPH,
                args: { [WorkflowDiagramMetadata.SELECTION_LINKS]: [{ id: 'l', from: 'first', to: 'act' }] },
                children: [frame, act]
            };
            const adopt = (parent: any): void => (parent.children ?? []).forEach((child: any) => { child.parent = parent; adopt(child); });
            adopt(model);
            const [line] = withClass(renderSelectionLinks(model), 'selection-link-line');
            const [x, y] = String(attrsOf(line).d).match(/-?\d+(\.\d+)?/g)!.map(Number);
            return { x, y };
        };
        // A card at the top of its frame leaves by its top, toward what is above it.
        expect(startOf(false).y).toBe(32);
        // A row leaves by its side.
        const start = startOf(true);
        expect(start.x).toBe(208);
        expect(start.y).toBeGreaterThan(32);
        expect(start.y).toBeLessThan(52);
    });
});

describe('the label of a transition', () => {
    const drawn = (args: Record<string, unknown>): any => {
        const state = (id: string, x: number): any => ({
            id, type: WorkflowDiagramTypes.NODE_STATE, position: { x, y: 0 }, size: { width: 80, height: 36 },
            args: { [WorkflowDiagramMetadata.ENTITY_NAME]: id }
        });
        const [a, b] = [state('a', 0), state('b', 300)];
        const edge: any = {
            id: 't', type: WorkflowDiagramTypes.EDGE_TRANSITION, sourceId: 'a', targetId: 'b', source: a, target: b,
            args: { [WorkflowDiagramMetadata.EDGE_LABEL]: 'go', [WorkflowDiagramMetadata.TRANSITION_LABEL_WIDTH]: 120, ...args }
        };
        const root = { id: 'root', children: [a, b, edge] };
        edge.root = root;
        return new TransitionEdgeView().render(edge, {} as any);
    };

    it('ends in the tokens its action takes and gives, after the condition’s mark, and says them in its title', () => {
        const label = drawn({ [WorkflowDiagramMetadata.TRANSITION_CONDITION]: 'self.ready()', [WorkflowDiagramMetadata.TRANSITION_TOKENS]: 'In×384 → Out' });
        const [tokens] = withClass(label, 'transition-tokens');
        expect(textOf(tokens)).toBe('In×384 → Out');
        expect(attrsOf(tokens).dx).toBe(WorkflowDiagramConstants.TRANSITION_TOKENS_GAP_PX);
        const [title] = withClass({ children: withClass(label, 'transition-label') }, 'transition-label')
            .flatMap((g: any) => (g.children ?? []).filter((c: any) => c?.sel === 'title' || c?.tag === 'title'));
        expect(textOf(title)).toBe('go, when self.ready()\nIn×384 → Out');
    });

    it('has no tokens when its action moves none', () => {
        expect(withClass(drawn({}), 'transition-tokens')).toEqual([]);
    });
});
