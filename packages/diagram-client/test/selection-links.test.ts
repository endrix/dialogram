/**
 * Links drawn only while one of their ends is selected (selection-links.ts).
 *
 * Pinned here:
 *
 *  - the links are data on the root, not elements; a malformed one is passed over;
 *  - nothing selected draws nothing; a selected node brings up every link it
 *    is an end of, and the nodes at their other ends;
 *  - the other nodes that draw what a selected node draws are marked too;
 *  - a link leaves a node by the side that faces the other end, or by the side
 *    across when a neighbour of the node's own frame is in the way;
 *  - links sharing a side are spread along it in the order of the directions
 *    they lead in, so none crosses another, also when what they lead to is
 *    all in one row; two links between the same two nodes run side by side;
 *  - the drawing goes into the group the viewport transforms, on screen only,
 *    and says on the svg that links are shown.
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { WorkflowDiagramMetadata, WorkflowDiagramTypes, type SelectionLink } from '@dialogram/shared';
import {
    absoluteBox,
    linkMiddle,
    linkPath,
    linkPoint,
    placeLabels,
    linkSide,
    linksOfSelection,
    placeLinks,
    renderSelectionLinks,
    selectionLinksOf,
    withSelectionLinks,
    type Box,
    type LinkElement
} from '../src/selection-links';

type El = LinkElement & { children?: El[] };

function node(id: string, x: number, y: number, extra: Partial<El> = {}): El {
    return { id, type: WorkflowDiagramTypes.NODE_ACTOR, position: { x, y }, size: { width: 100, height: 40 }, ...extra };
}

/** A root holding `children`, each child knowing its parent, as the client's model does. */
function root(links: unknown, ...children: El[]): El {
    const model: El = { id: 'root', type: WorkflowDiagramTypes.GRAPH, args: { [WorkflowDiagramMetadata.SELECTION_LINKS]: links }, children };
    const adopt = (parent: El): void => {
        for (const child of parent.children ?? []) {
            (child as { parent?: El }).parent = parent;
            adopt(child);
        }
    };
    adopt(model);
    return model;
}

const link = (from: string, to: string, extra: Partial<SelectionLink> = {}): SelectionLink => ({ id: `${from}->${to}`, from, to, ...extra });

/** A link's curve as points along it, from the path the client draws. */
function curveOf(path: string, steps = 48): Array<{ x: number; y: number }> {
    const [x0, y0, x1, y1, x2, y2, x3, y3] = path.match(/-?\d+(\.\d+)?(e-?\d+)?/g)!.map(Number);
    return Array.from({ length: steps + 1 }, (_, i) => {
        const t = i / steps;
        const u = 1 - t;
        return {
            x: u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
            y: u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3
        };
    });
}

/** How many pairs of the drawn links cross each other. */
function crossings(drawn: ReturnType<typeof placeLinks>): number {
    const curves = drawn.map(each => curveOf(linkPath(each)));
    const turn = (a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }): number =>
        Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
    const cross = (p: typeof curves[number], q: typeof curves[number]): boolean => {
        for (let i = 0; i + 1 < p.length; i++) {
            for (let j = 0; j + 1 < q.length; j++) {
                if (turn(p[i], p[i + 1], q[j]) * turn(p[i], p[i + 1], q[j + 1]) < 0
                    && turn(q[j], q[j + 1], p[i]) * turn(q[j], q[j + 1], p[i + 1]) < 0) {
                    return true;
                }
            }
        }
        return false;
    };
    let count = 0;
    for (let a = 0; a < curves.length; a++) {
        for (let b = a + 1; b < curves.length; b++) {
            count += cross(curves[a], curves[b]) ? 1 : 0;
        }
    }
    return count;
}
const box = (x: number, y: number, width = 100, height = 40): Box => ({ x, y, width, height });

/** A drawn node's classes: under `data` in the browser, under `props` where the helper runs without its runtime. */
const classesOf = (vnode: any): Record<string, boolean> => vnode?.data?.class ?? vnode?.props?.class ?? {};

/** Every vnode under `vnode` whose classes include `name`. */
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

describe('the links of a root', () => {
    it('are read from its arguments, a malformed one passed over', () => {
        const model = root([link('a', 'b'), { id: 'x', from: 'a' }, 'nonsense', null], node('a', 0, 0), node('b', 300, 0));
        expect(selectionLinksOf(model).map(l => l.id)).toEqual(['a->b']);
        expect(selectionLinksOf(root(undefined))).toEqual([]);
        expect(selectionLinksOf(root({ not: 'a list' }))).toEqual([]);
    });
});

