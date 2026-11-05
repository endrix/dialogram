/**
 * The edges of a node being dragged are not drawn while it moves: they come
 * back with the model update that carries the drop's routes. A move that is
 * finished as it arrives (an arrow key) hides nothing.
 */
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { WorkflowElkLiveDragRouter, isEdgeHiddenForDrag } from '../src/elk-live-drag-router';

type Element = { id: string; type: string; parent?: Element; children?: Element[]; sourceId?: string; targetId?: string };

/** a →(a-t)→ t, b →(b-t)→ t, c →(c-d)→ d, each node with an in and an out port. */
function model(): { root: any; elements: Map<string, Element> } {
    const elements = new Map<string, Element>();
    const root: any = { id: 'root', type: 'graph', children: [] as Element[] };
    const node = (id: string): void => {
        const n: Element = { id, type: 'node:actor', parent: root, children: [] };
        for (const port of ['in', 'out']) {
            const p: Element = { id: `${id}.${port}`, type: port === 'in' ? 'port:input' : 'port:output', parent: n };
            n.children!.push(p); elements.set(p.id, p);
        }
        root.children.push(n); elements.set(id, n);
    };
    const edge = (from: string, to: string): void => {
        const e: Element = { id: `${from}-${to}`, type: 'edge:connection', parent: root, sourceId: `${from}.out`, targetId: `${to}.in` };
        root.children.push(e); elements.set(e.id, e);
    };
    for (const id of ['a', 'b', 't', 'c', 'd']) { node(id); }
    edge('a', 't'); edge('b', 't'); edge('c', 'd');
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

const move = (id: string, finished = false): any => ({ kind: 'move', moves: [{ elementId: id, toPosition: { x: 10, y: 10 } }], finished });
const hidden = (root: any, ...ids: string[]): boolean[] => ids.map(id => isEdgeHiddenForDrag(root, id));

describe('edges hidden while their node is dragged', () => {
    it('hides the moved node\'s edges through the drag, not the others', () => {
        const { root } = model();
        const { handler } = router(root);
        handler.handle(move('t'));
        expect(hidden(root, 'a-t', 'b-t', 'c-d')).toEqual([true, true, false]);
        handler.handle(move('t'));
        expect(hidden(root, 'a-t', 'b-t', 'c-d')).toEqual([true, true, false]);
        handler.handle({ kind: 'updateModel' });
        handler.handle({ kind: 'updateModel' });
        handler.handle({ kind: 'setModel' });
        expect(hidden(root, 'a-t', 'b-t')).toEqual([true, true]);
    });

    it('draws them again with the model update after the drop\'s reroute went out', async () => {
        vi.useFakeTimers();
        try {
            const { root } = model();
            const { handler, dispatched } = router(root);
            handler.handle(move('t'));
            handler.handle(move('t', true));
            // The update that answers the ChangeBounds, before the reroute is sent, does not reveal.
            handler.handle({ kind: 'updateModel' });
            expect(hidden(root, 'a-t')).toEqual([true]);
            await vi.advanceTimersByTimeAsync(100);
            expect(dispatched.length).toBe(1);
            expect(hidden(root, 'a-t')).toEqual([true]);
            handler.handle({ kind: 'updateModel' });
            expect(hidden(root, 'a-t', 'b-t')).toEqual([false, false]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('draws them as they were when no routes arrive', async () => {
        vi.useFakeTimers();
        try {
            const { root } = model();
            const { handler } = router(root);
            handler.handle(move('t'));
            handler.handle(move('t', true));
            await vi.advanceTimersByTimeAsync(100);
            expect(hidden(root, 'a-t')).toEqual([true]);
            await vi.advanceTimersByTimeAsync(1600);
            expect(hidden(root, 'a-t')).toEqual([false]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('hides nothing for a move by arrow key', () => {
        const { root } = model();
        const { handler } = router(root);
        handler.handle(move('t', true));
        expect(hidden(root, 'a-t', 'b-t')).toEqual([false, false]);
    });
});
