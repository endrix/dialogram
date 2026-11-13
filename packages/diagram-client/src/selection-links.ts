/**
 * Links drawn only while one of their ends is selected.
 *
 * Some relations are too many to draw all at once: every state variable an
 * action reads, every action that takes a token from a port. A producer marks
 * such an edge `meta.onSelection`, and the server hands them over as data on
 * the root (`SELECTION_LINKS`) instead of as edges: they take no part in the
 * layout and are no elements of the model. Here they are drawn, over the
 * diagram, for the selection:
 *
 * - select a node, and every link it is an end of appears, with the node at
 *   its other end outlined;
 * - the other nodes that draw the same thing (`SAME_AS`: an action that has a
 *   box in several states) are outlined too, differently.
 *
 * A link leaves a node by the side that faces the other end: its top or
 * bottom when the two are more above each other than beside, a side
 * otherwise. Where a neighbour in the node's own frame is in the way on that
 * side (the row above, in a frame of rows), it takes the side across instead,
 * so it runs beside the neighbours and not over them. The links that share a
 * side are spread along it in the order of the directions they lead in, as
 * seen from the node, so they fan out and do not cross each other; two links
 * between the same two nodes run side by side.
 *
 * The drawing goes into the root's svg, inside the group the viewport
 * transforms, after everything else: on top, in the diagram's coordinates.
 */
import type { VNode } from 'snabbdom';
import { svg } from '@eclipse-glsp/client';
import { WorkflowDiagramMetadata, type SelectionLink } from '@dialogram/shared';
import { ZOOM_TEXT_CLASSES } from './zoom-detail';

export interface Box { x: number; y: number; width: number; height: number }
interface Point { x: number; y: number }
type Side = 'top' | 'bottom' | 'left' | 'right';

/** What of the model the links need: ids, selection, place, size, arguments. */
export interface LinkElement {
    id: string;
    type?: string;
    selected?: boolean;
    position?: Point;
    size?: { width: number; height: number };
    bounds?: Box;
    args?: Record<string, unknown>;
    parent?: LinkElement;
    children?: readonly LinkElement[];
    /** Where a link meets an element that is not a box (a transition: its label), in the diagram's coordinates. */
    linkAnchor?: Box;
}

/** The links a root carries; nothing for a root with none, or with something else under the key. */
export function selectionLinksOf(root: LinkElement | undefined): SelectionLink[] {
    const raw = root?.args?.[WorkflowDiagramMetadata.SELECTION_LINKS];
    if (!Array.isArray(raw)) {
        return [];
    }
    return raw.filter((link): link is SelectionLink =>
        !!link && typeof link.id === 'string' && typeof link.from === 'string' && typeof link.to === 'string');
}

/** Where an element is in the diagram: its place, taken through the elements that hold it. */
export function absoluteBox(element: LinkElement): Box {
    const anchor = element.linkAnchor;
    if (anchor) {
        return { ...anchor };
    }
    let x = 0;
    let y = 0;
    for (let current: LinkElement | undefined = element; current; current = current.parent) {
        // The root's own place is the viewport's, which the svg applies.
        if (current.parent) {
            x += current.position?.x ?? current.bounds?.x ?? 0;
            y += current.position?.y ?? current.bounds?.y ?? 0;
        }
    }
    return {
        x,
        y,
        width: element.size?.width ?? element.bounds?.width ?? 0,
        height: element.size?.height ?? element.bounds?.height ?? 0
    };
}

/** Whether `other` stands in the way of leaving `box` by `side`: beside it on that side, across its width or height. */
function inTheWay(box: Box, side: Side, other: Box): boolean {
    const overlapsAcross = other.x < box.x + box.width && box.x < other.x + other.width;
    const overlapsDown = other.y < box.y + box.height && box.y < other.y + other.height;
    switch (side) {
        case 'top': return overlapsAcross && other.y + other.height <= box.y;
        case 'bottom': return overlapsAcross && other.y >= box.y + box.height;
        case 'left': return overlapsDown && other.x + other.width <= box.x;
        default: return overlapsDown && other.x >= box.x + box.width;
    }
}