describe('what a selection brings up', () => {
    const links = [link('var', 'act1'), link('act1', 'port'), link('var', 'act2')];
    const model = (selected: string[]): El => root(links,
        ...['var', 'act1', 'act2', 'port', 'other'].map((id, i) => node(id, i * 200, 0, { selected: selected.includes(id) })));

    it('is nothing when nothing is selected', () => {
        const found = linksOfSelection(model([]));
        expect(found.links).toEqual([]);
        expect(renderSelectionLinks(model([]))).toBeUndefined();
    });

    it('is every link the selected node is an end of, and the nodes at their other ends', () => {
        const found = linksOfSelection(model(['act1']));
        expect(found.links.map(l => l.id)).toEqual(['var->act1', 'act1->port']);
        expect([...found.ends].sort()).toEqual(['port', 'var']);
        // From the other side: a variable brings up everything that uses it.
        const fromVariable = linksOfSelection(model(['var']));
        expect(fromVariable.links.map(l => l.id)).toEqual(['var->act1', 'var->act2']);
        expect([...fromVariable.ends].sort()).toEqual(['act1', 'act2']);
        // A node no link names brings up nothing.
        expect(linksOfSelection(model(['other'])).links).toEqual([]);
    });

    it('takes the selection as ids when it is told them, whatever the elements say', () => {
        const told = linksOfSelection(model(['other']), new Set(['var']));
        expect(told.links.map(l => l.id)).toEqual(['var->act1', 'var->act2']);
        expect(linksOfSelection(model(['var']), new Set()).links).toEqual([]);
    });

    it('does not count a selected node as the other end of its own link', () => {
        const found = linksOfSelection(model(['var', 'act1']));
        expect([...found.ends].sort()).toEqual(['act2', 'port']);
    });

    it('marks the other nodes that draw what the selected node draws', () => {
        const same = { [WorkflowDiagramMetadata.SAME_AS]: 'done' };
        const drawnTwice = root([],
            node('s1.done', 0, 0, { args: same, selected: true }),
            node('s2.done', 300, 0, { args: same }),
            node('s2.other', 300, 100, { args: { [WorkflowDiagramMetadata.SAME_AS]: 'other' } }));
        const found = linksOfSelection(drawnTwice);
        expect([...found.same]).toEqual(['s2.done']);
        // Outlines alone cover no edge: the diagram's edges do not step back.
        const svgNode: any = { sel: 'svg', data: {}, children: [{ sel: 'g', data: {}, children: [] }] };
        const out = withSelectionLinks(svgNode, drawnTwice, 'main') as any;
        expect(out.children[0].children).toHaveLength(1);
        expect(out.data.class?.['selection-links-shown']).toBeUndefined();
        // Drawn even with no link at all: the outline is what there is to show.
        const drawn = renderSelectionLinks(drawnTwice);
        expect(withClass(drawn, 'selection-link-same')).toHaveLength(1);
        expect(withClass(drawn, 'selection-link')).toHaveLength(0);
    });
});

describe('the side a link leaves a node by', () => {
    it('faces the other end: top or bottom when they are above each other, a side when beside', () => {
        expect(linkSide(box(0, 300), box(0, 0))).toBe('top');
        expect(linkSide(box(0, 0), box(0, 300))).toBe('bottom');
        expect(linkSide(box(0, 0), box(600, 0))).toBe('right');
        expect(linkSide(box(600, 0), box(0, 0))).toBe('left');
        // Boxes are wider than tall: a diagonal counts as above.
        expect(linkSide(box(0, 300), box(300, 0))).toBe('top');
    });

    it('is the side across when a neighbour of the node’s frame is in the way', () => {
        const third = box(0, 200);
        const rowsAbove = [box(0, 0), box(0, 100)];
        // The other end is up and to the left: over the rows above, were it not for them.
        expect(linkSide(third, box(-400, -300), rowsAbove)).toBe('left');
        expect(linkSide(third, box(400, -300), rowsAbove)).toBe('right');
        // A neighbour in the same row does not block the way up.
        expect(linkSide(third, box(-400, -300), [box(-150, 200)])).toBe('top');
        // In the way on both: the facing side, as with no neighbour at all.
        expect(linkSide(third, box(-400, -300), [...rowsAbove, box(-150, 200)])).toBe('top');
    });
});

