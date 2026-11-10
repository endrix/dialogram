/**
 * A toggle lays the whole view out again (the server's toggle-port-bus-handler.ts);
 * the view then scrolls so the bus, or the node, pressed stands where it stood
 * on screen.
 */
import { describe, expect, it, vi } from 'vitest';
import { TogglePortBusOperation, ToggleNodeOpenOperation, WorkflowDiagramMetadata } from '@dialogram/shared';
import { ToggleAnchor, absolutePosition, anchoredScroll, toggledIn } from '../src/toggle-anchor';
import { PORT_BUS_TOGGLE_ATTR, PortBusToggleMouseListener } from '../src/port-bus-toggle';
import { NODE_OPEN_TOGGLE_ATTR, NodeOpenToggleMouseListener } from '../src/node-open-toggle';

type Point = { x: number; y: number };

/** A root with one node holding a bus port, at the given places, indexed as sprotty's is. */
function root(node: Point, expanded: boolean, scroll: Point = { x: 0, y: 0 }, extra: any[] = []): any {
    const r: any = { id: 'graph', zoom: 2, scroll, children: [] };
    const n: any = { id: 'u_prod', position: node, parent: r, args: { [WorkflowDiagramMetadata.AST_PATH]: 'u_prod' }, children: [] };
    const p: any = { id: 'u_prod_bus_m', position: { x: 95, y: 30 }, parent: n, args: { [WorkflowDiagramMetadata.PORT_BUS_EXPANDED]: expanded } };
    n.children.push(p);
    r.children.push(n, ...extra.map(e => ({ ...e, parent: r })));
    const all = new Map<string, any>();
    const walk = (e: any): void => { all.set(e.id, e); (e.children ?? []).forEach(walk); };
    walk(r);
    r.index = { getById: (id: string) => all.get(id) };
    return r;
}

function anchor(): { anchor: ToggleAnchor; dispatch: ReturnType<typeof vi.fn> } {
    const a = new ToggleAnchor();
    const dispatch = vi.fn();
    (a as any).dispatcher = { dispatch };
    return { anchor: a, dispatch };
}

describe('keeping a toggled node where it was on screen', () => {
    it('reads an element’s place in the diagram through its parents', () => {
        const r = root({ x: 100, y: 40 }, false);
        expect(absolutePosition(r.index.getById('u_prod_bus_m'))).toEqual({ x: 195, y: 70 });
        expect(anchoredScroll({ x: 10, y: 20 }, { x: 195, y: 70 }, { x: 1195, y: 170 })).toEqual({ x: 1010, y: 120 });
    });

    it('scrolls by as far as the toggle moved the bus, once the bus has changed', async () => {
        vi.useFakeTimers();
        try {
            const { anchor: a, dispatch } = anchor();
            a.remember(root({ x: 100, y: 40 }, false, { x: 10, y: 20 }), 'u_prod_bus_m');
            // A model that is not the toggle's answer yet (the bus is as it was): nothing.
            a.modelRootChanged(root({ x: 100, y: 40 }, false, { x: 10, y: 20 }));
            vi.runAllTimers();
            expect(dispatch).not.toHaveBeenCalled();
            // The answer: the bus is open and the layout moved it.
            a.modelRootChanged(root({ x: 600, y: 340 }, true, { x: 10, y: 20 }));
            vi.runAllTimers();
            expect(dispatch).toHaveBeenCalledTimes(1);
            const action = dispatch.mock.calls[0][0];
            expect(action.kind).toBe('viewport');
            expect(action.elementId).toBe('graph');
            expect(action.newViewport).toEqual({ scroll: { x: 510, y: 320 }, zoom: 2 });
            // Once only.
            a.modelRootChanged(root({ x: 900, y: 340 }, false));
            vi.runAllTimers();
            expect(dispatch).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('follows a node into the frame it opened into, and a frame back into its node', () => {
        const frame = { id: 'scope:open:p', position: { x: 700, y: 50 }, args: { [WorkflowDiagramMetadata.OPEN_NODE_KEY]: 'u_prod' } };
        expect(toggledIn(root({ x: 0, y: 0 }, false, undefined, [frame]), { id: 'gone', key: 'u_prod' })?.id).toBe('scope:open:p');
        expect(toggledIn(root({ x: 0, y: 0 }, false), { id: 'scope:open:p', openKey: 'u_prod' })?.id).toBe('u_prod');
    });

    it('is told by both toggles what was pressed, before their operation goes', () => {
        const remembered: string[] = [];
        const fake = { remember: (_root: unknown, id: string) => { remembered.push(id); } };
        const press = (attr: string, value: string) => ({
            button: 0,
            target: { closest: (selector: string) => (selector === `[${attr}]` ? { getAttribute: () => value } : null) },
            preventDefault() {},
            stopPropagation() {}
        }) as unknown as MouseEvent;
        const bus = new PortBusToggleMouseListener();
        (bus as any).anchor = fake;
        const node = new NodeOpenToggleMouseListener();
        (node as any).anchor = fake;
        const target = { root: {} } as any;
        expect(bus.mouseDown(target, press(PORT_BUS_TOGGLE_ATTR, 'u_prod_bus_m'))).toEqual([TogglePortBusOperation.create({ portId: 'u_prod_bus_m' })]);
        expect(node.mouseDown(target, press(NODE_OPEN_TOGGLE_ATTR, 'u_prod'))).toEqual([ToggleNodeOpenOperation.create({ nodeId: 'u_prod' })]);
        expect(remembered).toEqual(['u_prod_bus_m', 'u_prod']);
    });
});