/**
 * The side of `box` a link to `toward` leaves by: the one that faces it, or,
 * when one of `neighbours` (the other nodes of the box's own frame) is in the
 * way there and not on the side across, that one.
 */
export function linkSide(box: Box, toward: Box, neighbours: readonly Box[] = []): Side {
    const dx = (toward.x + toward.width / 2) - (box.x + box.width / 2);
    const dy = (toward.y + toward.height / 2) - (box.y + box.height / 2);
    const upDown: Side = dy >= 0 ? 'bottom' : 'top';
    const sideways: Side = dx >= 0 ? 'right' : 'left';
    // Boxes are wider than tall, so "above each other" starts well before the diagonal.
    const [first, second] = Math.abs(dy) * 1.5 >= Math.abs(dx) ? [upDown, sideways] : [sideways, upDown];
    const blocked = (side: Side): boolean => neighbours.some(other => inTheWay(box, side, other));
    return blocked(first) && !blocked(second) ? second : first;
}

/** The point at `share` (0 to 1) along `side` of `box`. */
function onSide(box: Box, side: Side, share: number): Point {
    switch (side) {
        case 'top': return { x: box.x + box.width * share, y: box.y };
        case 'bottom': return { x: box.x + box.width * share, y: box.y + box.height };
        case 'left': return { x: box.x, y: box.y + box.height * share };
        default: return { x: box.x + box.width, y: box.y + box.height * share };
    }
}

/**
 * Where `other` lies as seen from `box`, as an angle that grows along `side`
 * the way a place on it does (`onSide`: left to right, top to bottom): a
 * turn around the box that starts straight behind the side. Links leaving
 * one side in the order of this angle fan out without crossing.
 */
function bearing(box: Box, side: Side, other: Box): number {
    const dx = (other.x + other.width / 2) - (box.x + box.width / 2);
    const dy = (other.y + other.height / 2) - (box.y + box.height / 2);
    const angle = side === 'left' ? Math.atan2(-dy, dx)
        : side === 'right' ? Math.atan2(-dy, -dx)
            : side === 'top' ? Math.atan2(-dx, dy)
                : Math.atan2(-dx, -dy);
    return angle < 0 ? angle + 2 * Math.PI : angle;
}

/** A place along a side grows the way a turn around the box does on its left and bottom, against it on its top and right. */
const withTheTurn = (side: Side): boolean => side === 'left' || side === 'bottom';

export interface DrawnLink {
    link: SelectionLink;
    from: Point;
    to: Point;
    fromSide: Side;
    toSide: Side;
}

/**
 * Where each link starts and ends. The links that share a side of a node are
 * spread along it in the order of where they lead across that side, so that
 * neighbours leave side by side and none crosses another at the node.
 */
export function placeLinks(
    links: readonly SelectionLink[],
    boxOf: (id: string) => Box | undefined,
    neighboursOf: (id: string) => readonly Box[] = () => []
): DrawnLink[] {
    const sided: Array<{ link: SelectionLink; fromBox: Box; toBox: Box; fromSide: Side; toSide: Side }> = [];
    for (const link of links) {
        const fromBox = boxOf(link.from);
        const toBox = boxOf(link.to);
        if (!fromBox || !toBox) {
            continue;
        }
        sided.push({
            link, fromBox, toBox,
            fromSide: linkSide(fromBox, toBox, neighboursOf(link.from)),
            toSide: linkSide(toBox, fromBox, neighboursOf(link.to))
        });
    }
    // node id + side -> the links at it, each with the direction it leads in.
    interface AtSide { id: string; other: string; bearing: number; reach: number }
    const atSide = new Map<string, { node: string; side: Side; links: AtSide[] }>();
    const note = (node: string, side: Side, box: Box, id: string, other: string, otherBox: Box): void => {
        const key = `${node}\u0000${side}`;
        let entry = atSide.get(key);
        if (!entry) {
            atSide.set(key, entry = { node, side, links: [] });
        }
        const reach = Math.abs((otherBox.x + otherBox.width / 2) - (box.x + box.width / 2))
            + Math.abs((otherBox.y + otherBox.height / 2) - (box.y + box.height / 2));
        entry.links.push({ id, other, bearing: bearing(box, side, otherBox), reach });
    };
    for (const each of sided) {
        note(each.link.from, each.fromSide, each.fromBox, each.link.id, each.link.to, each.toBox);
        note(each.link.to, each.toSide, each.toBox, each.link.id, each.link.from, each.fromBox);
    }
    // Each side sorted once: a link's share of it is its place in that order.
    const shareOf = new Map<string, number>();
    for (const [key, { node, side, links: here }] of atSide) {
        here.sort((a, b) => {
            if (Math.abs(a.bearing - b.bearing) > 1e-9) {
                return a.bearing - b.bearing;
            }
            if (a.other !== b.other) {
                return a.reach - b.reach || a.id.localeCompare(b.id);
            }
            // Two links between the same two nodes: one order around this
            // node, the other way around that one, so they run side by side.
            const turn = (node < a.other ? 1 : -1) * (withTheTurn(side) ? 1 : -1);
            return turn * a.id.localeCompare(b.id);
        });
        here.forEach((entry, index) => shareOf.set(`${key}\u0000${entry.id}`, (index + 1) / (here.length + 1)));
    }
    const share = (node: string, side: Side, id: string): number => shareOf.get(`${node}\u0000${side}\u0000${id}`) ?? 0.5;
    return sided.map(each => ({
        link: each.link,
        from: onSide(each.fromBox, each.fromSide, share(each.link.from, each.fromSide, each.link.id)),
        to: onSide(each.toBox, each.toSide, share(each.link.to, each.toSide, each.link.id)),
        fromSide: each.fromSide,
        toSide: each.toSide
    }));
}