describe('where links start and end', () => {
    it('spreads the links that share a side in the order of where they lead, so none crosses another', () => {
        const boxes: Record<string, Box> = { act: box(200, 400), left: box(0, 0), middle: box(200, 0), right: box(400, 0) };
        // Given out of order on purpose.
        const drawn = placeLinks([link('act', 'right'), link('act', 'left'), link('act', 'middle')], id => boxes[id]);
        const startX = Object.fromEntries(drawn.map(d => [d.link.to, d.from.x]));
        expect(startX.left).toBeLessThan(startX.middle);
        expect(startX.middle).toBeLessThan(startX.right);
        for (const each of drawn) {
            expect(each.fromSide).toBe('top');
            expect(each.from.y).toBe(400);
            expect(each.toSide).toBe('bottom');
            expect(each.to.y).toBe(40);
            // One link at that side: in its middle.
            expect(each.to.x).toBe(boxes[each.link.to].x + 50);
        }
    });

    it('fans out to a row of nodes without crossing, by whichever side it leaves', () => {
        // The variables of a state machine: one row, far above, to the left
        // of the action. Ids out of order on purpose: the order is not theirs.
        const row: Record<string, Box> = { 'v:c': box(-900, 0), 'v:a': box(-700, 0), 'v:d': box(-500, 0), 'v:b': box(-300, 0), 'v:e': box(-100, 0) };
        const act = box(200, 1200);
        const boxes: Record<string, Box> = { act, ...row };
        const links = Object.keys(row).map(id => link('act', id));
        // Nothing in the way: out of its top.
        const free = placeLinks(links, id => boxes[id]);
        expect(new Set(free.map(each => each.fromSide))).toEqual(new Set(['top']));
        expect(crossings(free)).toBe(0);
        // A row of its own frame above it: out of its left side, where every
        // variable is at the same height. They still do not cross.
        const blocked = placeLinks(links, id => boxes[id], id => (id === 'act' ? [box(200, 1100)] : []));
        expect(new Set(blocked.map(each => each.fromSide))).toEqual(new Set(['left']));
        expect(crossings(blocked)).toBe(0);
        // The nearest variable leaves lowest: the fan opens upward and outward.
        const startY = Object.fromEntries(blocked.map(each => [each.link.to, each.from.y]));
        expect(startY['v:e']).toBeLessThan(startY['v:b']);
        expect(startY['v:b']).toBeLessThan(startY['v:c']);
    });

    it('fans out all around a node without crossing', () => {
        const centre = box(0, 0);
        const boxes: Record<string, Box> = { centre };
        for (let k = 0; k < 16; k++) {
            const angle = (2 * Math.PI * k) / 16 + 0.1;
            boxes[`n${(k * 7) % 16}`] = box(Math.round(700 * Math.cos(angle)), Math.round(500 * Math.sin(angle)));
        }
        const drawn = placeLinks(Object.keys(boxes).filter(id => id !== 'centre').map(id => link('centre', id)), id => boxes[id]);
        expect(drawn).toHaveLength(16);
        expect(crossings(drawn)).toBe(0);
    });

    it('runs two links between the same two nodes side by side', () => {
        const pair = [link('var', 'act', { id: 'read' }), link('act', 'var', { id: 'write' })];
        // Above each other; beside each other; and around a corner (out of
        // the action's left side, into the variable's bottom).
        const above = placeLinks(pair, id => (id === 'act' ? box(0, 400) : box(0, 0)));
        const beside = placeLinks(pair, id => (id === 'act' ? box(600, 0) : box(0, 0)));
        const corner = placeLinks(pair, id => (id === 'act' ? box(400, 600) : box(0, 0)), id => (id === 'act' ? [box(400, 500)] : []));
        expect(corner.map(each => [each.fromSide, each.toSide])).toEqual([['bottom', 'left'], ['left', 'bottom']]);
        for (const drawn of [above, beside, corner]) {
            expect(drawn).toHaveLength(2);
            expect(crossings(drawn)).toBe(0);
            // Two places on each side, not one on top of the other.
            expect(drawn[0].from).not.toEqual(drawn[1].to);
            expect(drawn[0].to).not.toEqual(drawn[1].from);
        }
    });

    it('passes over a link whose end is not in the model', () => {
        expect(placeLinks([link('a', 'gone')], id => (id === 'a' ? box(0, 0) : undefined))).toEqual([]);
    });

    it('draws a curve that leaves and arrives straight out of its sides', () => {
        const [drawn] = placeLinks([link('a', 'b')], id => (id === 'a' ? box(0, 0) : box(0, 300)));
        const path = linkPath(drawn);
        // From the middle of a's bottom to the middle of b's top, pulled down and up.
        expect(path.startsWith('M50,40 C50,')).toBe(true);
        expect(path.endsWith(' 50,300')).toBe(true);
    });

    it('puts a link’s word on its curve, not on the straight line between its ends', () => {
        // Out of a's right side, into b's bottom: the curve bows out to the lower right.
        const [bowed] = placeLinks([link('a', 'b')], id => (id === 'a' ? box(0, 300) : box(400, 0)), id => (id === 'a' ? [box(0, 200)] : []));
        expect([bowed.fromSide, bowed.toSide]).toEqual(['right', 'bottom']);
        const middle = linkMiddle(bowed);
        const onCurve = curveOf(linkPath(bowed))[24];
        expect(middle.x).toBeCloseTo(onCurve.x, 6);
        expect(middle.y).toBeCloseTo(onCurve.y, 6);
        // Well off the chord's middle, where the word used to hang in the air.
        const chord = { x: (bowed.from.x + bowed.to.x) / 2, y: (bowed.from.y + bowed.to.y) / 2 };
        expect(Math.hypot(middle.x - chord.x, middle.y - chord.y)).toBeGreaterThan(40);
        // A straight link's middle is the middle of its line.
        const [straight] = placeLinks([link('a', 'b')], id => (id === 'a' ? box(0, 0) : box(0, 300)));
        expect(linkMiddle(straight).x).toBeCloseTo(50, 6);
        expect(linkMiddle(straight).y).toBeCloseTo(170, 6);
        // The ends of the curve are the ends of the link.
        expect(linkPoint(bowed, 0)).toEqual(bowed.from);
        expect(linkPoint(bowed, 1)).toEqual(bowed.to);
    });

    it('moves a word along its curve when another link’s word is already where it would go', () => {
        // Two links out of the action's left side, one around a corner and one
        // straight through: side by side at the node, and still together halfway.
        const boxes: Record<string, Box> = {
            act: box(0, 0), p1: { x: -300, y: -240, width: 60, height: 24 }, p2: { x: -460, y: -120, width: 60, height: 24 }
        };
        const links = [link('act', 'p1', { label: '×1' }), link('act', 'p2', { label: '×1' })];
        const drawn = placeLinks(links, id => boxes[id], id => (id === 'act' ? [box(0, -60)] : []));
        const [first, second] = drawn;
        const apart = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y);
        // The case: their middles are a few pixels apart.
        expect(apart(linkMiddle(first), linkMiddle(second))).toBeLessThan(14);
        const at = placeLabels(drawn);
        // The first keeps the middle; the second moves along its own curve, clear of it.
        expect(at.get(first.link.id)).toEqual(linkMiddle(first));
        expect(apart(at.get(first.link.id)!, at.get(second.link.id)!)).toBeGreaterThanOrEqual(14);
        const onItsCurve = curveOf(linkPath(second), 200).some(point => apart(point, at.get(second.link.id)!) < 1);
        expect(onItsCurve).toBe(true);
        // A link with no word has no place for one; words far apart stay in the middle.
        expect(placeLabels(placeLinks([link('act', 'p1')], id => boxes[id])).size).toBe(0);
        const far = placeLinks([link('act', 'p1', { label: 'a' }), link('p2', 'act', { label: 'b' })], id => boxes[id]);
        expect([...placeLabels(far).values()]).toEqual(far.map(linkMiddle));
    });

    it('draws the word of a link bent by a neighbour on its curve', () => {
        // In a frame, under a row of it: the link leaves by the side, and bows.
        const framed = root([link('act', 'port', { label: '×1' })],
            {
                id: 'frame', type: WorkflowDiagramTypes.NODE_GROUP, position: { x: 0, y: 200 }, size: { width: 100, height: 140 },
                children: [node('row', 0, 0), node('act', 0, 100, { selected: true })]
            },
            node('port', 400, 0));
        const [label] = withClass(renderSelectionLinks(framed), 'selection-link-label');
        const at = label.data?.attrs ?? label.props?.attrs;
        const [bowed] = placeLinks([link('act', 'port')], id => (id === 'act' ? box(0, 300) : box(400, 0)), id => (id === 'act' ? [box(0, 200)] : []));
        expect([bowed.fromSide, bowed.toSide]).toEqual(['right', 'bottom']);
        expect({ x: at.x, y: at.y }).toEqual(linkMiddle(bowed));
        // Not where the straight line between its ends has its middle.
        expect(Math.hypot(at.x - (bowed.from.x + bowed.to.x) / 2, at.y - (bowed.from.y + bowed.to.y) / 2)).toBeGreaterThan(40);
        expect(Object.keys(at).sort()).toEqual(['dominant-baseline', 'text-anchor', 'x', 'y']);
    });

    it('places an element through the elements that hold it, not counting the root', () => {
        const inner = node('inner', 10, 20);
        const model = root([], { id: 'frame', type: WorkflowDiagramTypes.NODE_GROUP, position: { x: 100, y: 200 }, size: { width: 300, height: 300 }, children: [inner] });
        (model as any).position = { x: 999, y: 999 };
        expect(absoluteBox(model.children![0].children![0])).toEqual({ x: 110, y: 220, width: 100, height: 40 });
    });
});

