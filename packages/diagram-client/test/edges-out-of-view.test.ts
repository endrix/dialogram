/**
 * A wire wholly outside the viewport is not drawn (views.ts), as a node
 * outside it is not; the hidden render, which measures, draws every one.
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { WorkflowEdgeView } from '../src/views';

type Point = { x: number; y: number };

/** An edge of the root with a stored route, as much of one as the view asks for. */
function edge(route: Point[], scroll: Point = { x: 0, y: 0 }, zoom = 1): any {
    const root: any = {
        id: 'root', type: 'graph', children: [], args: {},
        canvasBounds: { x: 0, y: 0, width: 800, height: 600 },
        scroll, zoom,
        // The root's own frame: where a point of the diagram is on the canvas.
        localToParent(point: Point | { x: number; y: number; width: number; height: number }) {
            const moved: any = { x: (point.x - scroll.x) * zoom, y: (point.y - scroll.y) * zoom };
            if ('width' in point) {
                moved.width = point.width * zoom;
                moved.height = point.height * zoom;
            }
            return moved;
        },
        index: { getById: () => undefined, all: () => [] }
    };
    root.root = root;
    const e: any = { id: 'e1', type: 'edge:connection', parent: root, root, children: [], args: {}, routingPoints: route, cssClasses: [] };
    root.children.push(e);
    return e;
}

function render(e: any, targetKind: 'main' | 'hidden' = 'main'): unknown {
    const view: any = new WorkflowEdgeView();
    return view.render(e, { targetKind, renderChildren: () => [] });
}

describe('a wire and the viewport', () => {
    const inside = [{ x: 100, y: 100 }, { x: 300, y: 100 }];
    const below = [{ x: 100, y: 5000 }, { x: 300, y: 5000 }];

    it('is drawn when any of it is in sight', () => {
        expect(render(edge(inside))).toBeDefined();
        // A route that crosses the viewport from outside to outside is in sight too.
        expect(render(edge([{ x: -500, y: 300 }, { x: 5000, y: 300 }]))).toBeDefined();
        // Scrolled to it.
        expect(render(edge(below, { x: 0, y: 4800 }))).toBeDefined();
    });

    it('is not drawn when all of it is out of sight', () => {
        expect(render(edge(below))).toBeUndefined();
        expect(render(edge(inside, { x: 2000, y: 0 }))).toBeUndefined();
    });

    it('is drawn all the same by the hidden render, which measures and exports', () => {
        expect(render(edge(below), 'hidden')).toBeDefined();
    });
});
