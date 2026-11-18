/**
 * A node the producer says is drawn as a symbol (`meta.symbol`): sized and
 * pinned from `SymbolGeometry`, no header, its pins in the symbol's order (a
 * mux's select below its data), a register's pins named by what they are.
 */
import { describe, expect, it } from 'vitest';
import { estimatePinLabelSize, estimatePortLabelBox, estimatePortLabelSize, estimateTextSize, portLabelParts, SymbolGeometry, WorkflowDiagramConstants, WorkflowDiagramCss, WorkflowDiagramMetadata } from '@dialogram/shared';
import { GraphGModelSource, type PyGraphDocument, type PyGraphNode } from '../src/model/graph-gmodel-source';

const port = (node: string, name: string, direction: 'in' | 'out', pins?: string[]) =>
    ({ id: `port:${node}:${name}`, name, direction, ...(pins ? { pins } : {}) });

function transform(nodes: PyGraphNode[]): any {
    const doc: PyGraphDocument = { version: '1', graph: { id: 'top', nodes, edges: [] } };
    return new GraphGModelSource().transform(doc).graph;
}

const ports = (gnode: any) => gnode.children.filter((c: any) => typeof c.type === 'string' && c.type.startsWith('port'));

/** A field of a bundle register: a port on one of its pins, a member of `group`. */
const field = (name: string, direction: 'in' | 'out', pin: string, group: string) =>
    ({ ...port('n:reg', `${group}.${name}`, direction, [pin]), name, group });

const registerOf = (fields: ReturnType<typeof field>[]): PyGraphDocument => ({ version: '1', graph: { id: 'top', edges: [], nodes: [{
    id: 'n:reg', kind: 'reg', label: 'slot', scope: 'root', ports: fields, meta: { symbol: 'register' }
}] } });

/** The register of `doc`, its buses open or closed. */
const registerNode = (doc: PyGraphDocument, open: boolean): any => new GraphGModelSource()
    .transform(doc, open ? { portBuses: { isExpanded: () => true } } : undefined).graph.children
    .find((c: any) => c.args?.[WorkflowDiagramMetadata.SYMBOL] === 'register');

const label = (gnode: any, name: string): string | undefined =>
    ports(gnode).find((p: any) => p.args[WorkflowDiagramMetadata.PORT_NAME] === name)?.children[0].text;