describe('the drawing', () => {
    const model = (): El => root(
        [link('var', 'act', { role: 'read', label: 'reads' }), link('act', 'port', { role: 'token', bidirectional: true })],
        node('var', 0, 0), node('act', 0, 300, { selected: true }), node('port', 600, 300));
    const svgOf = (): any => ({ sel: 'svg', data: { class: { 'sprotty-graph': true } }, children: [{ sel: 'g', data: {}, children: [{ sel: 'g', data: {}, children: [] }] }] });

    it('has a line and an arrowhead per link, its kind as a class, its word, and an outline per other end', () => {
        const drawn = renderSelectionLinks(model());
        expect(withClass(drawn, 'selection-link')).toHaveLength(2);
        expect(withClass(drawn, 'selection-link-read')).toHaveLength(1);
        expect(withClass(drawn, 'selection-link-token')).toHaveLength(1);
        expect(withClass(drawn, 'selection-link-line')).toHaveLength(2);
        // One arrowhead where a link arrives; one more at its start when it runs both ways.
        expect(withClass(drawn, 'selection-link-arrow')).toHaveLength(3);
        const labels = withClass(drawn, 'selection-link-label');
        // The word is at the middle of its link's curve.
        const [reads] = placeLinks([link('var', 'act')], id => (id === 'var' ? box(0, 0) : box(0, 300)));
        const labelAt = labels[0].data?.attrs ?? labels[0].props?.attrs;
        expect({ x: labelAt.x, y: labelAt.y }).toEqual(linkMiddle(reads));
        expect(labels.map(label => label.children?.[0]?.text ?? label.children?.[0] ?? label.text)).toEqual(['reads']);
        // The word is detail: hidden when zoomed out.
        expect(classesOf(labels[0])['zoom-detail']).toBe(true);
        expect(withClass(drawn, 'selection-link-end')).toHaveLength(2);
    });

    it('goes into the group the viewport transforms, after everything else, and says so on the svg', () => {
        const vnode = svgOf();
        const out = withSelectionLinks(vnode, model(), 'main') as any;
        const viewport = out.children[0];
        expect(viewport.children).toHaveLength(2);
        expect(classesOf(viewport.children[1])['selection-links']).toBe(true);
        expect(out.data.class['selection-links-shown']).toBe(true);
        expect(out.data.class['sprotty-graph']).toBe(true);
    });

    it('is left out of the hidden render, and of a diagram with nothing to draw', () => {
        const hidden = withSelectionLinks(svgOf(), model(), 'hidden') as any;
        expect(hidden.children[0].children).toHaveLength(1);
        expect(hidden.data.class['selection-links-shown']).toBeUndefined();
        const nothingSelected = model();
        nothingSelected.children![1].selected = false;
        const plain = withSelectionLinks(svgOf(), nothingSelected, 'main') as any;
        expect(plain.children[0].children).toHaveLength(1);
        expect(plain.data.class['selection-links-shown']).toBeUndefined();
    });
});
