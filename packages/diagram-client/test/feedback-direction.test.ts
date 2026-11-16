/**
 * Which connections on a loop are drawn as feedback: those the drawing runs
 * against the flow, as the layout draws the edges it reverses.
 */
import { describe, expect, it } from 'vitest';
import { WorkflowDiagramCss, WorkflowDiagramMetadata } from '@dialogram/shared';
import { isDrawnBackwards } from '../src/feedback-direction';
import { WorkflowEdgeView } from '../src/views';

/** A root with nodes and their ports, positions relative to their parent, and an index over them. */
function diagram(nodes: Record<string, { x: number; ports: Record<string, { x: number }> }>) {
    const root: any = { id: 'root', position: { x: 0, y: 0 }, children: [] };
    const byId = new Map<string, any>([['root', root]]);
    for (const [id, node] of Object.entries(nodes)) {
        const element: any = { id, parent: root, position: { x: node.x, y: 0 }, size: { width: 100, height: 60 }, children: [] };
        byId.set(id, element);
        for (const [portId, port] of Object.entries(node.ports)) {
            byId.set(portId, { id: portId, parent: element, position: { x: port.x, y: 20 }, size: { width: 8, height: 8 } });
        }
    }
    root.index = { getById: (id: string) => byId.get(id) };
    return root;
}

const onLoop = (sourceId: string, targetId: string, ends: string[] = [sourceId, targetId]) => ({
    sourceId, targetId, args: { [WorkflowDiagramMetadata.ON_LOOP]: true, [WorkflowDiagramMetadata.LOOP_ENDS]: ends }
});

describe('a connection on a loop', () => {
    // `cpu` in a later layer than `mul`; each has its input on the west, its output on the east.
    const root = diagram({
        mul: { x: 200, ports: { 'mul.in': { x: -4 }, 'mul.out': { x: 96 } } },
        cpu: { x: 500, ports: { 'cpu.in': { x: -4 }, 'cpu.out': { x: 96 } } }
    });

    it('is feedback where it runs back, its target left of its source', () => {
        expect(isDrawnBackwards(root, onLoop('cpu.out', 'mul.in'))).toBe(true);
        expect(isDrawnBackwards(root, onLoop('mul.out', 'cpu.in'))).toBe(false);
    });

    it('is feedback where it runs back whatever sides its ports are on', () => {
        // A `ready` out of `cpu`'s west side into `mul`'s east side runs back too.
        expect(isDrawnBackwards(root, onLoop('cpu.in', 'mul.out'))).toBe(true);
    });

    it('is judged as the whole connection where it is a piece cut at a frame', () => {
        // A piece from `cpu` to a frame port east of it, of a connection that ends at `mul`.
        const frame = diagram({
            mul: { x: 200, ports: { 'mul.in': { x: -4 } } },
            cpu: { x: 500, ports: { 'cpu.out': { x: 96 } } },
            group: { x: 700, ports: { 'group.east': { x: 96 } } }
        });
        expect(isDrawnBackwards(frame, onLoop('cpu.out', 'group.east', ['cpu.out', 'mul.in']))).toBe(true);
    });

    it('is no feedback when it is on no loop, or its ends are not in the model', () => {
        expect(isDrawnBackwards(root, { sourceId: 'cpu.out', targetId: 'mul.in', args: {} })).toBe(false);
        expect(isDrawnBackwards(root, onLoop('gone.out', 'gone.in'))).toBe(false);
    });
});

describe('the edge view', () => {
    it('gives a connection on a loop drawn back the feedback class, and one drawn forward none', () => {
        const root = diagram({
            mul: { x: 200, ports: { 'mul.in': { x: -4 }, 'mul.out': { x: 96 } } },
            cpu: { x: 500, ports: { 'cpu.in': { x: -4 }, 'cpu.out': { x: 96 } } }
        });
        const classesOf = (edge: any): Record<string, boolean> => {
            const view = Object.assign(new WorkflowEdgeView(), { isVisible: () => true });
            const vnode: any = view.render({
                id: 'e', parent: root, routingPoints: [{ x: 0, y: 0 }, { x: 10, y: 0 }], children: [], ...edge
            } as any, { targetKind: 'hidden', renderChildren: () => [] } as any);
            return vnode?.data?.class ?? vnode?.props?.class ?? {};
        };
        expect(classesOf(onLoop('cpu.out', 'mul.in'))[WorkflowDiagramCss.EDGE_FEEDBACK]).toBe(true);
        expect(classesOf(onLoop('mul.out', 'cpu.in'))[WorkflowDiagramCss.EDGE_FEEDBACK]).toBeUndefined();
    });
});