/** The pull of a curve away from a side: straight out of it. */
function outOf(point: Point, side: Side, by: number): Point {
    switch (side) {
        case 'top': return { x: point.x, y: point.y - by };
        case 'bottom': return { x: point.x, y: point.y + by };
        case 'left': return { x: point.x - by, y: point.y };
        default: return { x: point.x + by, y: point.y };
    }
}

/** The two points that pull a link's curve: straight out of its first side, straight into its second. */
function pulls(drawn: DrawnLink): [Point, Point] {
    const reach = Math.max(24, (Math.abs(drawn.to.x - drawn.from.x) + Math.abs(drawn.to.y - drawn.from.y)) / 3);
    return [outOf(drawn.from, drawn.fromSide, reach), outOf(drawn.to, drawn.toSide, reach)];
}

/** The curve of a link: out of its first side, into its second, straight at both. */
export function linkPath(drawn: DrawnLink): string {
    const [c1, c2] = pulls(drawn);
    return `M${drawn.from.x},${drawn.from.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${drawn.to.x},${drawn.to.y}`;
}

/** The point of a link's curve at `t`, from its start (0) to its end (1). */
export function linkPoint(drawn: DrawnLink, t: number): Point {
    const [c1, c2] = pulls(drawn);
    const u = 1 - t;
    const [a, b, c, d] = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
    return {
        x: a * drawn.from.x + b * c1.x + c * c2.x + d * drawn.to.x,
        y: a * drawn.from.y + b * c1.y + c * c2.y + d * drawn.to.y
    };
}

/**
 * The middle of a link's curve: where its word goes. Not the middle of the
 * straight line between its ends, which a curve that leaves by a side and
 * arrives from below runs well clear of.
 */
export function linkMiddle(drawn: DrawnLink): Point {
    return linkPoint(drawn, 0.5);
}

/** Two words nearer than this, centre to centre, read as one. */
const LABEL_CLEARANCE_PX = 14;
/** Where along its curve a word goes: the middle, or failing that a place to either side of it. */
const LABEL_PLACES = [0.5, 0.38, 0.62, 0.26, 0.74];

/**
 * Where the word of each labelled link goes, by link id: the middle of its
 * curve, or, where the word of a link placed before it is already there
 * (two links that leave a node side by side still run together halfway),
 * the first place along the curve that is clear. The middle when none is.
 */
