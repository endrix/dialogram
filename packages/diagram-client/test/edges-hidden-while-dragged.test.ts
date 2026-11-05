/**
 * The edges of a node being dragged are not drawn while it moves: they come
 * back as soon as their stored route reaches the ports again, which is the
 * first model update with a route for the node's new place, or the node
 * going back where it was. A move that is finished as it arrives (an arrow
 * key) hides nothing.
 */
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { WorkflowElkLiveDragRouter, isEdgeHiddenForDrag } from '../src/elk-live-drag-router';

type Point = { x: number; y: number };
type Element = {
    id: string; type: string; parent?: Element; children?: Element[];
    position?: Point; size?: { width: number; height: number };
    sourceId?: string; targetId?: string; routingPoints?: Point[];
};

/** 140x60 nodes with a 7x7 input port on the left and an output port on the right; an output anchor is (x+140, y+29.5), an input one (x, y+29.5). */
function model(): { root: any; elements: Map<string, Element> } {
    const elements = new Map<string, Element>();
    const root: any = { id: 'root', type: 'graph', children: [] as Element[] };
    const node = (id: string, x: number, y: number): void => {
        const n: Element = { id, type: 'node:actor', parent: root, children: [], position: { x, y }, size: { width: 140, height: 60 } };
        for (const [port, px] of [['in', 0], ['out', 133]] as Array<[string, number]>) {
            const p: Element = { id: `${id}.${port}`, type: port === 'in' ? 'port:input' : 'port:output', parent: n, position: { x: px, y: 26 }, size: { width: 7, height: 7 } };
            n.children!.push(p); elements.set(p.id, p);
        }
        root.children.push(n); elements.set(id, n);
    };
    const edge = (from: string, to: string, route: Point[]): void => {
        const e: Element = { id: `${from}-${to}`, type: 'edge:connection', parent: root, sourceId: `${from}.out`, targetId: `${to}.in`, routingPoints: route };
        root.children.push(e); elements.set(e.id, e);
    };
    node('a', 0, 0); node('b', 0, 200); node('t', 400, 100); node('c', 0, 400); node('d', 400, 400);
    const into = (from: Point, to: Point): Point[] => [from, { x: 270, y: from.y }, { x: 270, y: to.y }, to];
    edge('a', 't', into({ x: 140, y: 29.5 }, { x: 400, y: 129.5 }));
    edge('b', 't', into({ x: 140, y: 229.5 }, { x: 400, y: 129.5 }));
    edge('c', 'd', [{ x: 140, y: 429.5 }, { x: 400, y: 429.5 }]);
    root.index = { getById: (id: string) => elements.get(id), all: () => elements.values() };
    return { root, elements };
}

function router(root: any): { handler: WorkflowElkLiveDragRouter; dispatched: any[] } {
    const dispatched: any[] = [];
    const handler: any = new WorkflowElkLiveDragRouter();
    handler.editorContextService = { modelRoot: root };
    handler.actionDispatcher = { dispatch: async (action: any) => { dispatched.push(action); } };
    return { handler, dispatched };
}

/** The pointer moves the node, as sprotty's feedback does, and the drag router hears of it. */
function drag(m: ReturnType<typeof model>, handler: any, id: string, to: Point, finished = false): void {
    m.elements.get(id)!.position = to;
    handler.handle({ kind: 'move', moves: [{ elementId: id, toPosition: to }], finished });
}
const hidden = (m: ReturnType<typeof model>, ...ids: string[]): boolean[] => ids.map(id => isEdgeHiddenForDrag(m.root, m.elements.get(id)! as any));

describe('edges hidden while their node is dragged', () => {
    it('hides the moved node\'s edges through the drag, not the others', () => {
        const m = model();
        const { handler } = router(m.root);
        drag(m, handler, 't', { x: 400, y: 120 });
        expect(hidden(m, 'a-t', 'b-t', 'c-d')).toEqual([true, true, false]);
        drag(m, handler, 't', { x: 400, y: 160 });
        expect(hidden(m, 'a-t', 'b-t', 'c-d')).toEqual([true, true, false]);
    });

    it('draws an edge again as soon as a route for the node\'s new place is in the model', async () => {
        vi.useFakeTimers();
        try {
            const m = model();
            const { handler, dispatched } = router(m.root);
            drag(m, handler, 't', { x: 400, y: 160 });
            drag(m, handler, 't', { x: 400, y: 160 }, true);
            expect(hidden(m, 'a-t', 'b-t')).toEqual([true, true]);
            // The server's route for one edge arrives (whichever round trip brings it).
            m.elements.get('a-t')!.routingPoints = [{ x: 140, y: 29.5 }, { x: 270, y: 29.5 }, { x: 270, y: 189.5 }, { x: 400, y: 189.5 }];
            expect(hidden(m, 'a-t', 'b-t')).toEqual([false, true]);
            await vi.advanceTimersByTimeAsync(100);
            expect(dispatched.length).toBe(1);
            m.elements.get('b-t')!.routingPoints = [{ x: 140, y: 229.5 }, { x: 270, y: 229.5 }, { x: 270, y: 189.5 }, { x: 400, y: 189.5 }];
            expect(hidden(m, 'a-t', 'b-t')).toEqual([false, false]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('draws them again at once when the drag is cancelled and the node goes back', () => {
        const m = model();
        const { handler } = router(m.root);
        drag(m, handler, 't', { x: 400, y: 160 });
        expect(hidden(m, 'a-t')).toEqual([true]);
        m.elements.get('t')!.position = { x: 400, y: 100 };
        expect(hidden(m, 'a-t', 'b-t')).toEqual([false, false]);
    });

    it('draws them as they were when no route arrives', async () => {
        vi.useFakeTimers();
        try {
            const m = model();
            const { handler } = router(m.root);
            drag(m, handler, 't', { x: 400, y: 160 });
            drag(m, handler, 't', { x: 400, y: 160 }, true);
            await vi.advanceTimersByTimeAsync(100);
            expect(hidden(m, 'a-t')).toEqual([true]);
            await vi.advanceTimersByTimeAsync(1600);
            expect(hidden(m, 'a-t')).toEqual([false]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('hides nothing for a move by arrow key', () => {
        const m = model();
        const { handler } = router(m.root);
        drag(m, handler, 't', { x: 400, y: 101 }, true);
        expect(hidden(m, 'a-t', 'b-t')).toEqual([false, false]);
    });
});