/** A register pin's name's width as the platform estimates it, on the server and in the client alike. */
const textWidth = (text: string, pin?: string): number => estimatePinLabelSize(text, pin).width;

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

    it('name the members of a bus opened on a register by the field each carries', () => {
        // A register of a bundle: a `d` and a `q` per field, a bus each way.
        const doc = registerOf([field('valid', 'in', 'd', 'in'), field('bits_speculative_child', 'in', 'd', 'in'),
            field('valid', 'out', 'q', 'out'), field('bits_speculative_child', 'out', 'q', 'out')]);
        const closed = registerNode(doc, false);
        expect(label(closed, 'in')).toBe('d');
        expect(label(closed, 'out')).toBe('q');

        const open = registerNode(doc, true);
        const members = ports(open).filter((p: any) => p.cssClasses.includes(WorkflowDiagramCss.PORT_BUS_MEMBER));
        expect(members.map((p: any) => p.children[0].text).sort())
            .toEqual(['bits_speculative_child', 'bits_speculative_child', 'valid', 'valid']);
        // Each name's box holds the rail the client draws in front of it.
        for (const member of members) {
            const name = member.children[0];
            expect(name.size.width).toBeGreaterThanOrEqual(textWidth(name.text) + WorkflowDiagramConstants.PORT_BUS_RAIL_SLOT_PX);
        }
        // And the body holds the widest input name and the widest output
        // name side by side, slots and all, without the two meeting.
        const widest = (east: boolean) => Math.max(...ports(open)
            .filter((p: any) => (p.position.x > 0) === east).map((p: any) => p.children[0].size.width));
        expect(open.size.width).toBeGreaterThanOrEqual(2 * SymbolGeometry.STUB_PX
            + widest(false) + widest(true) + 2 * SymbolGeometry.PIN_NAME_INSET_PX + SymbolGeometry.PIN_NAME_SPACING_PX);
        expect(open.size.width).toBeGreaterThan(closed.size.width);
    });

    it('name a member on another pin than its bus by that pin as well, apart from its name', () => {
        // A bundle of fields written together, and its `valid` the enable.
        const doc = registerOf([field('valid', 'in', 'en', 'in'), field('addr', 'in', 'd', 'in'), field('data', 'in', 'd', 'in'),
            field('addr', 'out', 'q', 'out'), field('data', 'out', 'q', 'out')]);
        // The bus is named by the pin most of its members are.
        expect(label(registerNode(doc, false), 'in')).toBe('d');
        const open = registerNode(doc, true);
        const members = ports(open).filter((p: any) => p.cssClasses.includes(WorkflowDiagramCss.PORT_BUS_MEMBER) && p.position.x < 0);
        const pinOf = (name: string) => members.find((p: any) => p.children[0].text === name).children[0].args[WorkflowDiagramMetadata.PORT_LABEL_PIN];
        // The name is the field's, whatever it looks like; the pin is said apart.
        expect(members.map((p: any) => p.children[0].text).sort()).toEqual(['addr', 'data', 'valid']);
        expect(['addr', 'data', 'valid'].map(pinOf)).toEqual([undefined, undefined, 'en']);
        const valid = members.find((p: any) => p.children[0].text === 'valid').children[0];
        expect(valid.size.width).toBeGreaterThanOrEqual(textWidth('valid', 'en') + WorkflowDiagramConstants.PORT_BUS_RAIL_SLOT_PX);
    });

    it('draw an open bus’s members under it, whatever pins they are on', () => {
        // Two enables and a field: the bus is named and placed by `en`, and
        // its `d` member, which comes before `en` among a register's pins,
        // is still under it, not above.
        const doc = registerOf([field('valid', 'in', 'en', 'in'), field('ready', 'in', 'en', 'in'), field('addr', 'in', 'd', 'in'),
            field('x', 'in', 'd', 'x'), field('y', 'in', 'd', 'x'),
            field('addr', 'out', 'q', 'out'), field('data', 'out', 'q', 'out')]);
        const open = registerNode(doc, true);
        const west = ports(open).filter((p: any) => p.position.x < 0 && p.args[WorkflowDiagramMetadata.PORT_NAME] !== 'clk')
            .sort((a: any, b: any) => a.position.y - b.position.y)
            .map((p: any) => `${p.args[WorkflowDiagramMetadata.PORT_BUS_MEMBER_OF] ? '  ' : ''}${p.args[WorkflowDiagramMetadata.PORT_NAME]}`);
        // The `x` bus (`d`) first, its members under it; then the `in` bus
        // (`en`), its `d` member and then its enables under it.
        expect(west).toEqual(['x', '  x', '  y', 'in', '  addr', '  valid', '  ready']);
    });

    it('keep a bus with one clock member among its fields on the rows, the member with it', () => {
        // Two fields on `d` and one on the clock: the bus is named `d`, so it
        // is no clock, and its `clk` member stays inside its rail.
        const doc = registerOf([field('a', 'in', 'd', 'in'), field('b', 'in', 'd', 'in'), field('tick', 'in', 'clk', 'in'),
            field('a', 'out', 'q', 'out'), field('b', 'out', 'q', 'out')]);
        const west = (gnode: any) => ports(gnode).filter((p: any) => p.position.x < 0)
            .sort((a: any, b: any) => a.position.y - b.position.y);
        const closed = registerNode(doc, false);
        expect(label(closed, 'in')).toBe('d');
        const open = registerNode(doc, true);
        expect(west(open).map((p: any) => `${p.args[WorkflowDiagramMetadata.PORT_BUS_MEMBER_OF] ? '  ' : ''}${p.args[WorkflowDiagramMetadata.PORT_NAME]}`))
            .toEqual(['in', '  a', '  b', '  tick']);
        // One row each, a row apart: the rail runs from the header down its members.
        const centres = west(open).map((p: any) => p.position.y + p.size.height / 2);
        const steps = centres.slice(1).map((y: number, k: number) => y - centres[k]);
        expect(new Set(steps).size).toBe(1);
        expect(label(open, 'tick')).toBe('tick');
    });

    it('never put a bus at the clock wedge, even one most of whose members are on the clock', () => {
        // Two fields on `clk` and one on `d`: the bus is named `clk`, and is
        // still on the rows, its members under it in its rail, the `d` one
        // saying so; only a port of its own on `clk` is at the wedge.
        const doc = registerOf([field('c0', 'in', 'clk', 'in'), field('c1', 'in', 'clk', 'in'), field('x', 'in', 'd', 'in'),
            field('x', 'out', 'q', 'out'), field('y', 'out', 'q', 'out')]);
        const west = (gnode: any) => ports(gnode).filter((p: any) => p.position.x < 0)
            .sort((a: any, b: any) => a.position.y - b.position.y);
        const wedge = (gnode: any) => SymbolGeometry.clockY(SymbolGeometry.bodyHeight('register', gnode.size.height, true));
        const centre = (p: any) => p.position.y + p.size.height / 2;

        const closed = registerNode(doc, false);
        expect(label(closed, 'in')).toBe('clk');
        expect(west(closed).map(centre)).not.toContain(wedge(closed));
        expect(closed.size.height).toBe(SymbolGeometry.size('register', 1, 1, undefined, true).height);

        const open = registerNode(doc, true);
        expect(west(open).map((p: any) => `${p.args[WorkflowDiagramMetadata.PORT_BUS_MEMBER_OF] ? '  ' : ''}${p.args[WorkflowDiagramMetadata.PORT_NAME]}`))
            .toEqual(['in', '  x', '  c0', '  c1']);
        const centres = west(open).map(centre);
        expect(centres).not.toContain(wedge(open));
        expect(new Set(centres.slice(1).map((y: number, k: number) => y - centres[k])).size).toBe(1);
        expect(open.size.height).toBe(SymbolGeometry.size('register', 4, 3, undefined, true).height);
        // Named by the field each carries, the `d` one by its pin as well.
        const pinOf = (name: string) => ports(open).find((p: any) => p.args[WorkflowDiagramMetadata.PORT_NAME] === name && p.position.x < 0)
            .children[0].args[WorkflowDiagramMetadata.PORT_LABEL_PIN];
        expect(['x', 'c0', 'c1'].map(pinOf)).toEqual(['d', undefined, undefined]);
        // The body holds its widest name, the `d x` one, rail and all.
        const xBox = ports(open).find((p: any) => p.args[WorkflowDiagramMetadata.PORT_NAME] === 'x' && p.position.x < 0).children[0].size.width;
        expect(xBox).toBe(textWidth('x', 'd') + WorkflowDiagramConstants.PORT_BUS_RAIL_SLOT_PX);
    });

    it('keep each side’s members under that side’s bus, a bundle on both sides', () => {
        // A bus is keyed by its group and its side (`bundlePorts`), so a
        // member is always on its bus's side: two members of `in` placed east
        // are a bus of their own there, under it.
        const doc = registerOf([field('a', 'in', 'd', 'in'), field('b', 'in', 'd', 'in'),
            { ...field('c', 'in', 'en', 'in'), side: 'east' }, { ...field('e', 'in', 'en', 'in'), side: 'east' },
            field('a', 'out', 'q', 'out'), field('b', 'out', 'q', 'out')]);
        const open = registerNode(doc, true);
        const side = (east: boolean) => ports(open).filter((p: any) => (p.position.x > 0) === east)
            .sort((a: any, b: any) => a.position.y - b.position.y)
            .map((p: any) => `${p.args[WorkflowDiagramMetadata.PORT_BUS_MEMBER_OF] ? '  ' : ''}${p.args[WorkflowDiagramMetadata.PORT_NAME]}`);
        expect(side(false)).toEqual(['in', '  a', '  b']);
        expect(side(true)).toEqual(['in', '  c', '  e', 'out', '  a', '  b']);
    });

    it('name a bus whose pins tie by the one a register lists first, in any order of its fields', () => {
        for (const [first, second] of [['en', 'd'], ['d', 'en']]) {
            const doc = registerOf([field('p', 'in', first, 'in'), field('r', 'in', second, 'in'),
                field('p', 'out', 'q', 'out'), field('r', 'out', 'q', 'out')]);
            expect(label(registerNode(doc, false), 'in')).toBe('d');
        }
    });

    it('size a pin said before a name as it is drawn: the pin, the gap, the name', () => {
        const parts = portLabelParts('valid', 'en');
        expect(parts.map(part => part.text)).toEqual(['en', 'valid']);
        expect(parts[1].dx).toBe(WorkflowDiagramConstants.PORT_LABEL_PIN_GAP_PX);
        const font = WorkflowDiagramConstants.PORT_LABEL_FONT_SIZE_PX;
        expect(estimatePinLabelSize('valid', 'en').width).toBe(estimateTextSize('en', font).width
            + WorkflowDiagramConstants.PORT_LABEL_PIN_GAP_PX + estimateTextSize('valid', font).width);
        expect(estimatePinLabelSize('valid').width).toBe(estimateTextSize('valid', font).width);
    });

    it('give a name of wide characters the columns it takes', () => {
        // A producer's names are any text: a wide character is two columns.
        const reg = registerNode(registerOf([field('時間', 'in', 'd', 'in'), field('abcd', 'in', 'd', 'in'),
            field('x', 'out', 'q', 'out'), field('y', 'out', 'q', 'out')]), true);
        const box = (text: string) => ports(reg).find((p: any) => p.children[0].text === text).children[0].size.width;
        expect(box('時間')).toBe(box('abcd'));
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

describe('port names before the client measures them', () => {
    it('are estimated as they always were when they are no symbol pin', () => {
        // 0.7 of the font a character and 3 px each side; a line and a quarter
        // high. Every product's labels are placed by it until measured.
        expect(estimatePortLabelSize('abc')).toEqual({ width: Math.ceil(3 * 12 * 0.7 + 6), height: 15 });
        expect(estimatePortLabelSize('時間').width).toBe(estimatePortLabelSize('ab').width);
        expect(estimateTextSize('時間', 12).width).toBe(estimateTextSize('ab', 12).width);
    });

    it('size a node by its name as they always did, whatever characters it has', () => {
        const width = (name: string) => transform([{ id: 'n:x', kind: 'logic', label: name, scope: 'root', ports: [] }])
            .children.find((c: any) => c.id === name).size.width;
        expect(width('時間'.repeat(15))).toBe(width('ab'.repeat(15)));
    });

    it('are estimated as the server sized them when they are a symbol pin, with their slot', () => {
        const member = { cssClasses: [WorkflowDiagramCss.SYMBOL_PIN], args: { [WorkflowDiagramMetadata.PORT_BUS_MEMBER_OF]: 'in' } };
        const box = estimatePortLabelBox(member, { text: 'valid', args: { [WorkflowDiagramMetadata.PORT_LABEL_PIN]: 'en' } });
        expect(box).toEqual({ width: textWidth('valid', 'en') + WorkflowDiagramConstants.PORT_BUS_RAIL_SLOT_PX,
            height: estimatePinLabelSize('valid').height, slot: WorkflowDiagramConstants.PORT_BUS_RAIL_SLOT_PX });
        expect(estimatePortLabelBox({ args: {} }, { text: 'abc' })).toEqual({ ...estimatePortLabelSize('abc'), slot: 0 });
    });

    it('are placed before they are measured where the server sized them', async () => {
        // An output member of an open bus on a register, its pin said: placed
        // with no size, as on a reopen, it lands where its sized box does.
        const { placePortLabel } = await import('../src/server/port-labels');
        const doc = registerOf([field('a', 'in', 'd', 'in'), field('b', 'in', 'd', 'in'),
            field('a', 'out', 'q', 'out'), field('b', 'out', 'q', 'out'), field('ok', 'out', 'en', 'out')]);
        const open = registerNode(doc, true);
        const ok = ports(open).find((p: any) => p.args[WorkflowDiagramMetadata.PORT_NAME] === 'ok');
        const sized = { ...ok.children[0] };
        const unsized = { ...ok.children[0], size: undefined };
        placePortLabel(sized, ok, 3);
        placePortLabel(unsized, ok, 3);
        expect(unsized.position).toEqual(sized.position);
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