export function placeLabels(drawn: readonly DrawnLink[]): Map<string, Point> {
    const placed: Point[] = [];
    const out = new Map<string, Point>();
    for (const each of drawn) {
        if (!each.link.label) {
            continue;
        }
        const clear = (point: Point): boolean =>
            placed.every(other => Math.hypot(point.x - other.x, point.y - other.y) >= LABEL_CLEARANCE_PX);
        const at = LABEL_PLACES.map(t => linkPoint(each, t)).find(clear) ?? linkMiddle(each);
        placed.push(at);
        out.set(each.link.id, at);
    }
    return out;
}

/** An arrowhead at `at`, pointing into the node through `side`. */
function arrowPath({ x, y }: Point, side: Side): string {
    const [length, half] = [9, 4.5];
    switch (side) {
        case 'top': return `M${x},${y} L${x - half},${y - length} L${x + half},${y - length} Z`;
        case 'bottom': return `M${x},${y} L${x - half},${y + length} L${x + half},${y + length} Z`;
        case 'left': return `M${x},${y} L${x - length},${y - half} L${x - length},${y + half} Z`;
        default: return `M${x},${y} L${x + length},${y - half} L${x + length},${y + half} Z`;
    }
}

/** Every element of the model, by id. */
function indexOf(root: LinkElement): Map<string, LinkElement> {
    const byId = new Map<string, LinkElement>();
    const visit = (element: LinkElement): void => {
        byId.set(element.id, element);
        for (const child of element.children ?? []) {
            visit(child);
        }
    };
    visit(root);
    return byId;
}

export interface LinksOfSelection {
    /** The links to draw. */
    links: SelectionLink[];
    /** The nodes at the other ends: what the selection uses, or is used by. */
    ends: Set<string>;
    /** The other nodes that draw what a selected node draws. */
    same: Set<string>;
}

const NOTHING: LinksOfSelection = { links: [], ends: new Set(), same: new Set() };

/**
 * Whether a model has anything a selection could bring up: a link, or a
 * node that is one drawing of something. Asked on every frame of a pan or a
 * zoom, so it is kept with the model, which is the same object until the
 * server sends another.
 */
const bringsUp = new WeakMap<object, boolean>();
function canBringUp(root: LinkElement): boolean {
    let known = bringsUp.get(root);
    if (known === undefined) {
        const draws = (element: LinkElement): boolean =>
            typeof element.args?.[WorkflowDiagramMetadata.SAME_AS] === 'string' || (element.children ?? []).some(draws);
        known = selectionLinksOf(root).length > 0 || draws(root);
        bringsUp.set(root, known);
    }
    return known;
}

/**
 * What a selection brings up: its links, their other ends, and the other
 * drawings of the same thing. The selection is `selected` when given (the
 * ids a selection listener is told), else the elements marked selected.
 */
export function linksOfSelection(root: LinkElement, selected?: ReadonlySet<string>): LinksOfSelection {
    if (!canBringUp(root)) {
        return NOTHING;
    }
    // One walk: who is selected, and who draws what.
    const chosen = new Set<string>();
    const drawings: Array<{ id: string; thing: string }> = [];
    const visit = (element: LinkElement): void => {
        if (selected ? selected.has(element.id) : element.selected === true) {
            chosen.add(element.id);
        }
        const thing = element.args?.[WorkflowDiagramMetadata.SAME_AS];
        if (typeof thing === 'string') {
            drawings.push({ id: element.id, thing });
        }
        for (const child of element.children ?? []) {
            visit(child);
        }
    };
    visit(root);
    if (chosen.size === 0) {
        return NOTHING;
    }
    const out: LinksOfSelection = { links: [], ends: new Set(), same: new Set() };
    for (const link of selectionLinksOf(root)) {
        if (chosen.has(link.from) || chosen.has(link.to)) {
            out.links.push(link);
            for (const end of [link.from, link.to]) {
                if (!chosen.has(end)) {
                    out.ends.add(end);
                }
            }
        }
    }
    const things = new Set(drawings.filter(drawing => chosen.has(drawing.id)).map(drawing => drawing.thing));
    for (const drawing of drawings) {
        if (things.has(drawing.thing) && !chosen.has(drawing.id)) {
            out.same.add(drawing.id);
        }
    }
    return out;
}

/** The drawing for the selection, and how many links are in it. */
export interface SelectionOverlay {
    vnode: VNode;
    links: number;
}

