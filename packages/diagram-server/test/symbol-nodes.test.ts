/**
 * A node the producer says is drawn as a symbol (`meta.symbol`): sized and
 * pinned from `SymbolGeometry`, no header, its pins in the symbol's order (a
 * mux's select below its data), a register's pins named by what they are.
 */
import { describe, expect, it } from 'vitest';
import { SymbolGeometry, WorkflowDiagramCss, WorkflowDiagramMetadata } from '@dialogram/shared';
import { GraphGModelSource, type PyGraphDocument, type PyGraphNode } from '../src/model/graph-gmodel-source';

const port = (node: string, name: string, direction: 'in' | 'out', pins?: string[]) =>
    ({ id: `port:${node}:${name}`, name, direction, ...(pins ? { pins } : {}) });

function transform(nodes: PyGraphNode[]): any {
    const doc: PyGraphDocument = { version: '1', graph: { id: 'top', nodes, edges: [] } };
    return new GraphGModelSource().transform(doc).graph;
}

const ports = (gnode: any) => gnode.children.filter((c: any) => typeof c.type === 'string' && c.type.startsWith('port'));

describe('symbol nodes', () => {
    it('are sized by the symbol, have no header, and put their pins on the body', () => {
        const graph = transform([{
            id: 'n:and', kind: 'logic', label: 'a & b', scope: 'root',
            ports: [port('n:and', 'y', 'out', ['y']), port('n:and', 'a', 'in', ['a']), port('n:and', 'b', 'in', ['b'])],
            meta: { symbol: 'and' }
        }]);
        const node = graph.children.find((c: any) => c.id === 'a & b');
        expect(node.size).toEqual(SymbolGeometry.size('and', 2, 1));
        expect(node.args[WorkflowDiagramMetadata.SYMBOL]).toBe('and');
        expect(node.children.some((c: any) => c.type === 'comp:header')).toBe(false);
        const pins = ports(node);
        const centre = (p: any) => p.position.y + p.size.height / 2;
        const [a, b] = pins.filter((p: any) => p.position.x < 0);
        expect([centre(a), centre(b)]).toEqual([0, 1].map(k => SymbolGeometry.pinY(node.size.height, 2, k)));
        expect(pins.every((p: any) => p.cssClasses.includes(WorkflowDiagramCss.SYMBOL_PIN))).toBe(true);
        // A gate's pin names say nothing a wire does not, and take no room.
        expect(pins.every((p: any) => p.children[0].cssClasses.includes(WorkflowDiagramCss.SYMBOL_PIN_LABEL_HIDDEN))).toBe(true);
        expect(pins.every((p: any) => p.children[0].size.width === 0)).toBe(true);
    });

    it('put a mux select below its data, whatever order the producer lists them', () => {
        const graph = transform([{
            id: 'n:mux', kind: 'logic', label: 's ? x : y', scope: 'root',
            ports: [port('n:mux', 'o', 'out', ['y']), port('n:mux', 's', 'in', ['s']),
                port('n:mux', 'x', 'in', ['b']), port('n:mux', 'y', 'in', ['a'])],
            meta: { symbol: 'mux' }
        }]);
        const node = graph.children.find((c: any) => c.id === 's ? x : y');
        const west = ports(node).filter((p: any) => p.position.x < 0)
            .sort((p: any, q: any) => p.position.y - q.position.y)
            .map((p: any) => p.args[WorkflowDiagramMetadata.PORT_NAME]);
        expect(west).toEqual(['y', 'x', 's']);
    });

    it('name a register by its caption and its pins by what they are', () => {
        const graph = transform([{
            id: 'n:reg', kind: 'logic', label: 'q', scope: 'root',
            ports: [port('n:reg', 'q', 'out', ['q']), port('n:reg', 'e', 'in', ['en']), port('n:reg', 'd', 'in', ['d'])],
            meta: { symbol: 'register' }
        }]);
        const node = graph.children.find((c: any) => c.args?.[WorkflowDiagramMetadata.SYMBOL] === 'register');
        expect(node.args[WorkflowDiagramMetadata.SYMBOL_CAPTION]).toBe('q');
        const labels = ports(node).map((p: any) => p.children[0].text);
        expect(labels.sort()).toEqual(['d', 'en', 'q']);
        expect(node.size.height).toBe(SymbolGeometry.size('register', 2, 1).height);
        // Its inputs stay clear of the clock's row, and its pin names sit inside the body.
        const body = SymbolGeometry.bodyHeight('register', node.size.height);
        const west = ports(node).filter((p: any) => p.position.x < 0);
        const lowest = Math.max(...west.map((p: any) => p.position.y + p.size.height / 2));
        expect(lowest).toBeLessThanOrEqual(SymbolGeometry.clockY(body) - SymbolGeometry.PIN_PITCH_PX / 2);
        for (const p of west) {
            expect(p.position.x + p.children[0].position.x).toBeGreaterThanOrEqual(SymbolGeometry.STUB_PX);
        }
    });

    it('caption any symbol its producer names, the body drawn above it', () => {
        const graph = transform([{
            id: 'n:mux', kind: 'instance', label: 'u_mux', type: 'mux2ds', scope: 'root',
            ports: [port('n:mux', 'dout', 'out', ['y']), port('n:mux', 'in0', 'in', ['a']),
                port('n:mux', 'in1', 'in', ['b']), port('n:mux', 'sel', 'in', ['s'])],
            meta: { symbol: 'mux', caption: 'u_mux', referencedSource: { file: '/rtl/lib.v', line: 7 } }
        }]);
        const node = graph.children.find((c: any) => c.args?.[WorkflowDiagramMetadata.SYMBOL] === 'mux');
        expect(node.args[WorkflowDiagramMetadata.SYMBOL_CAPTION]).toBe('u_mux');
        expect(node.size).toEqual(SymbolGeometry.size('mux', 3, 1, undefined, true));
        expect(node.size.height).toBe(SymbolGeometry.size('mux', 3, 1).height + SymbolGeometry.CAPTION_HEIGHT_PX);
        // Its pins are on the body, not on the box with the caption's room.
        const body = SymbolGeometry.bodyHeight('mux', node.size.height, true);
        const centre = (p: any) => p.position.y + p.size.height / 2;
        const west = ports(node).filter((p: any) => p.position.x < 0).map(centre).sort((a: number, b: number) => a - b);
        expect(west).toEqual([0, 1, 2].map(k => SymbolGeometry.pinY(body, 3, k)));
        const [y] = ports(node).filter((p: any) => p.position.x > 0).map(centre);
        expect(y).toBe(body / 2);
        // An instance drawn as a symbol still leads to its definition.
        expect(node.args[WorkflowDiagramMetadata.REFERENCED_URI]).toContain('lib.v');
    });

    it('caption a register by its producer’s caption over its label', () => {
        const graph = transform([{
            id: 'n:reg', kind: 'instance', label: 'u_q', scope: 'root',
            ports: [port('n:reg', 'q', 'out', ['q']), port('n:reg', 'din', 'in', ['d'])],
            meta: { symbol: 'register', caption: 'u_q (dff_s)' }
        }]);
        const node = graph.children.find((c: any) => c.args?.[WorkflowDiagramMetadata.SYMBOL] === 'register');
        expect(node.args[WorkflowDiagramMetadata.SYMBOL_CAPTION]).toBe('u_q (dff_s)');
        expect(node.size.height).toBe(SymbolGeometry.size('register', 1, 1).height);
    });

    it('give a gate no caption and no room for one', () => {
        const graph = transform([{
            id: 'n:and', kind: 'logic', label: 'a & b', scope: 'root',
            ports: [port('n:and', 'y', 'out', ['y']), port('n:and', 'a', 'in', ['a'])],
            meta: { symbol: 'and' }
        }]);
        const node = graph.children.find((c: any) => c.id === 'a & b');
        expect(node.args[WorkflowDiagramMetadata.SYMBOL_CAPTION]).toBeUndefined();
        expect(node.size).toEqual(SymbolGeometry.size('and', 1, 1));
    });

    it('draw a node with no symbol, or one it does not know, as a box', () => {
        const graph = transform([{
            id: 'n:x', kind: 'logic', label: 'x', scope: 'root',
            ports: [port('n:x', 'y', 'out')], meta: { symbol: 'lut' }
        }]);
        const node = graph.children.find((c: any) => c.id === 'x');
        expect(node.args[WorkflowDiagramMetadata.SYMBOL]).toBeUndefined();
        expect(node.children.some((c: any) => c.type === 'comp:header')).toBe(true);
    });
});