/** The drawing for the selection: the links, and the outlines of what they lead to; nothing when there is none. */
export function selectionOverlay(root: LinkElement): SelectionOverlay | undefined {
    const { links, ends, same } = linksOfSelection(root);
    if (links.length === 0 && same.size === 0) {
        return undefined;
    }
    const byId = indexOf(root);
    const boxes = new Map<string, Box | undefined>();
    const boxOf = (id: string): Box | undefined => {
        if (!boxes.has(id)) {
            const element = byId.get(id);
            boxes.set(id, element ? absoluteBox(element) : undefined);
        }
        return boxes.get(id);
    };
    const outline = (id: string, cssClass: string): VNode | undefined => {
        const box = boxOf(id);
        return box && svg('rect', {
            class: { 'selection-link-outline': true, [cssClass]: true },
            attrs: { x: box.x - 3, y: box.y - 3, width: box.width + 6, height: box.height + 6, rx: 5, ry: 5 }
        });
    };
    // The other nodes of a node's own frame: what a link should not run over
    // on its way out. Found once a node, however many links end at it.
    const neighbours = new Map<string, Box[]>();
    const neighboursOf = (id: string): Box[] => {
        let found = neighbours.get(id);
        if (!found) {
            const element = byId.get(id);
            const frame = element?.parent;
            found = !element || !frame?.parent
                ? []
                : (frame.children ?? [])
                    .filter(child => child !== element && typeof child.type === 'string' && child.type.startsWith('node'))
                    .map(absoluteBox);
            neighbours.set(id, found);
        }
        return found;
    };
    const drawn = placeLinks(links, boxOf, neighboursOf);
    const labelAt = placeLabels(drawn);
    const vnode = svg('g', { class: { 'selection-links': true } },
        ...[...same].map(id => outline(id, 'selection-link-same')).filter((node): node is VNode => !!node),
        ...[...ends].map(id => outline(id, 'selection-link-end')).filter((node): node is VNode => !!node),
        ...drawn.map(each => svg('g', {
            class: { 'selection-link': true, ...(each.link.role ? { [`selection-link-${each.link.role}`]: true } : {}) }
        },
            svg('path', { class: { 'selection-link-line': true }, attrs: { d: linkPath(each) } }),
            svg('path', { class: { 'selection-link-arrow': true }, attrs: { d: arrowPath(each.to, each.toSide) } }),
            ...(each.link.bidirectional
                ? [svg('path', { class: { 'selection-link-arrow': true }, attrs: { d: arrowPath(each.from, each.fromSide) } })]
                : []),
            ...(each.link.label
                ? [svg('text', {
                    class: { 'selection-link-label': true, [ZOOM_TEXT_CLASSES.detail]: true },
                    attrs: { ...(labelAt.get(each.link.id) ?? linkMiddle(each)), 'text-anchor': 'middle', 'dominant-baseline': 'central' }
                }, each.link.label)]
                : [])
        ))
    );
    return { vnode, links: drawn.length };
}

/** The drawing for the selection, as `selectionOverlay` makes it. */
export function renderSelectionLinks(root: LinkElement): VNode | undefined {
    return selectionOverlay(root)?.vnode;
}

/**
 * `vnode` (the diagram's svg) with the selection's links drawn over the
 * diagram: appended to the group the viewport transforms, so they are in the
 * diagram's coordinates and above everything in it. Only on screen: the
 * hidden render measures the model's own elements.
 */
export function withSelectionLinks(vnode: VNode | undefined, root: LinkElement | undefined, targetKind: string | undefined): VNode | undefined {
    if (!vnode || !root || targetKind !== 'main') {
        return vnode;
    }
    const overlay = selectionOverlay(root);
    if (!overlay) {
        return vnode;
    }
    const viewport = (vnode.children ?? []).find((child): child is VNode => typeof child === 'object' && child.sel === 'g');
    if (viewport) {
        viewport.children = [...(viewport.children ?? []), overlay.vnode];
        // The diagram's own edges step back while links are read; outlines
        // alone (the other drawings of what is selected) cover no edge.
        if (overlay.links > 0) {
            const data = (vnode.data ??= {});
            data.class = { ...(data.class ?? {}), 'selection-links-shown': true };
        }
    }
    return vnode;
}