describe('symbol nodes, in the corners', () => {
    it('put a register clock pin at its wedge, not on a row', () => {
        const graph = transform([{
            id: 'n:reg', kind: 'logic', label: 'q', scope: 'root',
            ports: [port('n:reg', 'q', 'out', ['q']), port('n:reg', 'd', 'in', ['d']), port('n:reg', 'clk', 'in', ['clk'])],
            meta: { symbol: 'register' }
        }]);
        const node = graph.children.find((c: any) => c.args?.[WorkflowDiagramMetadata.SYMBOL] === 'register');
        expect(node.size.height).toBe(SymbolGeometry.size('register', 1, 1).height);
        const clk = ports(node).find((p: any) => p.args[WorkflowDiagramMetadata.PORT_NAME] === 'clk');
        expect(clk.position.y + clk.size.height / 2).toBe(SymbolGeometry.clockY(SymbolGeometry.bodyHeight('register', node.size.height)));
    });

    it('widen a register for its pin names', () => {
        const graph = transform([{
            id: 'n:reg', kind: 'logic', label: 'q', scope: 'root',
            ports: [port('n:reg', 'q', 'out', ['q']), port('n:reg', 'd', 'in', ['d']), port('n:reg', 'l', 'in', ['aload'])],
            meta: { symbol: 'register' }
        }]);
        const node = graph.children.find((c: any) => c.args?.[WorkflowDiagramMetadata.SYMBOL] === 'register');
        expect(node.size.width).toBeGreaterThan(SymbolGeometry.size('register', 2, 1).width);
    });

    it('stay a box with badges, which live in a header', () => {
        const graph = transform([{
            id: 'n:and', kind: 'logic', label: 'a & b', scope: 'root',
            ports: [port('n:and', 'y', 'out', ['y'])],
            meta: { symbol: 'and', badges: [{ text: '2', kind: 'error' }] }
        }]);
        const node = graph.children.find((c: any) => c.id === 'a & b');
        expect(node.args[WorkflowDiagramMetadata.SYMBOL]).toBeUndefined();
    });

    it('meet an output stub on the body’s front at any height', () => {
        const { width, height } = SymbolGeometry.size('and', 2, 2);
        expect(SymbolGeometry.frontX('and', width, height, height / 2)).toBeCloseTo(width - SymbolGeometry.STUB_PX);
        expect(SymbolGeometry.frontX('and', width, height, 4)).toBeLessThan(width - SymbolGeometry.STUB_PX);
        expect(SymbolGeometry.frontX('not', ...Object.values(SymbolGeometry.size('not', 1, 1)) as [number, number], 11))
            .toBe(SymbolGeometry.size('not', 1, 1).width - SymbolGeometry.STUB_PX);
        const mux = SymbolGeometry.size('mux', 3, 1);
        expect(SymbolGeometry.frontX('mux', mux.width, mux.height, mux.height / 2)).toBe(mux.width - SymbolGeometry.STUB_PX);
        expect(SymbolGeometry.frontX('mux', mux.width, mux.height, 1)).toBeLessThan(mux.width - SymbolGeometry.STUB_PX);
    });
});

describe('symbol pin names', () => {
    it('stay inside the body past the stub when labels are placed again', async () => {
        const { placePortLabel } = await import('../src/server/port-labels');
        const port = { size: { width: 9, height: 7 }, args: { [WorkflowDiagramMetadata.PORT_DIRECTION]: 'input' }, cssClasses: [WorkflowDiagramCss.SYMBOL_PIN] };
        const label: any = { text: 'en', size: { width: 12, height: 10 } };
        placePortLabel(label, port, 3);
        // Relative to the port's box, which is centred on the node's border.
        expect(-port.size.width / 2 + label.position.x).toBe(SymbolGeometry.STUB_PX + SymbolGeometry.PIN_NAME_INSET_PX);
        const plain: any = { text: 'en', size: { width: 12, height: 10 } };
        placePortLabel(plain, { ...port, cssClasses: [] }, 3);
        expect(plain.position.x).toBe(port.size.width + 3);
    });
});
